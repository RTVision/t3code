import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import {
  giteaBaseComparison,
  giteaProviderFailure,
  giteaViewerPermissions,
  make as makeGiteaPullRequestProvider,
} from "./GiteaPullRequestProvider.ts";
import * as GiteaPullRequestApi from "./GiteaPullRequestApi.ts";
import { GiteaPullRequestApiError } from "./GiteaPullRequestApi.ts";

function response(value: unknown) {
  return { body: JSON.stringify(value), truncated: false, headers: {} };
}

function rawPullRequest() {
  return {
    number: 7,
    title: "Pull request 7",
    body: "Body",
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    html_url: "https://forge.example.test/gitea/acme/web/pulls/7",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-02T10:00:00Z",
    additions: 4,
    deletions: 2,
    changed_files: 1,
    comments: 1,
    review_comments: 2,
    merge_base: "base-sha",
    user: { id: 1, login: "author", full_name: "Author" },
    base: { ref: "main", sha: "base-sha", repo: { full_name: "acme/web" } },
    head: { ref: "feature", sha: "head-sha", repo: { full_name: "fork/web" } },
    requested_reviewers: [],
    labels: [],
  };
}

describe("GiteaPullRequestProvider", () => {
  it.effect("keeps pull request detail when auto-merge state cannot be read", () =>
    Effect.gen(function* () {
      const request = vi.fn<GiteaApi.GiteaApi["Service"]["request"]>((input) => {
        switch (input.path) {
          case "/repos/acme/web/pulls/7":
            return Effect.succeed(response(rawPullRequest()));
          case "/repos/acme/web":
            return Effect.succeed(response({ permissions: { push: true } }));
          case "/user":
            return Effect.succeed(response({ login: "reader" }));
          case "/repos/acme/web/issues/7/timeline?page=1&limit=50":
            return Effect.fail(
              new GiteaApi.GiteaApiError({
                operation: "getAutoMergeEnabled",
                reason: "failed",
                detail: "timeline unavailable",
              }),
            );
          case "/repos/acme/web/commits/head-sha/status?page=1&limit=50":
            return Effect.succeed(response({ statuses: [], total_count: 0 }));
          default:
            return Effect.die(`Unexpected Gitea request: ${input.path}`);
        }
      });
      const apiLayer = GiteaPullRequestApi.layer.pipe(
        Layer.provide(
          Layer.succeed(
            GiteaApi.GiteaApi,
            GiteaApi.GiteaApi.of({
              baseUrl: Option.some("https://forge.example.test/gitea"),
              sshHosts: [],
              request,
              probeAuth: Effect.die("not used"),
            }),
          ),
        ),
      );
      const provider = yield* makeGiteaPullRequestProvider.pipe(Effect.provide(apiLayer));

      const detail = yield* provider.getChangeRequest({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
      });

      expect(detail.number).toBe(7);
      expect(detail.checks).toEqual([]);
      expect("autoMergeEnabled" in detail).toBe(false);
    }),
  );
});

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
