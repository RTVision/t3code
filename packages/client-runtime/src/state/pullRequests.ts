import {
  WS_METHODS,
  type PullRequestDetail,
  type PullRequestDiffInput,
  type PullRequestSummary,
  type PullRequestRef,
  type PullRequestRefresh,
  type EnvironmentId,
  type ProjectId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentQueryAtomFamily,
} from "./runtime.ts";
import { PullRequestDiffLoader } from "./pullRequestDiffHttp.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";

export {
  type PullRequestDiffLoadError,
  PullRequestDiffCredentialRejectedError,
  PullRequestDiffLoader,
  pullRequestDiffLoaderLayer,
} from "./pullRequestDiffHttp.ts";

export class EnvironmentHttpConnectionNotReadyError extends Data.TaggedError(
  "EnvironmentHttpConnectionNotReadyError",
)<{ readonly message: string }> {}

export const LINKED_PULL_REQUEST_IDLE_TTL_MS = 5_000;

type PullRequestRefreshScope =
  | { readonly kind?: undefined }
  | { readonly kind: "reference" | "repository"; readonly reference: PullRequestRef }
  | {
      readonly kind: "list";
      readonly projectIds?: ReadonlyArray<ProjectId>;
      readonly host?: string;
    };

function matchesRefresh(scope: PullRequestRefreshScope, event: PullRequestRefresh): boolean {
  if (event.reference === undefined) return true;
  if (scope.kind === undefined) return false;
  const projectIds = event.projectIds ?? [event.reference.projectId];
  if (scope.kind === "list") {
    return (
      event.listings &&
      (scope.host === undefined ||
        event.host === undefined ||
        scope.host.toLowerCase() === event.host) &&
      (scope.projectIds === undefined ||
        scope.projectIds.some((projectId) => projectIds.includes(projectId)))
    );
  }
  return (
    projectIds.includes(scope.reference.projectId) &&
    scope.reference.repository.trim().toLowerCase() ===
      event.reference.repository.trim().toLowerCase() &&
    (scope.kind === "repository" || scope.reference.number === event.reference.number)
  );
}

function createPullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const events = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:pull-requests:refreshes",
    tag: WS_METHODS.pullRequestsSubscribeRefreshes,
  });
  const scoped = Atom.family((key: string) => {
    const { environmentId, input } = JSON.parse(key) as {
      environmentId: EnvironmentId;
      input: PullRequestRefreshScope;
    };
    return Atom.make((get): AsyncResult.AsyncResult<number, unknown> => {
      const result = get(events({ environmentId, input: { scoped: true } }));
      // Numeric revisions are from servers predating scoped refreshes.
      if (AsyncResult.isSuccess(result)) {
        const event =
          typeof result.value === "number"
            ? { revision: result.value, listings: true }
            : result.value;
        if (matchesRefresh(input, event)) {
          const previous = Option.getOrUndefined(get.self());
          return previous !== undefined &&
            AsyncResult.isSuccess(previous) &&
            previous.value === event.revision
            ? previous
            : AsyncResult.success(event.revision);
        }
      }
      return Option.getOrElse(get.self(), () => AsyncResult.initial<number>());
    });
  });
  return (target: {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestRefreshScope;
  }) => scoped(JSON.stringify(target));
}

/** Refresh only the live fields a linked thread renders. */
export function createLinkedPullRequestSummaryAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:linked-summary",
    tag: WS_METHODS.pullRequestsSummary,
    staleTimeMs: 60_000,
    refreshIntervalMs: 60_000,
    idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
    refreshTrigger: ({ environmentId, input }) =>
      refreshes({ environmentId, input: { kind: "reference", reference: input } }),
  });
}

export function pullRequestDetailToVcsStatus(
  detail: PullRequestDetail | PullRequestSummary,
): NonNullable<VcsStatusResult["pr"]> {
  return {
    number: detail.number,
    title: detail.title,
    url: detail.url,
    baseRef: detail.baseBranch,
    headRef: detail.headBranch,
    state: detail.state,
    ...(detail.isDraft === true ? { isDraft: true } : {}),
    updatedAt: detail.updatedAt,
  };
}

/**
 * Every read shells out to the GitHub CLI, so results are reused for a short while and
 * refreshed explicitly. Mutations run serially per environment: `gh` actions on the same
 * pull request are order-sensitive, and the detail view refetches after each one.
 */
export function createPullRequestEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | PullRequestDiffLoader | R, E>,
) {
  const refreshes = createPullRequestRefreshAtomFamily(runtime);
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;
  const activity = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:activity",
    tag: WS_METHODS.pullRequestsActivity,
    staleTimeMs: 15_000,
    refreshTrigger: ({ environmentId, input }) =>
      refreshes({ environmentId, input: { kind: "reference", reference: input } }),
  });
  return {
    refreshes,
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list",
      tag: WS_METHODS.pullRequestsList,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId, input }) =>
        input.cursors === undefined
          ? refreshes({
              environmentId,
              input: {
                kind: "list",
                ...(input.host === undefined ? {} : { host: input.host }),
                ...(input.projectId !== undefined
                  ? { projectIds: [input.projectId] }
                  : input.projectIds !== undefined
                    ? { projectIds: input.projectIds }
                    : {}),
              },
            })
          : undefined,
    }),
    /**
     * The line counts for rows the listing has already handed over. Its own query because the
     * listing is quicker without them — measured over twelve repositories, ~4.0s against ~7.1s —
     * so the rows arrive first and their stats a moment later. Kept longer than the listing:
     * a change request's size only moves when somebody pushes to it.
     */
    listStats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:list-stats",
      tag: WS_METHODS.pullRequestsListStats,
      staleTimeMs: 60_000,
      refreshTrigger: ({ environmentId, input }) =>
        refreshes({
          environmentId,
          input: { kind: "list", projectIds: input.refs.map((ref) => ref.projectId) },
        }),
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:detail",
      tag: WS_METHODS.pullRequestsDetail,
      staleTimeMs: 15_000,
      refreshTrigger: ({ environmentId, input }) =>
        refreshes({ environmentId, input: { kind: "reference", reference: input } }),
    }),
    /** One bounded repository relationship read for the open PR panel, never for list rows. */
    dependencyContext: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:dependency-context",
      tag: WS_METHODS.pullRequestsDependencyContext,
      staleTimeMs: 30_000,
      refreshTrigger: ({ environmentId, input }) =>
        refreshes({ environmentId, input: { kind: "repository", reference: input } }),
    }),
    activity,
    threadComments: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:thread-comments",
      tag: WS_METHODS.pullRequestsThreadComments,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.cursor]),
      },
    }),
    diff: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:diff",
      staleTimeMs: 60_000,
      execute: (input: PullRequestDiffInput) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const loader = yield* PullRequestDiffLoader;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared)) {
            return yield* new EnvironmentHttpConnectionNotReadyError({
              message: "The environment HTTP connection is not ready.",
            });
          }
          return yield* loader.load(prepared.value, input);
        }),
    }),
    diffFileContents: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:diff-file-contents",
      tag: WS_METHODS.pullRequestsDiffFileContents,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.projectId,
            input.repository,
            input.number,
            input.commit ?? null,
            input.changeType,
            input.oldPath,
            input.newPath,
          ]),
      },
    }),
    runAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:run-action",
      tag: WS_METHODS.pullRequestsRunAction,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update",
      tag: WS_METHODS.pullRequestsUpdate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:comment",
      tag: WS_METHODS.pullRequestsComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    updateComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:update-comment",
      tag: WS_METHODS.pullRequestsUpdateComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: ({ environmentId, input: { projectId, repository, number } }, registry) =>
        Effect.sync(() =>
          registry.refresh(activity({ environmentId, input: { projectId, repository, number } })),
        ),
    }),
    submitReview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:submit-review",
      tag: WS_METHODS.pullRequestsSubmitReview,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    replyToThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:reply-to-thread",
      tag: WS_METHODS.pullRequestsReplyToThread,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /**
     * Its own query rather than part of the detail: the people who may be asked are only wanted
     * once somebody opens the reviewer menu, so this atom is read then and not before. Kept fresh
     * for a minute, because who has access to a repository changes far more slowly than the
     * change request it is being read for.
     */
    reviewerCandidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:reviewer-candidates",
      tag: WS_METHODS.pullRequestsReviewerCandidates,
      staleTimeMs: 60_000,
    }),
    requestReviewers: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:request-reviewers",
      tag: WS_METHODS.pullRequestsRequestReviewers,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /** Read when the label menu opens, and kept for a minute, like the reviewer candidates. */
    labelCandidates: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:label-candidates",
      tag: WS_METHODS.pullRequestsLabelCandidates,
      staleTimeMs: 60_000,
    }),
    setLabels: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-labels",
      tag: WS_METHODS.pullRequestsSetLabels,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    setThreadResolution: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-thread-resolution",
      tag: WS_METHODS.pullRequestsSetThreadResolution,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    setReaction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-reaction",
      tag: WS_METHODS.pullRequestsSetReaction,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
    /**
     * Explicit refresh: forget the server's cached answers, then re-run the reads. A separate
     * request rather than a flag on a read, so only a person's refresh spends host requests
     * while every silent re-read shares the cache.
     */
    invalidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:invalidate",
      tag: WS_METHODS.pullRequestsInvalidate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
