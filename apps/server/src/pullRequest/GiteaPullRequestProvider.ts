import * as Effect from "effect/Effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as GiteaPullRequestApi from "./GiteaPullRequestApi.ts";
import { giteaForkCapabilities } from "./GiteaForkCapabilities.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
  type PullRequestProviderFailure,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
} from "./PullRequestProvider.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
  ],
  mergeMethods: ["merge", "squash", "rebase"],
  updateMethods: ["merge", "rebase"],
  search: true,
  // Review summaries have no Gitea reaction route. Conversation rows carry reactions only for
  // target kinds the host supports; the provider must not claim the legacy all-remarks flag.
  reactions: false,
  reactionSubjects: {
    changeRequest: true,
    issueComment: true,
    reviewComment: true,
    review: false,
  },
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  // Inline review comments are issue-comment records in Gitea and share this PATCH route.
  // A review summary is a separate Review record and is not a rewriteable comment in this API.
  edit: { changeRequest: true, comment: true },
  labels: true,
};

export function giteaProviderFailure(
  error: GiteaPullRequestApi.GiteaPullRequestApiError,
): PullRequestProviderFailure {
  return {
    reason:
      error.reason === "unconfigured" || error.reason === "unauthenticated"
        ? "unauthenticated"
        : error.reason,
    ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
  };
}

export function giteaViewerPermissions(input: {
  readonly canWrite: boolean;
  readonly ownsPullRequest: boolean;
  readonly updateMethods: ReadonlyArray<"merge" | "rebase">;
}): PullRequestViewerPermissions {
  return {
    actions: CAPABILITIES.actions.filter((action) => {
      if (action === "ready" || action === "draft" || action === "close" || action === "reopen")
        return input.canWrite || input.ownsPullRequest;
      return input.canWrite;
    }),
    comment: true,
    resolve: input.canWrite || input.ownsPullRequest,
    verdicts: input.ownsPullRequest ? ["comment"] : CAPABILITIES.review.verdicts,
    requestReviewers: input.canWrite,
    updateMethods: input.canWrite ? input.updateMethods : [],
    labels: input.canWrite,
  };
}

export function giteaBaseComparison(
  pullRequest: Pick<GiteaPullRequestApi.GiteaPullRequest, "baseSha" | "mergeBaseSha">,
): "up-to-date" | "behind" | "unknown" {
  if (pullRequest.baseSha === "" || pullRequest.mergeBaseSha === "") return "unknown";
  return pullRequest.baseSha === pullRequest.mergeBaseSha ? "up-to-date" : "behind";
}

function toChangeRequest(pullRequest: GiteaPullRequestApi.GiteaPullRequest): ProviderChangeRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    author: pullRequest.author,
    headBranch: pullRequest.headBranch,
    headRepositoryNameWithOwner: pullRequest.headRepositoryNameWithOwner,
    baseBranch: pullRequest.baseBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    mergeability: pullRequest.mergeability,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    reviewRequestLogins: pullRequest.reviewRequestLogins,
    labels: pullRequest.labels,
  };
}

export const make = Effect.gen(function* () {
  const api = yield* GiteaPullRequestApi.GiteaPullRequestApi;

  const fail = (operation: string) => (error: GiteaPullRequestApi.GiteaPullRequestApiError) =>
    new PullRequestProviderError({
      provider: "gitea",
      operation,
      ...giteaProviderFailure(error),
      detail: error.detail,
      cause: error,
    });

  const permissions = (input: {
    readonly access: GiteaPullRequestApi.GiteaRepositoryAccess;
    readonly viewer: string;
    readonly author: string | undefined;
  }) =>
    giteaViewerPermissions({
      canWrite: input.access.canWrite,
      ownsPullRequest:
        input.author !== undefined && input.author.toLowerCase() === input.viewer.toLowerCase(),
      updateMethods: input.access.updateMethods,
    });

  const provider: PullRequestProviderApi = {
    kind: "gitea",
    capabilities: CAPABILITIES,
    getCapabilities: ({ host }) =>
      api.getFeatures().pipe(
        Effect.map((features) => giteaForkCapabilities(CAPABILITIES, features)),
        Effect.mapError(fail(`getCapabilities:${host}`)),
      ),

    getViewer: () => api.getViewer().pipe(Effect.mapError(fail("getViewer"))),

    listChangeRequests: (input) =>
      api
        .listPullRequests({
          host: input.host,
          repository: input.repository,
          state: input.state,
          involvement: input.involvement,
          viewer: input.viewer,
          limit: input.limit,
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        })
        .pipe(
          Effect.mapError(fail("listChangeRequests")),
          Effect.map((page) => ({
            items: page.items.map(toChangeRequest),
            truncated: page.truncated,
            cursorAdvance: page.consumed,
            continues: true,
          })),
        ),

    getChangeRequest: (input) =>
      Effect.all(
        [
          api.getPullRequest(input),
          api.getRepositoryAccess(input),
          api.getViewer(),
          api.getAutoMergeEnabled(input),
        ],
        { concurrency: 4 },
      ).pipe(
        Effect.flatMap(([pullRequest, access, viewer, autoMergeEnabled]) =>
          api.listChecks({ ...input, sha: pullRequest.headSha }).pipe(
            Effect.orElseSucceed(() => []),
            Effect.map((checks): ProviderChangeRequestDetail => ({
              ...toChangeRequest(pullRequest),
              body: pullRequest.body,
              changedFiles: pullRequest.changedFiles,
              mergedAt: pullRequest.mergedAt,
              closedAt: pullRequest.closedAt,
              reviewers: pullRequest.reviewers,
              checks,
              mergeCapabilities: access.mergeCapabilities,
              baseComparison: giteaBaseComparison(pullRequest),
              ...(autoMergeEnabled === undefined ? {} : { autoMergeEnabled }),
              ...(pullRequest.autoMergeMethod === undefined
                ? {}
                : { autoMergeMethod: pullRequest.autoMergeMethod }),
              viewerPermissions: permissions({
                access,
                viewer,
                author: pullRequest.author?.login,
              }),
            })),
          ),
        ),
        Effect.mapError(fail("getChangeRequest")),
      ),

    getChangeRequestSummary: (input) =>
      api.getPullRequest(input).pipe(
        Effect.mapError(fail("getChangeRequestSummary")),
        Effect.map((pullRequest) => ({
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.url,
          headBranch: pullRequest.headBranch,
          baseBranch: pullRequest.baseBranch,
          state: pullRequest.state,
          isDraft: pullRequest.isDraft,
          updatedAt: pullRequest.updatedAt,
        })),
      ),

    getChangeRequestActivity: (input) =>
      Effect.all(
        [
          api.getPullRequest(input),
          api
            .listComments(input)
            .pipe(Effect.orElseSucceed(() => ({ comments: [], truncated: true }))),
          api
            .listReviews(input)
            .pipe(Effect.orElseSucceed(() => ({ comments: [], threads: [], truncated: true }))),
          api.listCommits(input).pipe(Effect.orElseSucceed(() => [])),
          api.getViewer().pipe(Effect.orElseSucceed(() => "")),
        ],
        { concurrency: 5 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.flatMap(([pullRequest, issueComments, reviews, commits, viewer]) => {
          const reactions =
            viewer === ""
              ? Effect.succeed({ pullRequest: [], bySubjectId: new Map<string, never>() })
              : api
                  .listConversationReactions({
                    ...input,
                    viewer,
                    subjectIds: [...issueComments.comments, ...reviews.comments].map(
                      (comment) => comment.id,
                    ),
                  })
                  .pipe(
                    Effect.orElseSucceed(() => ({
                      pullRequest: [],
                      bySubjectId: new Map<string, never>(),
                    })),
                  );
          return reactions.pipe(
            Effect.map((reactions): ProviderChangeRequestActivity => ({
              author: pullRequest.author,
              reviewers: pullRequest.reviewers,
              comments: [...issueComments.comments, ...reviews.comments]
                .map((comment) => {
                  const remarkReactions = reactions.bySubjectId.get(comment.id);
                  return remarkReactions === undefined
                    ? comment
                    : { ...comment, reactions: remarkReactions };
                })
                .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
              commentCount: Math.max(
                pullRequest.commentCount,
                issueComments.comments.length + reviews.comments.length,
              ),
              commentsTruncated: issueComments.truncated || reviews.truncated,
              reviewThreads: reviews.threads.map((thread) => ({
                ...thread,
                comments: thread.comments.map((comment) => {
                  const remarkReactions = reactions.bySubjectId.get(comment.id);
                  return remarkReactions === undefined
                    ? comment
                    : { ...comment, reactions: remarkReactions };
                }),
              })),
              commits,
              reactions: reactions.pullRequest,
            })),
          );
        }),
      ),

    getViewerPermissions: (input) =>
      Effect.all([api.getPullRequest(input), api.getRepositoryAccess(input), api.getViewer()], {
        concurrency: 3,
      }).pipe(
        Effect.mapError(fail("getViewerPermissions")),
        Effect.map(([pullRequest, access, viewer]) =>
          permissions({ access, viewer, author: pullRequest.author?.login }),
        ),
      ),

    getDiff: (input) =>
      api
        .getDiff({
          host: input.host,
          repository: input.repository,
          number: input.number,
          ...(input.commit === undefined ? {} : { commit: input.commit }),
        })
        .pipe(
          Effect.mapError(fail("getDiff")),
          Effect.map((diff) => ({ ...diff, nextCursor: null })),
        ),

    getDiffFileContents: (input) =>
      api
        .getDiffFileContents({
          host: input.host,
          repository: input.repository,
          number: input.number,
          oldPath: input.oldPath,
          newPath: input.newPath,
          changeType: input.changeType,
          ...(input.commit === undefined ? {} : { commit: input.commit }),
        })
        .pipe(Effect.mapError(fail("getDiffFileContents"))),

    runAction: (input) => api.runAction(input).pipe(Effect.mapError(fail("runAction"))),

    updateChangeRequest: (input) =>
      api
        .updatePullRequest({
          host: input.host,
          repository: input.repository,
          number: input.number,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        })
        .pipe(Effect.mapError(fail("updateChangeRequest"))),

    comment: (input) => api.comment(input).pipe(Effect.mapError(fail("comment"))),

    updateComment: (input) => api.updateComment(input).pipe(Effect.mapError(fail("updateComment"))),

    submitReview: (input) => api.submitReview(input).pipe(Effect.mapError(fail("submitReview"))),

    listReviewerCandidates: (input) =>
      api.listReviewerCandidates(input).pipe(Effect.mapError(fail("listReviewerCandidates"))),

    setReviewerRequest: (input) =>
      api.setReviewerRequest(input).pipe(Effect.mapError(fail("setReviewerRequest"))),

    listLabelCandidates: (input) =>
      api.listLabelCandidates(input).pipe(Effect.mapError(fail("listLabelCandidates"))),

    setLabels: (input) => api.setLabels(input).pipe(Effect.mapError(fail("setLabels"))),

    replyToThread: (input) => api.replyToThread(input).pipe(Effect.mapError(fail("replyToThread"))),

    setThreadResolution: (input) =>
      api.setThreadResolution(input).pipe(Effect.mapError(fail("setThreadResolution"))),

    setReaction: (input) =>
      api
        .setReaction({
          host: input.host,
          repository: input.repository,
          number: input.number,
          content: input.content,
          reacted: input.reacted,
          ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
        })
        .pipe(Effect.mapError(fail("setReaction"))),
  };

  return provider;
});
