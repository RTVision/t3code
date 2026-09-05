import { describe, expect, it } from "@effect/vitest";

import {
  giteaBaseComparison,
  giteaToChangeRequest,
  giteaProviderFailure,
  giteaViewerPermissions,
} from "./GiteaPullRequestProvider.ts";
import { GiteaPullRequestApiError, type GiteaPullRequest } from "./GiteaPullRequestApi.ts";

const trackedPullRequest: GiteaPullRequest = {
  number: 7,
  title: "Tracking summary",
  body: "",
  url: "https://forge.example.test/acme/web/pulls/7",
  author: null,
  headBranch: "feature",
  headSha: "head-sha",
  headRepositoryNameWithOwner: "acme/web",
  baseBranch: "main",
  baseSha: "base-sha",
  mergeBaseSha: "base-sha",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  reviewRequestLogins: [],
  reviewers: [],
  labels: [],
  commentCount: 0,
  reviewDecision: "approved",
  checksState: "failing",
};

it("maps Gitea tracking summaries into the neutral change request", () => {
  expect(giteaToChangeRequest(trackedPullRequest)).toMatchObject({
    reviewDecision: "approved",
    checksState: "failing",
  });
  expect(
    giteaToChangeRequest({
      ...trackedPullRequest,
      reviewDecision: null,
      checksState: null,
    }),
  ).toMatchObject({ reviewDecision: null, checksState: null });
});

describe("giteaViewerPermissions", () => {
  it("offers workflow approval only when the server supports it and the viewer can write", () => {
    expect(
      giteaViewerPermissions({
        canWrite: true,
        ownsPullRequest: false,
        updateMethods: [],
        workflowApprovalSupported: true,
      }).actions,
    ).toContain("approve-workflows");
    expect(
      giteaViewerPermissions({
        canWrite: false,
        ownsPullRequest: true,
        updateMethods: [],
        workflowApprovalSupported: true,
      }).actions,
    ).not.toContain("approve-workflows");
  });
  it("offers repository writes and only the configured branch update strategies", () => {
    expect(
      giteaViewerPermissions({
        canWrite: true,
        ownsPullRequest: false,
        updateMethods: ["rebase"],
      }),
    ).toEqual({
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
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
      updateMethods: ["rebase"],
      labels: true,
    });
  });

  it("lets an author close and reopen without granting repository writes", () => {
    expect(
      giteaViewerPermissions({
        canWrite: false,
        ownsPullRequest: true,
        updateMethods: ["merge", "rebase"],
      }),
    ).toEqual({
      actions: ["ready", "draft", "close", "reopen"],
      comment: true,
      resolve: true,
      verdicts: ["comment"],
      requestReviewers: false,
      updateMethods: [],
      labels: false,
    });
  });

  it("keeps write actions from a read-only non-author", () => {
    expect(
      giteaViewerPermissions({
        canWrite: false,
        ownsPullRequest: false,
        updateMethods: [],
      }).actions,
    ).toEqual([]);
  });
});

describe("giteaBaseComparison", () => {
  it("compares Gitea's merge base with the current base tip", () => {
    expect(giteaBaseComparison({ baseSha: "base", mergeBaseSha: "base" })).toBe("up-to-date");
    expect(
      giteaBaseComparison({
        baseSha: "new-base",
        mergeBaseSha: "old-base",
      }),
    ).toBe("behind");
    expect(giteaBaseComparison({ baseSha: "base", mergeBaseSha: "" })).toBe("unknown");
  });
});

describe("giteaProviderFailure", () => {
  it("maps missing configuration to unauthenticated", () => {
    expect(
      giteaProviderFailure(
        new GiteaPullRequestApiError({
          operation: "list",
          reason: "unconfigured",
          detail: "configure it",
        }),
      ),
    ).toEqual({ reason: "unauthenticated" });
  });

  it("keeps a rate-limit deadline", () => {
    expect(
      giteaProviderFailure(
        new GiteaPullRequestApiError({
          operation: "list",
          reason: "rate-limited",
          detail: "later",
          retryAt: 1234,
        }),
      ),
    ).toEqual({ reason: "rate-limited", retryAt: 1234 });
  });
});

describe("native revert permission", () => {
  it("requires write access and the advertised native endpoint", () => {
    const input = { canWrite: true, ownsPullRequest: false, updateMethods: [] as const };
    expect(giteaViewerPermissions(input).actions).not.toContain("revert");
    expect(giteaViewerPermissions({ ...input, revertSupported: true }).actions).toContain("revert");
    expect(
      giteaViewerPermissions({
        ...input,
        canWrite: false,
        ownsPullRequest: true,
        revertSupported: true,
      }).actions,
    ).not.toContain("revert");
  });
});
