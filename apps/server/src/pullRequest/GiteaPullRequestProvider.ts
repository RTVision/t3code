import * as Effect from "effect/Effect";
import type { PullRequestCapabilities, PullRequestViewerPermissions } from "@t3tools/contracts";

import * as GiteaPullRequestApi from "./GiteaPullRequestApi.ts";
import {
  PullRequestProviderError,
  type PullRequestProviderApi,
  type PullRequestProviderFailure,
  type ProviderChangeRequest,
  type ProviderChangeRequestActivity,
  type ProviderChangeRequestDetail,
} from "./PullRequestProvider.ts";

const CAPABILITIES: PullRequestCapabilities = {
  diff: false,
  comment: false,
  actions: [],
  mergeMethods: [],
  // Gitea's repository pull listing has no text parameter. Returning an unfiltered page keeps
  // narrowing correct at the service boundary without claiming host-side search.
  search: false,
  // Issue reactions exist, but review-comment reactions do not have a corresponding route in
  // the target API. The one capability covers every displayed remark, so partial support stays off.
  reactions: false,
  review: {
    inlineComment: false,
    reply: false,
    resolve: false,
    verdicts: [],
  },
  reviewers: { request: false, listCandidates: false },
  // Gitea can edit the pull request and ordinary issue comments. It has no edit route for a
  // review comment, and this capability applies to every conversation remark.
  edit: { changeRequest: false, comment: false },
  labels: false,
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
      if (action === "close" || action === "reopen") return input.canWrite || input.ownsPullRequest;
      return input.canWrite;
    }),
    comment: true,
    resolve: input.canWrite,
    verdicts: CAPABILITIES.review.verdicts,
    requestReviewers: input.canWrite,
    updateMethods: input.canWrite ? input.updateMethods : [],
    labels: input.canWrite,
  };
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
      Effect.all([api.getPullRequest(input), api.getRepositoryAccess(input), api.getViewer()], {
        concurrency: 3,
      }).pipe(
        Effect.flatMap(([pullRequest, access, viewer]) =>
          api
            .listChecks({ ...input, sha: pullRequest.headSha })
            .pipe(Effect.orElseSucceed(() => []))
            .pipe(
              Effect.map((checks): ProviderChangeRequestDetail => ({
                ...toChangeRequest(pullRequest),
                body: pullRequest.body,
                changedFiles: pullRequest.changedFiles,
                mergedAt: pullRequest.mergedAt,
                closedAt: pullRequest.closedAt,
                reviewers: pullRequest.reviewers,
                checks,
                mergeCapabilities: access.mergeCapabilities,
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
        ],
        { concurrency: 4 },
      ).pipe(
        Effect.mapError(fail("getChangeRequestActivity")),
        Effect.map(
          ([pullRequest, issueComments, reviews, commits]): ProviderChangeRequestActivity => ({
            author: pullRequest.author,
            reviewers: pullRequest.reviewers,
            comments: [...issueComments.comments, ...reviews.comments].toSorted((left, right) =>
              left.createdAt.localeCompare(right.createdAt),
            ),
            commentCount: Math.max(
              pullRequest.commentCount,
              issueComments.comments.length + reviews.comments.length,
            ),
            commentsTruncated: issueComments.truncated || reviews.truncated,
            reviewThreads: reviews.threads,
            commits,
          }),
        ),
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
      api.getDiffFileContents(input).pipe(Effect.mapError(fail("getDiffFileContents"))),

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

    // Never called: Gitea cannot edit every kind of remark, and the capability stays false.
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

    // Never called: the target API cannot cover reactions on review comments.
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
