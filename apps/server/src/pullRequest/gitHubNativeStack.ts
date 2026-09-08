import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

import type { GitHubCli } from "../sourceControl/GitHubCli.ts";
import {
  PullRequestProviderError,
  type ProviderNativeDependencyMembership,
  type ProviderRepositoryRef,
} from "./PullRequestProvider.ts";

const StackNumber = Schema.Int.check(Schema.isGreaterThan(0));
const decodeList = decodeJsonResult(Schema.Array(Schema.Struct({ number: StackNumber })));
const Repository = Schema.Struct({ url: Schema.String });
const Branch = Schema.Struct({ ref: TrimmedNonEmptyString, repo: Schema.NullOr(Repository) });
const decodeStack = decodeJsonResult(
  Schema.Struct({
    number: StackNumber,
    node_id: TrimmedNonEmptyString,
    pull_requests: Schema.Array(
      Schema.Struct({
        number: StackNumber,
        title: TrimmedNonEmptyString,
        html_url: TrimmedNonEmptyString,
        state: Schema.Literals(["open", "closed"]),
        draft: Schema.Boolean,
        merged_at: Schema.NullOr(Schema.String),
        head: Branch,
        base: Branch,
      }),
    ),
  }),
);

/** The preview embeds repository API URLs, not `full_name`. Never guess from a short name. */
function repositoryIdentity(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== "https://api.github.com") return null;
    return /^\/repos\/([^/]+\/[^/]+)\/?$/u.exec(parsed.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Two bounded REST reads; a failed preview endpoint is unavailable, never an empty stack. */
export const makeGitHubNativeStackRead = (execute: GitHubCli["Service"]["execute"]) =>
  Effect.fn("GitHubNativeStack.read")(function* (
    input: ProviderRepositoryRef & { readonly number: number; readonly limit: number },
  ) {
    const failed = (detail: string, cause?: unknown) =>
      new PullRequestProviderError({
        provider: "github",
        operation: "getNativeDependencyMembership",
        reason: "failed",
        detail,
        cause,
      });
    // GitHub Enterprise versions have not been verified against this public preview.
    if (input.host.toLowerCase() !== "github.com") {
      return yield* failed("Native stack membership is unavailable on this GitHub host.");
    }
    const repository = input.repository.split("/").map(encodeURIComponent).join("/");
    const read = (path: string) =>
      execute({
        cwd: input.cwd,
        args: [
          "api",
          "--hostname",
          input.host,
          "--method",
          "GET",
          "-H",
          "Accept: application/vnd.github+json",
          "-H",
          "X-GitHub-Api-Version: 2026-03-10",
          path,
        ],
        maxOutputBytes: 2 * 1024 * 1024,
      }).pipe(
        Effect.mapError(
          (error) =>
            new PullRequestProviderError({
              provider: "github",
              operation: "getNativeDependencyMembership",
              reason:
                error._tag === "GitHubCliRateLimitError"
                  ? "rate-limited"
                  : error._tag === "GitHubCliAuthenticationError"
                    ? "unauthenticated"
                    : error._tag === "GitHubCliUnavailableError"
                      ? "missing-tool"
                      : "failed",
              detail: error.detail,
              cause: error,
            }),
        ),
        Effect.flatMap((output) =>
          output.stdoutTruncated || output.stdoutInvalidUtf8
            ? Effect.fail(failed("Native stack response exceeded the read limit."))
            : Effect.succeed(output.stdout),
        ),
      );
    // The exact membership filter returns at most one stack; two rows detect a broken answer.
    const listed = decodeList(
      yield* read(`repos/${repository}/stacks?pull_request=${input.number}&per_page=2&page=1`),
    );
    if (Result.isFailure(listed))
      return yield* failed("Unreadable native stack listing.", listed.failure);
    if (listed.success.length === 0)
      return { status: "none" } satisfies ProviderNativeDependencyMembership;
    if (listed.success.length !== 1) return yield* failed("Native stack membership was ambiguous.");
    const stackNumber = listed.success[0]!.number;
    const decoded = decodeStack(yield* read(`repos/${repository}/stacks/${stackNumber}`));
    if (Result.isFailure(decoded))
      return yield* failed("Unreadable native stack members.", decoded.failure);
    const stack = decoded.success;
    if (
      stack.number !== stackNumber ||
      !stack.pull_requests.some((pr) => pr.number === input.number) ||
      new Set(stack.pull_requests.map((pr) => pr.number)).size !== stack.pull_requests.length ||
      stack.pull_requests.some(
        (pr) =>
          repositoryIdentity(pr.base.repo?.url)?.toLowerCase() !== input.repository.toLowerCase(),
      )
    ) {
      return yield* failed(
        "Native stack members did not match the requested repository and pull request.",
      );
    }
    const limit = Math.max(1, Math.min(input.limit, 100));
    // Keep the selected member visible even if it is beyond the display budget.
    const focusIndex = stack.pull_requests.findIndex((pr) => pr.number === input.number);
    const start = Math.max(0, focusIndex - limit + 1);
    return {
      status: "present",
      id: stack.node_id,
      coverage: stack.pull_requests.length > limit ? "partial" : "complete",
      members: stack.pull_requests.slice(start, start + limit).map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        state: pr.merged_at !== null ? "merged" : pr.state,
        isDraft: pr.draft,
        headBranch: pr.head.ref,
        baseBranch: pr.base.ref,
        headRepositoryNameWithOwner: repositoryIdentity(pr.head.repo?.url),
      })),
    } satisfies ProviderNativeDependencyMembership;
  });
