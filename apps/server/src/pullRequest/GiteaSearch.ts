import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  PositiveInt,
  type PullRequestInvolvement,
  type PullRequestListState,
} from "@t3tools/contracts";

/**
 * The repository issue search returns issue summaries. Pull request branches and the full state
 * live behind the pull endpoint, so the caller hydrates each number before exposing a row.
 */
export const GiteaSearchIssue = Schema.Struct({ number: PositiveInt });
export type GiteaSearchIssue = typeof GiteaSearchIssue.Type;

export const decodeGiteaSearchIssue = Schema.decodeUnknownOption(GiteaSearchIssue);

function endpointState(state: PullRequestListState): "open" | "closed" | "all" {
  return state === "open" ? "open" : state === "all" ? "all" : "closed";
}

/**
 * Gitea orders issue search by creation time. The service cursor is therefore carried as the
 * delivered raw-row offset, just like the ordinary pull listing; an updated-time boundary would
 * be unsafe for this endpoint's order.
 */
export function giteaSearchPath(input: {
  readonly repositoryPath: string;
  readonly query: string;
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
  readonly page: number;
  readonly limit: number;
}): string {
  const search = new URLSearchParams({
    type: "pulls",
    q: input.query,
    state: endpointState(input.state),
    page: String(input.page),
    limit: String(input.limit),
    ...(input.involvement === "authored" ? { created_by: input.viewer } : {}),
  });
  return `${input.repositoryPath}/issues?${search}`;
}

export function giteaSearchIssueNumber(value: unknown): number | null {
  const decoded = decodeGiteaSearchIssue(value);
  return Option.isSome(decoded) ? decoded.value.number : null;
}
