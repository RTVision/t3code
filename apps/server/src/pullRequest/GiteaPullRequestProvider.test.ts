import { describe, expect, it } from "@effect/vitest";

import {
  giteaBaseComparison,
  giteaProviderFailure,
  giteaViewerPermissions,
} from "./GiteaPullRequestProvider.ts";
import { GiteaPullRequestApiError } from "./GiteaPullRequestApi.ts";

describe("giteaViewerPermissions", () => {
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
