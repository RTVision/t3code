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
import * as HashMap from "effect/HashMap";
import * as Stream from "effect/Stream";
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

/** @public Required to name the error in consumers' inferred pull request results. */
export class EnvironmentHttpConnectionNotReadyError extends Data.TaggedError(
  "EnvironmentHttpConnectionNotReadyError",
)<{ readonly message: string }> {}

const LINKED_PULL_REQUEST_IDLE_TTL_MS = 5_000;

type PullRequestRefreshScope =
  | { readonly kind?: undefined }
  | { readonly kind: "reference" | "repository"; readonly reference: PullRequestRef }
  | {
      readonly kind: "list";
      readonly projectIds?: ReadonlyArray<ProjectId>;
      readonly host?: string;
    };

const emptyRefreshRevisions = (global = 0) => ({
  global,
  references: HashMap.empty<string, number>(),
  repositories: HashMap.empty<string, number>(),
  listings: HashMap.empty<ProjectId, { revision: number; host: string | undefined }>(),
});
type RefreshRevisions = ReturnType<typeof emptyRefreshRevisions>;

const repositoryRefreshKey = (reference: PullRequestRef, projectId = reference.projectId) =>
  JSON.stringify([
    reference.host?.toLowerCase() ?? projectId,
    reference.repository.trim().toLowerCase(),
  ]);
const referenceRefreshKey = (reference: PullRequestRef, projectId = reference.projectId) =>
  JSON.stringify([
    reference.host?.toLowerCase() ?? projectId,
    reference.repository.trim().toLowerCase(),
    reference.number,
  ]);

/** Accumulate before the atom keeps only the last value of a stream chunk. */
function accumulateRefresh(
  previous: RefreshRevisions,
  value: number | PullRequestRefresh,
): RefreshRevisions {
  // Numeric revisions are from servers predating scoped refreshes.
  const event: PullRequestRefresh =
    typeof value === "number" ? { revision: value, listings: true } : value;
  if (event.reference === undefined) return emptyRefreshRevisions(event.revision);
  let { references, repositories, listings } = previous;
  const hosted = { ...event.reference, host: event.host ?? event.reference.host };
  references = HashMap.set(references, referenceRefreshKey(hosted), event.revision);
  repositories = HashMap.set(repositories, repositoryRefreshKey(hosted), event.revision);
  for (const projectId of event.projectIds ?? [event.reference.projectId]) {
    const legacy = { ...event.reference, host: undefined };
    references = HashMap.set(references, referenceRefreshKey(legacy, projectId), event.revision);
    repositories = HashMap.set(
      repositories,
      repositoryRefreshKey(legacy, projectId),
      event.revision,
    );
    if (event.listings) {
      listings = HashMap.set(listings, projectId, { revision: event.revision, host: event.host });
    }
  }
  // A long-lived connection must not retain every PR ever visited. Eviction refreshes all
  // scopes once so a forgotten revision cannot leave an already mounted query stale.
  if (
    HashMap.size(references) > 2_048 ||
    HashMap.size(repositories) > 2_048 ||
    HashMap.size(listings) > 2_048
  ) {
    return emptyRefreshRevisions(event.revision);
  }
  return { global: previous.global, references, repositories, listings };
}

function refreshRevision(scope: PullRequestRefreshScope, revisions: RefreshRevisions): number {
  if (scope.kind === undefined) return revisions.global;
  if (scope.kind === "list") {
    let revision = revisions.global;
    for (const [projectId, listing] of revisions.listings) {
      if (
        (scope.projectIds === undefined || scope.projectIds.includes(projectId)) &&
        (scope.host === undefined ||
          listing.host === undefined ||
          scope.host.toLowerCase() === listing.host)
      ) {
        revision = Math.max(revision, listing.revision);
      }
    }
    return revision;
  }
  const revision =
    scope.kind === "reference"
      ? HashMap.get(revisions.references, referenceRefreshKey(scope.reference))
      : HashMap.get(revisions.repositories, repositoryRefreshKey(scope.reference));
  return Math.max(
    revisions.global,
    Option.getOrElse(revision, () => 0),
  );
}

function createPullRequestRefreshAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const events = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:pull-requests:refreshes",
    tag: WS_METHODS.pullRequestsSubscribeRefreshes,
    transform: (stream) => stream.pipe(Stream.scan(emptyRefreshRevisions(), accumulateRefresh)),
  });
  const scoped = Atom.family((key: string) => {
    const { environmentId, input } = JSON.parse(key) as {
      environmentId: EnvironmentId;
      input: PullRequestRefreshScope;
    };
    return Atom.make<AsyncResult.AsyncResult<number, unknown>>((get) => {
      const result = get(events({ environmentId, input: { scoped: true } }));
      const previous = Option.getOrUndefined(get.self<AsyncResult.AsyncResult<number, unknown>>());
      if (AsyncResult.isSuccess(result)) {
        const revision = refreshRevision(input, result.value);
        if (revision > 0) {
          return previous !== undefined &&
            AsyncResult.isSuccess(previous) &&
            previous.value === revision
            ? previous
            : AsyncResult.success(revision);
        }
      }
      return previous ?? AsyncResult.initial<number>();
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

/** The host-native stack a pull request belongs to; null where it is not stacked. */
export function createPullRequestStackAtomFamily<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  refreshes = createPullRequestRefreshAtomFamily(runtime),
) {
  return createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:stack",
    tag: WS_METHODS.pullRequestsStack,
    staleTimeMs: 60_000,
    idleTtlMs: LINKED_PULL_REQUEST_IDLE_TTL_MS,
    refreshTrigger: ({ environmentId, input }) =>
      refreshes({ environmentId, input: { kind: "repository", reference: input } }),
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
 * Reopening a PR within a minute reuses detail and activity. Explicit refreshes and
 * turn notifications still revalidate. Mutations run serially per environment: actions on the same
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
    staleTimeMs: 60_000,
    refreshTrigger: ({ environmentId, input }) =>
      refreshes({ environmentId, input: { kind: "reference", reference: input } }),
  });
  return {
    refreshes,
    linkedThreads: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:linked-threads",
      tag: WS_METHODS.pullRequestsLinkedThreads,
      staleTimeMs: 0,
      refreshIntervalMs: 10_000,
      refreshTrigger: ({ environmentId, input }) =>
        refreshes({ environmentId, input: { kind: "repository", reference: input } }),
    }),
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
      staleTimeMs: 60_000,
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
    viewedFiles: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:viewed-files",
      tag: WS_METHODS.pullRequestsViewedFiles,
      staleTimeMs: 15_000,
      refreshTrigger: ({ environmentId, input }) =>
        refreshes({ environmentId, input: { kind: "reference", reference: input } }),
    }),
    setFileViewed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pull-requests:set-file-viewed",
      tag: WS_METHODS.pullRequestsSetFileViewed,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
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
            input.host?.toLowerCase() ?? null,
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
      onSuccess: ({ environmentId, input: { projectId, host, repository, number } }, registry) =>
        Effect.sync(() =>
          registry.refresh(
            activity({
              environmentId,
              input: { projectId, ...(host === undefined ? {} : { host }), repository, number },
            }),
          ),
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
