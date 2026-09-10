import { expect, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { actionsCiStatus, makeActionsCi, resolveCheckUrl } from "./ActionsCi.ts";

const ref = { cwd: "/workspace", host: "forge.test", repository: "acme/web", number: 42 };
const runRef = { ...ref, runId: "12", headSha: "head", attempt: 2 };
const run = {
  id: 12,
  head_sha: "head",
  name: "CI",
  html_url: "https://forge.test/acme/web/actions/runs/12",
  status: "completed",
  conclusion: "failure",
  run_attempt: 2,
  pull_requests: [{ number: 42 }],
};
const job = {
  id: 93,
  run_id: 12,
  run_attempt: 2,
  name: "Test",
  html_url: "https://forge.test/acme/web/actions/runs/12/jobs/999",
  status: "completed",
  conclusion: "failure",
};

function fixture(
  options: {
    kind?: "github" | "gitea";
    head?: string;
    mergeHead?: string;
    writable?: boolean;
    currentRun?: { [K in keyof typeof run]?: (typeof run)[K] | undefined };
    currentJob?: Partial<typeof job>;
    runs?: ReadonlyArray<
      Partial<typeof run> & Pick<typeof run, "id" | "head_sha" | "html_url" | "status">
    >;
    jobPages?: ReadonlyArray<ReadonlyArray<typeof job>>;
    writeError?: boolean;
  } = {},
) {
  const requests: Array<{ method: string; path: string }> = [];
  const api = makeActionsCi({
    kind: options.kind ?? "gitea",
    fail: (detail) => new Error(detail),
    request: (input) => {
      requests.push(input);
      if (input.method === "POST")
        return options.writeError
          ? Effect.fail(new Error("HTTP 403"))
          : Effect.succeed({ body: "", truncated: false });
      let data: unknown;
      if (input.path.endsWith("/pulls/42"))
        data = { head: { sha: options.head ?? "head" }, merge_commit_sha: options.mergeHead };
      else if (input.path === "/repos/acme/web")
        data = { permissions: { push: options.writable !== false } };
      else if (input.path.includes("/actions/runs?"))
        data = { total_count: options.runs?.length ?? 1, workflow_runs: options.runs ?? [run] };
      else if (input.path.endsWith("/actions/runs/12")) data = { ...run, ...options.currentRun };
      else if (input.path.includes("/actions/runs/12/jobs?")) {
        const page = Number(new URL(input.path, "https://forge.test").searchParams.get("page"));
        const pages = options.jobPages ?? [[job]];
        data = { total_count: pages.flat().length, jobs: pages[page - 1] ?? [] };
      } else if (input.path.endsWith("/actions/jobs/93")) data = { ...job, ...options.currentJob };
      else return Effect.fail(new Error(`Unexpected request: ${input.path}`));
      return Effect.succeed({ body: JSON.stringify(data), truncated: false });
    },
  });
  return { api, requests, writes: () => requests.filter((r) => r.method === "POST") };
}

describe("Actions CI", () => {
  it.effect("accepts Gitea's missing conclusion on queued runs and jobs", () =>
    Effect.gen(function* () {
      const { conclusion: _runConclusion, ...queuedRun } = { ...run, status: "queued" };
      const { conclusion: _jobConclusion, ...queuedJob } = { ...job, status: "queued" };
      const api = makeActionsCi({
        kind: "gitea",
        fail: (detail) => new Error(detail),
        request: (input) => {
          const body = input.path.endsWith("/pulls/42")
            ? { head: { sha: "head" } }
            : input.path === "/repos/acme/web"
              ? { permissions: { push: true } }
              : input.path.includes("/jobs?")
                ? { total_count: 1, jobs: [queuedJob] }
                : input.path.includes("/runs?")
                  ? { total_count: 1, workflow_runs: [queuedRun] }
                  : queuedRun;
          return Effect.succeed({ body: JSON.stringify(body), truncated: false });
        },
      });
      const runs = yield* api.getCiRuns(ref);
      expect(runs.runs[0]?.status).toBe("pending");
      expect(runs.runs[0]?.rerunModes).toEqual([]);
      const jobs = yield* api.getCiJobs(runRef);
      expect(jobs.jobs[0]?.status).toBe("pending");
      expect(jobs.jobs[0]?.canRerun).toBe(false);
    }),
  );
  it.effect("lists only this PR revision without fetching jobs", () =>
    Effect.gen(function* () {
      const f = fixture({
        runs: [
          run,
          { ...run, id: 13, head_sha: "old" },
          { ...run, id: 14, pull_requests: [{ number: 99 }] },
        ],
      });
      const result = yield* f.api.getCiRuns(ref);
      expect(result.runs.map((r) => r.id)).toEqual(["12"]);
      expect(result.runs[0]?.rerunModes).toEqual(["all", "failed"]);
      expect(f.requests.some((r) => r.path.includes("/jobs"))).toBe(false);
    }),
  );

  it.effect(
    "includes merge-revision workflows only when the host associates them with this PR",
    () =>
      Effect.gen(function* () {
        const f = fixture({
          kind: "github",
          mergeHead: "merge",
          runs: [
            run,
            { ...run, id: 13, head_sha: "merge" },
            { ...run, id: 14, head_sha: "merge", pull_requests: [] },
          ],
        });
        expect((yield* f.api.getCiRuns(ref)).runs.map((entry) => entry.id)).toEqual(["13", "12"]);
        yield* f.api.rerunCi({ ...runRef, target: { kind: "all" } });
        expect(
          f.requests
            .filter((entry) => entry.path.includes("/actions/runs?"))
            .map((entry) => entry.path),
        ).toContain("/repos/acme/web/actions/runs?head_sha=merge&per_page=50&limit=50");
      }),
  );

  for (const attempt of [undefined, 0]) {
    it.effect(`reruns jobs on legacy Gitea runs with attempt ${attempt}`, () =>
      Effect.gen(function* () {
        const legacyRun = {
          id: run.id,
          head_sha: run.head_sha,
          html_url: run.html_url,
          status: "completed",
          conclusion: "failure",
          ...(attempt === undefined ? {} : { run_attempt: attempt }),
        };
        const f = fixture({
          kind: "gitea",
          runs: [legacyRun],
          currentRun: {
            ...legacyRun,
            run_attempt: attempt,
            name: undefined,
            pull_requests: undefined,
          },
          currentJob: { run_attempt: 3 },
        });
        const result = yield* f.api.getCiRuns(ref);
        expect(result.runs[0]).toMatchObject({ id: "12", name: "Run 12", attempt: 0 });
        yield* f.api.rerunCi({ ...runRef, attempt: 0, target: { kind: "job", jobId: "93" } });
        expect(f.writes()[0]?.path).toBe("/repos/acme/web/actions/runs/12/jobs/93/rerun");
      }),
    );
  }

  it.effect("uses capped job pages and API IDs instead of job URL numbers", () =>
    Effect.gen(function* () {
      const f = fixture({ jobPages: [[job], [{ ...job, id: 94 }]] });
      const result = yield* f.api.getCiJobs(runRef);
      expect(result.jobs.map((j) => j.id)).toEqual(["93", "94"]);
      expect(result.truncated).toBe(false);
    }),
  );

  it.effect("does not offer reruns for jobs left over from older attempts", () =>
    Effect.gen(function* () {
      const f = fixture({ jobPages: [[job, { ...job, id: 94, run_attempt: 1 }]] });
      expect((yield* f.api.getCiJobs(runRef)).jobs.map((entry) => entry.canRerun)).toEqual([
        true,
        false,
      ]);
    }),
  );

  for (const kind of ["github", "gitea"] as const) {
    it.effect(`${kind} reruns a native job through its own route`, () =>
      Effect.gen(function* () {
        const f = fixture({ kind });
        yield* f.api.rerunCi({ ...runRef, target: { kind: "job", jobId: "93" } });
        expect(f.writes()).toHaveLength(1);
        expect(f.writes()[0]?.path).toBe(
          kind === "github"
            ? "/repos/acme/web/actions/jobs/93/rerun"
            : "/repos/acme/web/actions/runs/12/jobs/93/rerun",
        );
      }),
    );
  }

  for (const target of ["all", "failed"] as const) {
    it.effect(`reruns ${target} jobs and accepts an empty success body`, () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.api.rerunCi({ ...runRef, target: { kind: target } });
        expect(f.writes()[0]?.path).toBe(
          `/repos/acme/web/actions/runs/12/${target === "all" ? "rerun" : "rerun-failed-jobs"}`,
        );
      }),
    );
  }

  for (const [name, options] of [
    ["changed PR head", { head: "new-head" }],
    ["newer run attempt", { currentRun: { run_attempt: 3 } }],
    ["unrelated run", { currentRun: { head_sha: "different" } }],
    ["running workflow", { currentRun: { status: "in_progress" } }],
    ["read-only viewer", { writable: false }],
    ["job from another run", { currentJob: { run_id: 13 } }],
    ["job from an old attempt", { currentJob: { run_attempt: 1 } }],
  ] as const) {
    it.effect(`refuses ${name} before writing`, () =>
      Effect.gen(function* () {
        const f = fixture(options);
        yield* f.api.rerunCi({ ...runRef, target: { kind: "job", jobId: "93" } }).pipe(Effect.flip);
        expect(f.writes()).toEqual([]);
      }),
    );
  }

  it.effect("does not offer mutations to a read-only viewer and preserves write failures", () =>
    Effect.gen(function* () {
      const reader = fixture({ writable: false });
      expect((yield* reader.api.getCiRuns(ref)).runs[0]?.rerunModes).toEqual([]);
      expect((yield* reader.api.getCiJobs(runRef)).jobs[0]?.canRerun).toBe(false);
      const writer = fixture({ writeError: true });
      const error = yield* writer.api
        .rerunCi({ ...runRef, target: { kind: "all" } })
        .pipe(Effect.flip);
      expect(error.message).toBe("HTTP 403");
      expect(writer.writes()).toHaveLength(1);
    }),
  );
});

it("resolves relative check links against the forge including proxy subpaths", () => {
  expect(resolveCheckUrl("/gitea/acme/web/actions/runs/1", "https://forge.test/gitea")).toBe(
    "https://forge.test/gitea/acme/web/actions/runs/1",
  );
  expect(resolveCheckUrl("acme/web/actions/runs/1", "http://forge.test/gitea")).toBe(
    "http://forge.test/gitea/acme/web/actions/runs/1",
  );
  expect(resolveCheckUrl("https://ci.test/job/1", "https://forge.test/gitea")).toBe(
    "https://ci.test/job/1",
  );
  expect(resolveCheckUrl("javascript:alert(1)", "https://forge.test")).toBeNull();
});

it("distinguishes active, failed, cancelled, skipped, and approval states", () => {
  expect(actionsCiStatus("in_progress", null)).toBe("pending");
  expect(actionsCiStatus("completed", "timed_out")).toBe("failure");
  expect(actionsCiStatus("completed", "cancelled")).toBe("cancelled");
  expect(actionsCiStatus("completed", "skipped")).toBe("skipped");
  expect(actionsCiStatus("completed", "action_required")).toBe("action-required");
});
