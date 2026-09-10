import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  PositiveInt,
  type PullRequestCheckStatus,
  type PullRequestCiRun,
  type PullRequestCiRunInput,
} from "@t3tools/contracts";

import type { ProviderRepositoryRef, ProviderCiApi } from "./PullRequestProvider.ts";

type PullRef = ProviderRepositoryRef & { readonly number: number };
type RunRef = PullRef & Omit<PullRequestCiRunInput, "projectId">;

const Pull = Schema.Struct({
  head: Schema.Struct({ sha: Schema.String }),
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
});
const Repository = Schema.Struct({
  permissions: Schema.optional(
    Schema.Struct({
      push: Schema.optional(Schema.Boolean),
      admin: Schema.optional(Schema.Boolean),
    }),
  ),
});
const Run = Schema.Struct({
  id: PositiveInt,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.optional(Schema.String),
  display_title: Schema.optional(Schema.String),
  head_sha: Schema.String,
  pull_requests: Schema.optional(Schema.Array(Schema.Struct({ number: PositiveInt }))),
  html_url: Schema.String,
  status: Schema.String,
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
  run_attempt: Schema.optional(NonNegativeInt),
});
const Runs = Schema.Struct({ total_count: NonNegativeInt, workflow_runs: Schema.Array(Run) });
const Job = Schema.Struct({
  id: PositiveInt,
  run_id: PositiveInt,
  run_attempt: Schema.optional(NonNegativeInt),
  name: Schema.String,
  html_url: Schema.String,
  status: Schema.String,
  conclusion: Schema.optional(Schema.NullOr(Schema.String)),
});
const Jobs = Schema.Struct({ total_count: NonNegativeInt, jobs: Schema.Array(Job) });

export function actionsCiStatus(
  status: string,
  conclusion: string | null | undefined,
): PullRequestCheckStatus {
  if (status === "action_required" || conclusion === "action_required") return "action-required";
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failure";
    case "cancelled":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return "neutral";
  }
}

export function resolveCheckUrl(raw: string | null | undefined, baseUrl: string): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim(), `${baseUrl.replace(/\/+$/, "")}/`);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** GitHub and Gitea expose the same Actions read format, with different job rerun routes. */
export function makeActionsCi<E>(options: {
  readonly request: (
    input: ProviderRepositoryRef & {
      readonly method: "GET" | "POST";
      readonly path: string;
    },
  ) => Effect.Effect<{ readonly body: string; readonly truncated: boolean }, E>;
  readonly fail: (detail: string) => E;
  readonly kind: "github" | "gitea";
  readonly baseUrl?: string;
}): ProviderCiApi<E> {
  const fail = (detail: string) => Effect.fail(options.fail(detail));
  const repoPath = (input: PullRef) =>
    `/repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`;
  const read = <A>(input: PullRef, path: string, schema: Schema.Codec<A>) =>
    options
      .request({ ...input, path, method: "GET" })
      .pipe(
        Effect.flatMap((response) =>
          response.truncated
            ? fail("The CI response was too large.")
            : Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.body).pipe(
                Effect.mapError(() => options.fail("The host returned invalid CI data.")),
              ),
        ),
      );
  const pull = (input: PullRef) => read(input, `${repoPath(input)}/pulls/${input.number}`, Pull);
  const canWrite = (input: PullRef) =>
    read(input, repoPath(input), Repository).pipe(
      Effect.map((repo) => repo.permissions?.push === true || repo.permissions?.admin === true),
    );
  const matches = (run: typeof Run.Type, pr: typeof Pull.Type, number: number) => {
    const related = run.pull_requests ?? [];
    if (related.length > 0 && !related.some((entry) => entry.number === number)) return false;
    return (
      run.head_sha === pr.head.sha ||
      (related.some((entry) => entry.number === number) && run.head_sha === pr.merge_commit_sha)
    );
  };
  const modes = (run: typeof Run.Type, writable: boolean): PullRequestCiRun["rerunModes"] =>
    !writable || run.status !== "completed" || run.conclusion === "action_required"
      ? []
      : run.conclusion === "failure" ||
          run.conclusion === "cancelled" ||
          run.conclusion === "timed_out"
        ? ["all", "failed"]
        : ["all"];
  const jobMatchesRun = (job: typeof Job.Type, run: typeof Run.Type) =>
    job.run_id === run.id &&
    // Legacy Gitea runs have no attempt counter; their jobs count attempts separately.
    ((run.run_attempt ?? 0) === 0 ||
      job.run_attempt === undefined ||
      job.run_attempt === run.run_attempt);
  const currentRun = Effect.fn("ActionsCi.currentRun")(function* (input: RunRef) {
    if (!/^[1-9]\d*$/.test(input.runId)) return yield* fail("Invalid CI run ID.");
    const pr = yield* pull(input);
    if (pr.head.sha !== input.headSha)
      return yield* fail("The pull request changed. Refresh CI runs and try again.");
    const run = yield* read(input, `${repoPath(input)}/actions/runs/${input.runId}`, Run);
    if (String(run.id) !== input.runId || !matches(run, pr, input.number))
      return yield* fail("This CI run does not belong to the current pull request revision.");
    if ((run.run_attempt ?? 0) !== input.attempt)
      return yield* fail("This CI run has a newer attempt. Refresh CI runs and try again.");
    return run;
  });
  const getCiRuns: ProviderCiApi<E>["getCiRuns"] = Effect.fn("ActionsCi.getCiRuns")(
    function* (input) {
      const pr = yield* pull(input);
      const writable = yield* canWrite(input);
      const shas = [
        ...new Set([pr.head.sha, pr.merge_commit_sha].filter((sha): sha is string => Boolean(sha))),
      ];
      const pages = yield* Effect.all(
        shas.map((sha) =>
          read(
            input,
            `${repoPath(input)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50&limit=50`,
            Runs,
          ),
        ),
        { concurrency: 2 },
      );
      const runs = new Map<number, typeof Run.Type>();
      for (const page of pages)
        for (const run of page.workflow_runs)
          if (matches(run, pr, input.number)) runs.set(run.id, run);
      return {
        headSha: pr.head.sha,
        truncated: pages.some((page) => page.total_count > page.workflow_runs.length),
        runs: [...runs.values()]
          .sort((a, b) => b.id - a.id)
          .map((run) => ({
            id: String(run.id),
            name:
              run.name?.trim() || run.path?.split("@")[0] || run.display_title || `Run ${run.id}`,
            url: resolveCheckUrl(run.html_url, options.baseUrl ?? `https://${input.host}`),
            status: actionsCiStatus(run.status, run.conclusion),
            attempt: run.run_attempt ?? 0,
            rerunModes: modes(run, writable),
          })),
      };
    },
  );
  const getCiJobs: ProviderCiApi<E>["getCiJobs"] = Effect.fn("ActionsCi.getCiJobs")(
    function* (input) {
      const run = yield* currentRun(input);
      const writable = yield* canWrite(input);
      const jobs: Array<typeof Job.Type> = [];
      let total = 0;
      for (let page = 1; page <= 10; page += 1) {
        const result = yield* read(
          input,
          `${repoPath(input)}/actions/runs/${input.runId}/jobs?filter=latest&per_page=50&limit=50&page=${page}`,
          Jobs,
        );
        total = result.total_count;
        jobs.push(...result.jobs);
        if (jobs.length >= total || result.jobs.length === 0) break;
      }
      return {
        truncated: total > jobs.length,
        jobs: jobs.map((job) => ({
          id: String(job.id),
          name: job.name,
          url: resolveCheckUrl(job.html_url, options.baseUrl ?? `https://${input.host}`),
          status: actionsCiStatus(job.status, job.conclusion),
          canRerun:
            modes(run, writable).length > 0 &&
            job.status === "completed" &&
            jobMatchesRun(job, run),
        })),
      };
    },
  );
  const rerunCi: ProviderCiApi<E>["rerunCi"] = Effect.fn("ActionsCi.rerunCi")(function* (input) {
    const run = yield* currentRun(input);
    const writable = yield* canWrite(input);
    const available = modes(run, writable);
    if (available.length === 0)
      return yield* fail("Rerunning CI requires write access and a completed run.");
    const root = `${repoPath(input)}/actions`;
    let path: string;
    if (input.target.kind === "job") {
      if (!/^[1-9]\d*$/.test(input.target.jobId)) return yield* fail("Invalid CI job ID.");
      const job = yield* read(input, `${root}/jobs/${input.target.jobId}`, Job);
      if (
        String(job.id) !== input.target.jobId ||
        job.status !== "completed" ||
        !jobMatchesRun(job, run)
      )
        return yield* fail("This job is not a completed job in the selected CI attempt.");
      path =
        options.kind === "github"
          ? `${root}/jobs/${job.id}/rerun`
          : `${root}/runs/${run.id}/jobs/${job.id}/rerun`;
    } else {
      if (!available.includes(input.target.kind))
        return yield* fail("This run has no failed jobs to rerun.");
      path = `${root}/runs/${run.id}/${input.target.kind === "all" ? "rerun" : "rerun-failed-jobs"}`;
    }
    yield* options.request({ ...input, path, method: "POST" });
  });
  return { getCiRuns, getCiJobs, rerunCi };
}
