import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt } from "@t3tools/contracts";

import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import { giteaRepositoryPath, parseGiteaRepository } from "../sourceControl/giteaRepository.ts";

const WorkflowRun = Schema.Struct({
  id: PositiveInt,
  needs_approval: Schema.Boolean,
  pull_request_head_sha: Schema.optional(Schema.String),
  head_sha: Schema.String,
  event: Schema.String,
  display_title: Schema.optional(Schema.String),
  html_url: Schema.String,
  pull_requests: Schema.Array(Schema.Struct({ number: PositiveInt })),
});
const WorkflowPage = Schema.Struct({
  total_count: NonNegativeInt,
  workflow_runs: Schema.Array(WorkflowRun),
});
export type GiteaWorkflowRun = typeof WorkflowRun.Type;

export function isCurrentPullWorkflow(
  run: GiteaWorkflowRun,
  input: { readonly number: number; readonly headSha: string },
): boolean {
  return (
    run.needs_approval &&
    run.event === "pull_request" &&
    run.pull_request_head_sha === input.headSha &&
    input.headSha !== "" &&
    run.pull_requests.some((pull) => pull.number === input.number)
  );
}

export const list = Effect.fn("GiteaWorkflows.list")(function* (
  api: GiteaApi.GiteaApi["Service"],
  input: { readonly repository: string; readonly number: number; readonly headSha: string },
) {
  const operation = "listWorkflowApprovals";
  const repository = parseGiteaRepository(input.repository);
  if (repository === null) {
    return yield* new GiteaApi.GiteaApiError({
      operation,
      reason: "failed",
      detail: "Invalid Gitea repository.",
    });
  }
  const runs: GiteaWorkflowRun[] = [];
  let seen = 0;
  for (let page = 1; page <= 100; page += 1) {
    const response = yield* api.request({
      operation,
      method: "GET",
      path: `${giteaRepositoryPath(repository)}/actions/runs?event=pull_request&page=${page}&limit=50`,
    });
    const result = yield* GiteaApi.decodeGiteaResponse(operation, WorkflowPage, response);
    seen += result.workflow_runs.length;
    runs.push(...result.workflow_runs.filter((run) => isCurrentPullWorkflow(run, input)));
    if (seen >= result.total_count) return runs;
    if (result.workflow_runs.length === 0) break;
  }
  return yield* new GiteaApi.GiteaApiError({
    operation,
    reason: "failed",
    detail: "Gitea's workflow listing could not be read completely.",
  });
});
