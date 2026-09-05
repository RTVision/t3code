import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestActor,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInvolvement,
  PullRequestLabel,
  PullRequestLabelCandidateList,
  PullRequestListState,
  PullRequestMergeCapabilities,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestReviewCommentDraft,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
  PullRequestUpdateMethod,
} from "@t3tools/contracts";

import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import type { ProviderListCursor } from "./PullRequestProvider.ts";

const PAGE_SIZE = 50;
const CONVERSATION_PAGES = 4;
const DIFF_MAX_BYTES = 8 * 1024 * 1024;

const RawUser = Schema.Struct({
  id: Schema.optional(Schema.Int),
  login: Schema.optional(Schema.String),
  full_name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
const RawRepository = Schema.Struct({
  full_name: Schema.optional(Schema.String),
  allow_merge_commits: Schema.optional(Schema.Boolean),
  allow_squash_merge: Schema.optional(Schema.Boolean),
  allow_rebase: Schema.optional(Schema.Boolean),
  allow_merge_update: Schema.optional(Schema.Boolean),
  allow_rebase_update: Schema.optional(Schema.Boolean),
  permissions: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        admin: Schema.optional(Schema.Boolean),
        push: Schema.optional(Schema.Boolean),
        pull: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
const RawBranch = Schema.Struct({
  ref: Schema.optional(Schema.String),
  sha: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.NullOr(RawRepository)),
});
const RawLabel = Schema.Struct({
  id: Schema.optional(Schema.Int),
  name: Schema.optional(Schema.String),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});
const RawPullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.String,
  merged: Schema.optional(Schema.Boolean),
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  draft: Schema.optional(Schema.Boolean),
  html_url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  closed_at: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(Schema.Int),
  deletions: Schema.optional(Schema.Int),
  changed_files: Schema.optional(Schema.Int),
  comments: Schema.optional(Schema.Int),
  review_comments: Schema.optional(Schema.Int),
  user: Schema.optional(Schema.NullOr(RawUser)),
  base: RawBranch,
  head: RawBranch,
  requested_reviewers: Schema.optional(Schema.Array(RawUser)),
  labels: Schema.optional(Schema.Array(RawLabel)),
});
const RawComment = Schema.Struct({
  id: Schema.Int,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(RawUser)),
});
const RawReview = Schema.Struct({
  id: Schema.Int,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.String),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  stale: Schema.optional(Schema.Boolean),
  dismissed: Schema.optional(Schema.Boolean),
  user: Schema.optional(Schema.NullOr(RawUser)),
});
const RawReviewComment = Schema.Struct({
  id: Schema.Int,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.String,
  position: Schema.optional(Schema.Int),
  original_position: Schema.optional(Schema.Int),
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  resolver: Schema.optional(Schema.NullOr(RawUser)),
  user: Schema.optional(Schema.NullOr(RawUser)),
});
const RawCommit = Schema.Struct({
  sha: Schema.String,
  created: Schema.optional(Schema.String),
  author: Schema.optional(Schema.NullOr(RawUser)),
  committer: Schema.optional(Schema.NullOr(RawUser)),
  commit: Schema.optional(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      author: Schema.optional(
        Schema.Struct({
          name: Schema.optional(Schema.String),
          date: Schema.optional(Schema.String),
        }),
      ),
      committer: Schema.optional(
        Schema.Struct({
          name: Schema.optional(Schema.String),
          date: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
const RawCombinedStatus = Schema.Struct({
  statuses: Schema.optional(
    Schema.Array(
      Schema.Struct({
        context: Schema.optional(Schema.String),
        description: Schema.optional(Schema.NullOr(Schema.String)),
        status: Schema.optional(Schema.String),
        target_url: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
const RawContents = Schema.Struct({
  content: Schema.optional(Schema.NullOr(Schema.String)),
  encoding: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.optional(Schema.String),
});

type RawPullRequest = typeof RawPullRequest.Type;
type RawReviewComment = typeof RawReviewComment.Type;

const decodeRow = Schema.decodeUnknownOption(RawPullRequest);
const decodeUser = Schema.decodeUnknownOption(RawUser);
const decodeComment = Schema.decodeUnknownOption(RawComment);
const decodeReview = Schema.decodeUnknownOption(RawReview);
const decodeReviewComment = Schema.decodeUnknownOption(RawReviewComment);
const decodeCommit = Schema.decodeUnknownOption(RawCommit);
const decodeLabel = Schema.decodeUnknownOption(RawLabel);
const encodeObject = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

export interface GiteaPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly author: PullRequestActor | null;
  readonly headBranch: string;
  readonly headSha: string;
  readonly headRepositoryNameWithOwner: string | null;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly mergeability: PullRequestMergeability;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly reviewRequestLogins: ReadonlyArray<string>;
  readonly reviewers: ReadonlyArray<PullRequestActor>;
  readonly labels: ReadonlyArray<PullRequestLabel>;
  readonly commentCount: number;
}

export interface GiteaRepositoryAccess {
  readonly canWrite: boolean;
  readonly mergeCapabilities: PullRequestMergeCapabilities;
  readonly updateMethods: ReadonlyArray<PullRequestUpdateMethod>;
}

export class GiteaPullRequestApiError extends Schema.TaggedErrorClass<GiteaPullRequestApiError>()(
  "GiteaPullRequestApiError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["unconfigured", "unauthenticated", "rate-limited", "failed"]),
    detail: Schema.String,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Gitea failed in ${this.operation}: ${this.detail}`;
  }
}

function iso(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

function actor(value: typeof RawUser.Type | null | undefined): PullRequestActor | null {
  const login = value?.login?.trim();
  if (!login) return null;
  return {
    login,
    name: value?.full_name?.trim() || null,
    avatarUrl: value?.avatar_url?.trim() || null,
  };
}

function pullRequest(value: RawPullRequest): GiteaPullRequest | null {
  const title = value.title.trim();
  const headBranch = value.head.ref?.trim();
  const baseBranch = value.base.ref?.trim();
  const createdAt = iso(value.created_at);
  const updatedAt = iso(value.updated_at);
  if (value.number < 1 || !title || !headBranch || !baseBranch || !createdAt || !updatedAt)
    return null;
  const reviewers = (value.requested_reviewers ?? []).flatMap((user) => {
    const mapped = actor(user);
    return mapped === null ? [] : [mapped];
  });
  return {
    number: value.number,
    title,
    body: value.body ?? "",
    url: value.html_url,
    author: actor(value.user),
    headBranch,
    headSha: value.head.sha?.trim() ?? "",
    headRepositoryNameWithOwner: value.head.repo?.full_name?.trim() || null,
    baseBranch,
    baseSha: value.base.sha?.trim() ?? "",
    state: value.merged === true ? "merged" : value.state === "closed" ? "closed" : "open",
    isDraft: value.draft ?? false,
    mergeability:
      value.mergeable === true
        ? "mergeable"
        : value.mergeable === false
          ? "conflicting"
          : "unknown",
    additions: Math.max(0, value.additions ?? 0),
    deletions: Math.max(0, value.deletions ?? 0),
    changedFiles: Math.max(0, value.changed_files ?? 0),
    createdAt,
    updatedAt,
    mergedAt: iso(value.merged_at),
    closedAt: iso(value.closed_at),
    reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
    reviewers,
    labels: (value.labels ?? []).flatMap((label) => {
      const name = label.name?.trim();
      return name ? [{ name, color: label.color?.trim() || null }] : [];
    }),
    commentCount: Math.max(0, value.comments ?? 0) + Math.max(0, value.review_comments ?? 0),
  };
}

function query(
  path: string,
  params: Readonly<Record<string, string | number | undefined>>,
): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params))
    if (value !== undefined) search.set(name, String(value));
  const suffix = search.toString();
  return suffix === "" ? path : `${path}?${suffix}`;
}

function repositoryPath(repository: string): string | null {
  const parts = repository.trim().split("/");
  if (parts.length !== 2 || parts.some((part) => part.trim() === "")) return null;
  return `/repos/${parts.map(encodeURIComponent).join("/")}`;
}

const GITEA_REACTION_CONTENT: Readonly<Record<string, string>> = {
  "thumbs-up": "+1",
  "thumbs-down": "-1",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

function reactionContent(content: string): string {
  return GITEA_REACTION_CONTENT[content] ?? content;
}

export class GiteaPullRequestApi extends Context.Service<
  GiteaPullRequestApi,
  {
    readonly getViewer: () => Effect.Effect<string, GiteaPullRequestApiError>;
    readonly listPullRequests: (input: {
      readonly host: string;
      readonly repository: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly cursor?: ProviderListCursor;
    }) => Effect.Effect<
      { items: ReadonlyArray<GiteaPullRequest>; truncated: boolean; consumed: number },
      GiteaPullRequestApiError
    >;
    readonly getPullRequest: (input: {
      host: string;
      repository: string;
      number: number;
    }) => Effect.Effect<GiteaPullRequest, GiteaPullRequestApiError>;
    readonly getRepositoryAccess: (input: {
      host: string;
      repository: string;
    }) => Effect.Effect<GiteaRepositoryAccess, GiteaPullRequestApiError>;
    readonly listComments: (input: {
      host: string;
      repository: string;
      number: number;
    }) => Effect.Effect<
      { comments: ReadonlyArray<PullRequestComment>; truncated: boolean },
      GiteaPullRequestApiError
    >;
    readonly listReviews: (input: {
      host: string;
      repository: string;
      number: number;
    }) => Effect.Effect<
      {
        comments: ReadonlyArray<PullRequestComment>;
        threads: ReadonlyArray<PullRequestReviewThread>;
        truncated: boolean;
      },
      GiteaPullRequestApiError
    >;
    readonly listCommits: (input: {
      host: string;
      repository: string;
      number: number;
    }) => Effect.Effect<ReadonlyArray<PullRequestCommit>, GiteaPullRequestApiError>;
    readonly listChecks: (input: {
      host: string;
      repository: string;
      sha: string;
    }) => Effect.Effect<ReadonlyArray<PullRequestCheck>, GiteaPullRequestApiError>;
    readonly getDiff: (input: {
      host: string;
      repository: string;
      number: number;
      commit?: string;
    }) => Effect.Effect<{ patch: string; truncated: boolean }, GiteaPullRequestApiError>;
    readonly getDiffFileContents: (input: {
      host: string;
      repository: string;
      number: number;
      oldPath: string;
      newPath: string;
      changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
    }) => Effect.Effect<{ oldContents: string; newContents: string }, GiteaPullRequestApiError>;
    readonly runAction: (input: {
      host: string;
      repository: string;
      number: number;
      action: PullRequestAction;
      mergeMethod?: PullRequestMergeMethod;
      updateMethod?: PullRequestUpdateMethod;
    }) => Effect.Effect<void, GiteaPullRequestApiError>;
    readonly updatePullRequest: (input: {
      host: string;
      repository: string;
      number: number;
      title?: string;
      body?: string;
    }) => Effect.Effect<void, GiteaPullRequestApiError>;
    readonly comment: (input: {
      host: string;
      repository: string;
      number: number;
      body: string;
    }) => Effect.Effect<void, GiteaPullRequestApiError>;
    readonly updateComment: (input: {
      host: string;
      repository: string;
      commentId: string;
      body: string;
    }) => Effect.Effect<void, GiteaPullRequestApiError>;
    readonly submitReview: (input: {
      host: string;
      repository: string;
      number: number;
      verdict: PullRequestReviewVerdict;
      body: string;
      comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, GiteaPullRequestApiError>;
    readonly listReviewerCandidates: (input: {
      host: string;
      repository: string;
      number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, GiteaPullRequestApiError>;
    readonly setReviewerRequest: (input: {
      host: string;
      repository: string;
      number: number;
      reviewers: ReadonlyArray<{ id: string; kind: "user" | "team" }>;
      requested: boolean;
    }) => Effect.Effect<void, GiteaPullRequestApiError>;
    readonly listLabelCandidates: (input: {
      host: string;
      repository: string;
      number: number;
    }) => Effect.Effect<PullRequestLabelCandidateList, GiteaPullRequestApiError>;
    readonly setLabels: (input: {
      host: string;
      repository: string;
      number: number;
      labels: ReadonlyArray<string>;
      applied: boolean;
    }) => Effect.Effect<void, GiteaPullRequestApiError>;
    readonly replyToThread: (input: {
      host: string;
      repository: string;
      number: number;
      threadId: string;
      body: string;
    }) => Effect.Effect<void, GiteaPullRequestApiError>;
    readonly setThreadResolution: (input: {
      host: string;
      repository: string;
      threadId: string;
      resolved: boolean;
    }) => Effect.Effect<void, GiteaPullRequestApiError>;
    readonly setReaction: (input: {
      host: string;
      repository: string;
      number: number;
      subjectId?: string;
      content: string;
      reacted: boolean;
    }) => Effect.Effect<void, GiteaPullRequestApiError>;
  }
>()("t3/pullRequest/GiteaPullRequestApi") {}

export const make = Effect.gen(function* () {
  const gitea = yield* GiteaApi.GiteaApi;

  const failure = (operation: string, error: GiteaApi.GiteaApiError) =>
    new GiteaPullRequestApiError({
      operation,
      reason: error.reason,
      detail: error.detail,
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
      cause: error,
    });

  const validateHost = Effect.fn("GiteaPullRequestApi.validateHost")(function* (host: string) {
    const configured = Option.getOrUndefined(gitea.baseUrl);
    if (configured === undefined) {
      return yield* new GiteaPullRequestApiError({
        operation: "validateHost",
        reason: "unconfigured",
        detail: GiteaApi.GITEA_SETUP_HINT,
      });
    }
    const expected = new URL(configured).hostname.toLowerCase();
    const actual = yield* Effect.try({
      try: () => new URL(`https://${host.trim()}`).hostname.toLowerCase(),
      catch: () =>
        new GiteaPullRequestApiError({
          operation: "validateHost",
          reason: "failed",
          detail: "The pull request host is invalid.",
        }),
    });
    if (actual !== expected) {
      return yield* new GiteaPullRequestApiError({
        operation: "validateHost",
        reason: "failed",
        detail: `The configured Gitea server does not serve ${host}.`,
      });
    }
  });

  const request = Effect.fn("GiteaPullRequestApi.request")(function* (input: {
    operation: string;
    host: string;
    repository?: string;
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    body?: string;
    maxBytes?: number;
  }) {
    yield* validateHost(input.host);
    if (input.repository !== undefined && repositoryPath(input.repository) === null) {
      return yield* new GiteaPullRequestApiError({
        operation: input.operation,
        reason: "failed",
        detail: "Gitea repositories must be written as owner/name.",
      });
    }
    return yield* gitea
      .request(input)
      .pipe(Effect.mapError((error) => failure(input.operation, error)));
  });

  const decode = <S extends Schema.Top>(
    operation: string,
    schema: S,
    response: GiteaApi.GiteaResponse,
  ) =>
    GiteaApi.decodeGiteaResponse(operation, schema, response).pipe(
      Effect.mapError((error) => failure(operation, error)),
    );

  const basePath = (repository: string) => repositoryPath(repository)!;

  const getPullRequest = Effect.fn("GiteaPullRequestApi.getPullRequest")(function* (input: {
    host: string;
    repository: string;
    number: number;
  }) {
    const operation = "getPullRequest";
    const response = yield* request({
      operation,
      host: input.host,
      repository: input.repository,
      method: "GET",
      path: `${basePath(input.repository)}/pulls/${input.number}`,
    });
    const raw = yield* decode(operation, RawPullRequest, response);
    const mapped = pullRequest(raw);
    if (mapped === null)
      return yield* new GiteaPullRequestApiError({
        operation,
        reason: "failed",
        detail: "Gitea returned an incomplete pull request.",
      });
    return mapped;
  });

  const readUnknownArray = Effect.fn("GiteaPullRequestApi.readUnknownArray")(function* (input: {
    operation: string;
    host: string;
    repository: string;
    path: string;
  }) {
    const response = yield* request({ ...input, method: "GET" });
    return yield* decode(input.operation, Schema.Array(Schema.Unknown), response);
  });

  const listPullRequests: GiteaPullRequestApi["Service"]["listPullRequests"] = Effect.fn(
    "GiteaPullRequestApi.listPullRequests",
  )(function* (input) {
    const wanted = Math.max(1, input.limit);
    const delivered = input.cursor?.delivered ?? 0;
    const startPage = Math.floor(delivered / PAGE_SIZE) + 1;
    const skip = delivered % PAGE_SIZE;
    const endpointState =
      input.state === "open" ? "open" : input.state === "all" ? "all" : "closed";
    let page = startPage;
    let consumed = 0;
    const collected: Array<GiteaPullRequest> = [];
    while (true) {
      const rows = yield* readUnknownArray({
        operation: "listPullRequests",
        host: input.host,
        repository: input.repository,
        path: query(`${basePath(input.repository)}/pulls`, {
          state: endpointState,
          sort: "recentupdate",
          page,
          limit: PAGE_SIZE,
          ...(input.involvement === "authored" ? { poster: input.viewer } : {}),
        }),
      });
      const pageRows = page === startPage ? rows.slice(skip) : rows;
      for (const [index, row] of pageRows.entries()) {
        consumed += 1;
        const decoded = decodeRow(row);
        if (Option.isNone(decoded)) continue;
        const pr = pullRequest(decoded.value);
        if (pr === null) continue;
        if (input.state !== "all" && pr.state !== input.state) continue;
        if (
          input.involvement === "authored" &&
          pr.author?.login.toLowerCase() !== input.viewer.toLowerCase()
        )
          continue;
        if (
          input.involvement === "reviewing" &&
          !pr.reviewRequestLogins.some(
            (login) => login.toLowerCase() === input.viewer.toLowerCase(),
          )
        )
          continue;
        collected.push(pr);
        if (collected.length === wanted) {
          return {
            items: collected,
            truncated: index < pageRows.length - 1 || rows.length === PAGE_SIZE,
            consumed,
          };
        }
      }
      if (rows.length < PAGE_SIZE) break;
      page += 1;
    }
    return { items: collected, truncated: false, consumed };
  });

  const getRepositoryAccess = Effect.fn("GiteaPullRequestApi.getRepositoryAccess")(
    function* (input: { host: string; repository: string }) {
      const operation = "getRepositoryAccess";
      const response = yield* request({
        operation,
        ...input,
        method: "GET",
        path: basePath(input.repository),
      });
      const repo = yield* decode(operation, RawRepository, response);
      return {
        // An omitted permission block is unknown rather than a denial. Gitea will still enforce
        // the write, while hiding it here would leave an entitled viewer with no route to try.
        canWrite:
          repo.permissions == null ||
          repo.permissions.push === true ||
          repo.permissions.admin === true,
        mergeCapabilities: {
          merge: repo.allow_merge_commits ?? true,
          squash: repo.allow_squash_merge ?? true,
          rebase: repo.allow_rebase ?? true,
        },
        updateMethods: [
          ...(repo.allow_merge_update !== false ? (["merge"] as const) : []),
          ...(repo.allow_rebase_update !== false ? (["rebase"] as const) : []),
        ],
      };
    },
  );

  const listComments = Effect.fn("GiteaPullRequestApi.listComments")(function* (input: {
    host: string;
    repository: string;
    number: number;
  }) {
    const all: Array<PullRequestComment> = [];
    let truncated = false;
    for (let page = 1; page <= CONVERSATION_PAGES; page += 1) {
      const rows = yield* readUnknownArray({
        operation: "listComments",
        ...input,
        path: query(`${basePath(input.repository)}/issues/${input.number}/comments`, {
          page,
          limit: PAGE_SIZE,
        }),
      });
      for (const row of rows) {
        const decoded = decodeComment(row);
        if (Option.isNone(decoded)) continue;
        const body = decoded.value.body ?? "";
        const createdAt = iso(decoded.value.created_at);
        if (!createdAt || !body.trim()) continue;
        all.push({
          id: `issue:${decoded.value.id}`,
          kind: "issue-comment",
          author: actor(decoded.value.user),
          body,
          createdAt,
          url: decoded.value.html_url ?? null,
          path: null,
          reviewState: null,
        });
      }
      if (rows.length < PAGE_SIZE) return { comments: all, truncated: false };
      truncated = page === CONVERSATION_PAGES;
    }
    return { comments: all, truncated };
  });

  const listReviews = Effect.fn("GiteaPullRequestApi.listReviews")(function* (input: {
    host: string;
    repository: string;
    number: number;
  }) {
    const reviewRows = yield* readUnknownArray({
      operation: "listReviews",
      ...input,
      path: query(`${basePath(input.repository)}/pulls/${input.number}/reviews`, {
        page: 1,
        limit: PAGE_SIZE,
      }),
    });
    const comments: Array<PullRequestComment> = [];
    const threads: Array<PullRequestReviewThread> = [];
    for (const row of reviewRows) {
      const review = decodeReview(row);
      if (Option.isNone(review)) continue;
      const reviewAt = iso(review.value.submitted_at ?? review.value.updated_at);
      if (reviewAt && (review.value.body ?? "").trim()) {
        comments.push({
          id: `review:${review.value.id}`,
          kind: "review",
          author: actor(review.value.user),
          body: review.value.body ?? "",
          createdAt: reviewAt,
          url: review.value.html_url ?? null,
          path: null,
          reviewState: review.value.state?.toLowerCase().replaceAll("_", " ") ?? null,
        });
      }
      const codeRows = yield* readUnknownArray({
        operation: "listReviewComments",
        ...input,
        path: query(
          `${basePath(input.repository)}/pulls/${input.number}/reviews/${review.value.id}/comments`,
          { page: 1, limit: PAGE_SIZE },
        ),
      });
      for (const codeRow of codeRows) {
        const decoded = decodeReviewComment(codeRow);
        if (Option.isNone(decoded)) continue;
        const mapped = decoded.value;
        const createdAt = iso(mapped.created_at);
        if (!createdAt || !(mapped.body ?? "").trim()) continue;
        comments.push({
          id: `review-comment:${mapped.id}`,
          kind: "review-comment",
          author: actor(mapped.user),
          body: mapped.body ?? "",
          createdAt,
          url: mapped.html_url ?? null,
          path: mapped.path,
          reviewState: null,
        });
        const line =
          mapped.position && mapped.position > 0
            ? mapped.position
            : mapped.original_position && mapped.original_position > 0
              ? mapped.original_position
              : null;
        threads.push({
          id: String(mapped.id),
          path: mapped.path,
          line,
          side: mapped.position && mapped.position > 0 ? "right" : "left",
          isResolved: mapped.resolver != null,
          isOutdated: review.value.stale ?? false,
          comments: [
            {
              id: `review-comment:${mapped.id}`,
              author: actor(mapped.user),
              body: mapped.body ?? "",
              createdAt,
              url: mapped.html_url ?? null,
            },
          ],
        });
      }
    }
    return { comments, threads, truncated: reviewRows.length >= PAGE_SIZE };
  });

  const listCommits = Effect.fn("GiteaPullRequestApi.listCommits")(function* (input: {
    host: string;
    repository: string;
    number: number;
  }) {
    const rows = yield* readUnknownArray({
      operation: "listCommits",
      ...input,
      path: query(`${basePath(input.repository)}/pulls/${input.number}/commits`, {
        page: 1,
        limit: PAGE_SIZE,
      }),
    });
    return rows.flatMap((row): ReadonlyArray<PullRequestCommit> => {
      const decoded = decodeCommit(row);
      if (Option.isNone(decoded) || !decoded.value.sha.trim()) return [];
      const value = decoded.value;
      const committedDate = iso(
        value.commit?.committer?.date ?? value.commit?.author?.date ?? value.created,
      );
      if (!committedDate) return [];
      const author = actor(value.author) ?? actor(value.committer);
      return [
        {
          oid: value.sha,
          messageHeadline: value.commit?.message?.split("\n", 1)[0] ?? "",
          committedDate,
          ...(author === null ? {} : { authors: [author] }),
        },
      ];
    });
  });

  const listChecks = Effect.fn("GiteaPullRequestApi.listChecks")(function* (input: {
    host: string;
    repository: string;
    sha: string;
  }) {
    const operation = "listChecks";
    const response = yield* request({
      operation,
      host: input.host,
      repository: input.repository,
      method: "GET",
      path: `${basePath(input.repository)}/commits/${encodeURIComponent(input.sha)}/status`,
    });
    const combined = yield* decode(operation, RawCombinedStatus, response);
    return (combined.statuses ?? []).flatMap((status): ReadonlyArray<PullRequestCheck> => {
      const name = status.context?.trim();
      if (!name) return [];
      const state = status.status;
      return [
        {
          name,
          status:
            state === "success"
              ? "success"
              : state === "pending"
                ? "pending"
                : state === "failure" || state === "error"
                  ? "failure"
                  : state === "skipped"
                    ? "skipped"
                    : "neutral",
          description: status.description?.trim() || null,
          url: status.target_url?.trim() || null,
        },
      ];
    });
  });

  const fileContents = Effect.fn("GiteaPullRequestApi.fileContents")(function* (input: {
    host: string;
    repository: string;
    path: string;
    ref: string;
  }) {
    const operation = "getDiffFileContents";
    const response = yield* request({
      operation,
      host: input.host,
      repository: input.repository,
      method: "GET",
      path: query(
        `${basePath(input.repository)}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`,
        { ref: input.ref },
      ),
    });
    const contents = yield* decode(operation, RawContents, response);
    if (contents.type !== "file" || contents.encoding !== "base64" || contents.content == null)
      return yield* new GiteaPullRequestApiError({
        operation,
        reason: "failed",
        detail: "Gitea did not return base64 file contents.",
      });
    return Buffer.from(contents.content.replaceAll("\n", ""), "base64").toString("utf8");
  });

  const write = (input: {
    operation: string;
    host: string;
    repository: string;
    method: "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    body?: Readonly<Record<string, unknown>>;
  }) =>
    request({
      operation: input.operation,
      host: input.host,
      repository: input.repository,
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: encodeObject(input.body) }),
    }).pipe(Effect.asVoid);

  const unsupportedAction = (action: string) =>
    new GiteaPullRequestApiError({
      operation: "runAction",
      reason: "failed",
      detail: `Gitea does not expose a reliable ${action} operation through this API.`,
    });

  return GiteaPullRequestApi.of({
    getViewer: Effect.fn("GiteaPullRequestApi.getViewer")(function* () {
      const response = yield* gitea
        .request({ operation: "getViewer", method: "GET", path: "/user" })
        .pipe(Effect.mapError((error) => failure("getViewer", error)));
      const user = yield* decode("getViewer", RawUser, response);
      const login = user.login?.trim();
      if (!login)
        return yield* new GiteaPullRequestApiError({
          operation: "getViewer",
          reason: "failed",
          detail: "Gitea did not identify the signed-in account.",
        });
      return login;
    }),
    listPullRequests,
    getPullRequest,
    getRepositoryAccess,
    listComments,
    listReviews,
    listCommits,
    listChecks,
    getDiff: (input) =>
      request({
        operation: "getDiff",
        host: input.host,
        repository: input.repository,
        method: "GET",
        path:
          input.commit === undefined
            ? `${basePath(input.repository)}/pulls/${input.number}.diff`
            : `${basePath(input.repository)}/git/commits/${encodeURIComponent(input.commit)}.diff`,
        maxBytes: DIFF_MAX_BYTES,
      }).pipe(Effect.map((response) => ({ patch: response.body, truncated: response.truncated }))),
    getDiffFileContents: (input) =>
      getPullRequest(input).pipe(
        Effect.flatMap((pr) =>
          Effect.all(
            {
              oldContents:
                input.changeType === "new"
                  ? Effect.succeed("")
                  : fileContents({ ...input, path: input.oldPath, ref: pr.baseSha }),
              newContents:
                input.changeType === "deleted"
                  ? Effect.succeed("")
                  : fileContents({ ...input, path: input.newPath, ref: pr.headSha }),
            },
            { concurrency: 2 },
          ),
        ),
      ),
    runAction: (input) => {
      const path = `${basePath(input.repository)}/pulls/${input.number}`;
      switch (input.action) {
        case "merge":
        case "enable-auto-merge":
          return getPullRequest(input).pipe(
            Effect.flatMap((pr) => {
              if (pr.headSha === "") {
                return Effect.fail(
                  new GiteaPullRequestApiError({
                    operation: "runAction",
                    reason: "failed",
                    detail: "Gitea did not report the pull request head commit.",
                  }),
                );
              }
              return write({
                operation: "runAction",
                host: input.host,
                repository: input.repository,
                method: "POST",
                path: `${path}/merge`,
                body: {
                  do: input.mergeMethod ?? "merge",
                  head_commit_id: pr.headSha,
                  ...(input.action === "enable-auto-merge"
                    ? { merge_when_checks_succeed: true }
                    : {}),
                },
              });
            }),
          );
        case "disable-auto-merge":
          return write({
            operation: "runAction",
            host: input.host,
            repository: input.repository,
            method: "DELETE",
            path: `${path}/merge`,
          });
        case "close":
          return write({
            operation: "runAction",
            host: input.host,
            repository: input.repository,
            method: "PATCH",
            path,
            body: { state: "closed" },
          });
        case "reopen":
          return write({
            operation: "runAction",
            host: input.host,
            repository: input.repository,
            method: "PATCH",
            path,
            body: { state: "open" },
          });
        case "update-branch":
          return write({
            operation: "runAction",
            host: input.host,
            repository: input.repository,
            method: "POST",
            path: query(`${path}/update`, { style: input.updateMethod }),
          });
        case "ready":
        case "draft":
        case "revert":
        case "approve-workflows":
          return Effect.fail(unsupportedAction(input.action));
      }
    },
    updatePullRequest: (input) =>
      write({
        operation: "updatePullRequest",
        host: input.host,
        repository: input.repository,
        method: "PATCH",
        path: `${basePath(input.repository)}/pulls/${input.number}`,
        body: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        },
      }),
    comment: (input) =>
      write({
        operation: "comment",
        host: input.host,
        repository: input.repository,
        method: "POST",
        path: `${basePath(input.repository)}/issues/${input.number}/comments`,
        body: { body: input.body },
      }),
    updateComment: (input) => {
      const [kind, id] = input.commentId.split(":", 2);
      if (kind !== "issue" || !id) {
        return Effect.fail(
          new GiteaPullRequestApiError({
            operation: "updateComment",
            reason: "failed",
            detail: "Gitea cannot edit pull request review comments through this API.",
          }),
        );
      }
      return write({
        operation: "updateComment",
        host: input.host,
        repository: input.repository,
        method: "PATCH",
        path: `${basePath(input.repository)}/issues/comments/${id}`,
        body: { body: input.body },
      });
    },
    submitReview: (input) =>
      write({
        operation: "submitReview",
        host: input.host,
        repository: input.repository,
        method: "POST",
        path: `${basePath(input.repository)}/pulls/${input.number}/reviews`,
        body: {
          event:
            input.verdict === "approve"
              ? "APPROVED"
              : input.verdict === "request-changes"
                ? "REQUEST_CHANGES"
                : "COMMENT",
          body: input.body,
          comments: input.comments.map((comment) => ({
            body: comment.body,
            path: comment.path,
            ...(comment.position.kind === "deleted"
              ? { old_position: comment.position.oldLine }
              : { new_position: comment.position.newLine }),
          })),
        },
      }),
    listReviewerCandidates: (input) =>
      Effect.all(
        [
          getPullRequest(input),
          readUnknownArray({
            operation: "listReviewerCandidates",
            ...input,
            path: query(`${basePath(input.repository)}/reviewers`, { page: 1, limit: PAGE_SIZE }),
          }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([pr, rows]) => {
          const requested = new Set(pr.reviewRequestLogins.map((login) => login.toLowerCase()));
          return {
            candidates: rows.flatMap((row) => {
              const raw = decodeUser(row);
              if (Option.isNone(raw)) return [];
              const mapped = actor(raw.value);
              if (mapped === null || mapped.login === pr.author?.login) return [];
              return [
                {
                  ...mapped,
                  id: mapped.login,
                  kind: "user" as const,
                  isRequested: requested.has(mapped.login.toLowerCase()),
                },
              ];
            }),
            truncated: rows.length >= PAGE_SIZE,
          };
        }),
      ),
    setReviewerRequest: (input) =>
      write({
        operation: "setReviewerRequest",
        host: input.host,
        repository: input.repository,
        method: input.requested ? "POST" : "DELETE",
        path: `${basePath(input.repository)}/pulls/${input.number}/requested_reviewers`,
        body: {
          reviewers: input.reviewers
            .filter((reviewer) => reviewer.kind === "user")
            .map((reviewer) => reviewer.id),
          team_reviewers: input.reviewers
            .filter((reviewer) => reviewer.kind === "team")
            .map((reviewer) => reviewer.id),
        },
      }),
    listLabelCandidates: (input) =>
      Effect.all(
        [
          getPullRequest(input),
          readUnknownArray({
            operation: "listLabelCandidates",
            ...input,
            path: query(`${basePath(input.repository)}/labels`, { page: 1, limit: PAGE_SIZE }),
          }),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([pr, rows]) => {
          const applied = new Set(pr.labels.map((label) => label.name.toLowerCase()));
          return {
            candidates: rows.flatMap((row) => {
              const raw = decodeLabel(row);
              const name = Option.isSome(raw) ? raw.value.name?.trim() : undefined;
              return Option.isSome(raw) && name
                ? [
                    {
                      name,
                      color: raw.value.color?.trim() || null,
                      description: raw.value.description ?? null,
                      isApplied: applied.has(name.toLowerCase()),
                    },
                  ]
                : [];
            }),
            truncated: rows.length >= PAGE_SIZE,
          };
        }),
      ),
    setLabels: (input) =>
      getPullRequest(input).pipe(
        Effect.flatMap((pr) => {
          const labels = new Set(pr.labels.map((label) => label.name));
          for (const label of input.labels) {
            if (input.applied) labels.add(label);
            else labels.delete(label);
          }
          return write({
            operation: "setLabels",
            host: input.host,
            repository: input.repository,
            method: "PUT",
            path: `${basePath(input.repository)}/issues/${input.number}/labels`,
            body: { labels: [...labels] },
          });
        }),
      ),
    replyToThread: (input) =>
      write({
        operation: "replyToThread",
        host: input.host,
        repository: input.repository,
        method: "POST",
        path: `${basePath(input.repository)}/pulls/${input.number}/comments/${encodeURIComponent(input.threadId)}/replies`,
        body: { body: input.body },
      }),
    setThreadResolution: (input) =>
      write({
        operation: "setThreadResolution",
        host: input.host,
        repository: input.repository,
        method: "POST",
        path: `${basePath(input.repository)}/pulls/comments/${encodeURIComponent(input.threadId)}/${input.resolved ? "resolve" : "unresolve"}`,
      }),
    setReaction: (input) => {
      const path =
        input.subjectId === undefined
          ? `${basePath(input.repository)}/issues/${input.number}/reactions`
          : `${basePath(input.repository)}/issues/comments/${input.subjectId.replace(/^issue:/u, "")}/reactions`;
      return write({
        operation: "setReaction",
        host: input.host,
        repository: input.repository,
        method: input.reacted ? "POST" : "DELETE",
        path,
        body: { content: reactionContent(input.content) },
      });
    },
  });
});

export const layer = Layer.effect(GiteaPullRequestApi, make);
