import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import * as GiteaPullRequestApi from "./GiteaPullRequestApi.ts";

const mockedRequest = vi.fn<GiteaApi.GiteaApi["Service"]["request"]>();
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const layer = it.layer(
  Layer.succeed(
    GiteaApi.GiteaApi,
    GiteaApi.GiteaApi.of({
      baseUrl: Option.some("https://forge.example.test/gitea"),
      sshHosts: ["work-forge"],
      request: mockedRequest,
      probeAuth: Effect.die("not used"),
    }),
  ),
);

function response(value: unknown, headers: Readonly<Record<string, string>> = {}) {
  return { body: JSON.stringify(value), truncated: false, headers };
}

function rawPullRequest(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Pull request ${number}`,
    body: "Body",
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    html_url: `https://forge.example.test/gitea/acme/web/pulls/${number}`,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: `2026-09-02T10:${String(number % 60).padStart(2, "0")}:00Z`,
    additions: 4,
    deletions: 2,
    changed_files: 1,
    comments: 1,
    review_comments: 2,
    merge_base: "merge-base-sha",
    user: {
      id: 1,
      login: "author",
      full_name: "Author",
      avatar_url: "https://a.test/1",
    },
    base: { ref: "main", sha: "base-sha", repo: { full_name: "acme/web" } },
    head: {
      ref: "feature",
      sha: "head-sha",
      repo: { full_name: "fork/web" },
    },
    requested_reviewers: [{ id: 2, login: "reviewer" }],
    labels: [{ id: 3, name: "bug", color: "ff0000" }],
    ...overrides,
  };
}

function callAt(index: number) {
  const call = mockedRequest.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}

afterEach(() => mockedRequest.mockReset());

it.effect("skips an invalid hydrated search pull request without dropping later valid rows", () =>
  Effect.gen(function* () {
    mockedRequest.mockImplementation((input) => {
      if (input.path.startsWith("/repos/acme/web/issues?"))
        return Effect.succeed(response([{ number: 1 }, { number: 2 }]));
      if (input.path === "/repos/acme/web/pulls/1") return Effect.succeed(response({ number: 1 }));
      if (input.path === "/repos/acme/web/pulls/2")
        return Effect.succeed(response(rawPullRequest(2)));
      return Effect.die(`unexpected request: ${input.path}`);
    });
    const api = yield* GiteaPullRequestApi.make.pipe(
      Effect.provideService(
        GiteaApi.GiteaApi,
        GiteaApi.GiteaApi.of({
          baseUrl: Option.some("https://forge.example.test/gitea"),
          sshHosts: ["work-forge"],
          request: mockedRequest,
          probeAuth: Effect.die("not used"),
        }),
      ),
    );
    const page = yield* api.listPullRequests({
      host: "forge.example.test",
      repository: "acme/web",
      state: "open",
      involvement: "all",
      viewer: "reader",
      limit: 10,
      query: "bug",
    });
    expect(page.items.map((pullRequest) => pullRequest.number)).toEqual([2]);
  }),
);

it.effect("keeps a search hydration transport failure fatal", () =>
  Effect.gen(function* () {
    mockedRequest.mockImplementation((input) => {
      if (input.path.startsWith("/repos/acme/web/issues?"))
        return Effect.succeed(response([{ number: 1 }]));
      return Effect.fail(
        new GiteaApi.GiteaApiError({
          operation: "getPullRequest",
          reason: "unauthenticated",
          detail: "expired",
        }),
      );
    });
    const api = yield* GiteaPullRequestApi.make.pipe(
      Effect.provideService(
        GiteaApi.GiteaApi,
        GiteaApi.GiteaApi.of({
          baseUrl: Option.some("https://forge.example.test/gitea"),
          sshHosts: ["work-forge"],
          request: mockedRequest,
          probeAuth: Effect.die("not used"),
        }),
      ),
    );
    const error = yield* api
      .listPullRequests({
        host: "forge.example.test",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "reader",
        limit: 10,
        query: "bug",
      })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "unauthenticated");
  }),
);

layer("GiteaPullRequestApi", (it) => {
  it.effect("reconstructs auto-merge from the timeline when discovery is unavailable", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.fail(
            new GiteaApi.GiteaApiError({
              operation: "getFeatures",
              reason: "failed",
              detail: "temporarily unavailable",
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(response([{ id: 1, type: "pull_scheduled_merge" }])));
      const api = yield* GiteaPullRequestApi.make;
      expect(
        yield* api.getAutoMergeEnabled({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
        }),
      ).toBe(true);
      expect(callAt(1).path).toContain("/timeline?");
    }),
  );
  it.effect("opens a native revert PR only on an advertising Gitea server", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response({ features: ["pull-revert"] })))
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(8))));
      const api = yield* GiteaPullRequestApi.make;
      yield* api.runAction({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        action: "revert",
      });
      expect(callAt(1)).toMatchObject({ method: "POST", path: "/repos/acme/web/pulls/7/revert" });
      expect(mockedRequest.mock.calls).toHaveLength(2);
    }),
  );
  it.effect("does not attempt a revert on stock Gitea", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response({ features: [] })));
      const api = yield* GiteaPullRequestApi.make;
      const error = yield* api
        .runAction({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
          action: "revert",
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("does not expose native pull request reverts");
      expect(mockedRequest.mock.calls.every(([call]) => call.method === "GET")).toBe(true);
    }),
  );

  it.effect("approves only the current pull request's waiting workflow runs", () =>
    Effect.gen(function* () {
      const pull = rawPullRequest(7);
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(pull)))
        .mockReturnValueOnce(Effect.succeed(response({ features: ["actions-run-approve"] })))
        .mockReturnValueOnce(Effect.succeed(response(pull)))
        .mockReturnValueOnce(
          Effect.succeed(
            response({
              total_count: 1,
              workflow_runs: [
                {
                  id: 42,
                  needs_approval: true,
                  pull_request_head_sha: "head-sha",
                  head_sha: "merge-sha",
                  event: "pull_request",
                  html_url: "https://forge.example.test/run/42",
                  pull_requests: [{ number: 7 }],
                },
              ],
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(response(pull)))
        .mockReturnValueOnce(Effect.succeed(response({})));
      const api = yield* GiteaPullRequestApi.make;
      yield* api.runAction({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        action: "approve-workflows",
      });
      expect(
        mockedRequest.mock.calls
          .filter(([call]) => call.method === "POST")
          .map(([call]) => call.path),
      ).toEqual(["/repos/acme/web/actions/runs/42/approve"]);
    }),
  );

  it.effect("rejects workflow approval on servers without native approval metadata", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))))
        .mockReturnValueOnce(Effect.succeed(response({})));
      const api = yield* GiteaPullRequestApi.make;
      const error = yield* api
        .runAction({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
          action: "approve-workflows",
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("does not expose workflow approval metadata");
      expect(mockedRequest.mock.calls.every(([call]) => call.method === "GET")).toBe(true);
    }),
  );

  it.effect("never approves a workflow after the pull request head changes", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))));
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(response({ features: ["actions-run-approve"] })),
      );
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))));
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response({
            total_count: 1,
            workflow_runs: [
              {
                id: 42,
                needs_approval: true,
                pull_request_head_sha: "head-sha",
                head_sha: "merge-sha",
                event: "pull_request",
                html_url: "https://forge.example.test/run/42",
                pull_requests: [{ number: 7 }],
              },
            ],
          }),
        ),
      );
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(rawPullRequest(7, { head: { ref: "feature", sha: "changed-head" } })),
        ),
      );
      const api = yield* GiteaPullRequestApi.make;
      const error = yield* api
        .runAction({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
          action: "approve-workflows",
        })
        .pipe(Effect.flip);
      expect(error.detail).toContain("head changed");
      expect(mockedRequest.mock.calls.every(([call]) => call.method === "GET")).toBe(true);
    }),
  );

  it.effect("validates the requested host before making an HTTP request", () =>
    Effect.gen(function* () {
      const api = yield* GiteaPullRequestApi.make;
      const error = yield* api
        .getPullRequest({
          host: "elsewhere.test",
          repository: "acme/web",
          number: 7,
        })
        .pipe(Effect.flip);

      assert.strictEqual(error.reason, "failed");
      expect(error.detail).toContain("does not serve elsewhere.test");
      assert.strictEqual(mockedRequest.mock.calls.length, 0);
    }),
  );

  it.effect("accepts an SSH port when the remote names the configured hostname", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))));
      const api = yield* GiteaPullRequestApi.make;
      const pullRequest = yield* api.getPullRequest({
        host: "forge.example.test:2222",
        repository: "acme/web",
        number: 7,
      });

      assert.strictEqual(pullRequest.number, 7);
      assert.strictEqual(mockedRequest.mock.calls.length, 1);
    }),
  );

  it.effect("accepts a configured SSH alias for pull request reads", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))));
      const api = yield* GiteaPullRequestApi.make;
      assert.strictEqual(
        (yield* api.getPullRequest({ host: "work-forge", repository: "acme/web", number: 7 }))
          .number,
        7,
      );
      assert.strictEqual(callAt(0).path, "/repos/acme/web/pulls/7");
    }),
  );

  it.effect("decodes nullable tracking summaries when explicitly requested", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            rawPullRequest(7, {
              review_decision: "approved",
              checks_state: "passing",
            }),
          ),
        ),
      );
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            rawPullRequest(8, {
              review_decision: null,
              checks_state: null,
            }),
          ),
        ),
      );
      const api = yield* GiteaPullRequestApi.make;
      const pullRequest = yield* api.getPullRequest({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        includeTracking: true,
      });

      expect(pullRequest.reviewDecision).toBe("approved");
      expect(pullRequest.checksState).toBe("passing");
      expect(callAt(0).path).toBe("/repos/acme/web/pulls/7?include_tracking=true");

      const nullablePullRequest = yield* api.getPullRequest({
        host: "forge.example.test",
        repository: "acme/web",
        number: 8,
        includeTracking: true,
      });
      expect(nullablePullRequest.reviewDecision).toBeNull();
      expect(nullablePullRequest.checksState).toBeNull();
    }),
  );

  it.effect("keeps merged and closed pull requests distinct and counts malformed rows", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response([
            { number: "broken" },
            rawPullRequest(2, {
              state: "closed",
              merged: true,
            }),
            rawPullRequest(3, {
              state: "closed",
              merged: false,
            }),
            rawPullRequest(4, {
              state: "closed",
              merged: false,
            }),
          ]),
        ),
      );
      const api = yield* GiteaPullRequestApi.make;
      const page = yield* api.listPullRequests({
        host: "forge.example.test",
        repository: "acme/web",
        state: "closed",
        involvement: "all",
        viewer: "reviewer",
        limit: 2,
        includeTracking: true,
      });

      expect(page.items.map((item) => [item.number, item.state])).toEqual([
        [3, "closed"],
        [4, "closed"],
      ]);
      assert.strictEqual(page.consumed, 4);
      assert.isFalse(page.truncated);
      expect(callAt(0).path).toContain("state=closed");
      expect(callAt(0).path).toContain("sort=recentupdate");
      expect(callAt(0).path).toContain("include_tracking=true");
    }),
  );

  it.effect("walks later pages until involvement filtering fills the requested slice", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response([])))
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              Array.from({ length: 50 }, (_, index) =>
                rawPullRequest(index + 1, {
                  requested_reviewers: [],
                }),
              ),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(response([rawPullRequest(51)])));
      const api = yield* GiteaPullRequestApi.make;
      const page = yield* api.listPullRequests({
        host: "forge.example.test",
        repository: "acme/web",
        state: "open",
        involvement: "reviewing",
        viewer: "Reviewer",
        limit: 1,
      });

      expect(page.items.map((item) => item.number)).toEqual([51]);
      assert.strictEqual(page.consumed, 51);
      assert.isFalse(page.truncated);
      expect(callAt(2).path).toContain("page=2");
    }),
  );

  it.effect("continues inside a fixed-size Gitea page", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(Array.from({ length: 50 }, (_, index) => rawPullRequest(index + 1))),
        ),
      );
      const api = yield* GiteaPullRequestApi.make;
      const page = yield* api.listPullRequests({
        host: "forge.example.test",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "reviewer",
        limit: 2,
        cursor: {
          updatedBefore: "2026-09-02T10:10:00.000Z",
          delivered: 10,
        },
      });

      expect(page.items.map((item) => item.number)).toEqual([11, 12]);
      assert.strictEqual(page.consumed, 2);
      assert.isTrue(page.truncated);
      expect(callAt(0).path).toContain("page=1");
    }),
  );

  it.effect("uses native issue search and hydrates its pull request summaries", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response([{ number: 7 }, { number: 8 }])))
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))))
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(8))));
      const api = yield* GiteaPullRequestApi.make;
      const page = yield* api.listPullRequests({
        host: "forge.example.test",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "reviewer",
        limit: 1,
        query: "needs review",
      });

      expect(page.items.map((item) => item.number)).toEqual([7]);
      assert.strictEqual(page.consumed, 1);
      assert.isTrue(page.truncated);
      expect(callAt(0).path).toContain("/repos/acme/web/issues?");
      expect(callAt(0).path).toContain("type=pulls");
      expect(callAt(0).path).toContain("q=needs+review");
      expect(callAt(0).path).not.toContain("/pulls?");
      expect(
        mockedRequest.mock.calls
          .slice(1)
          .map(([request]) => request.path)
          .toSorted(),
      ).toEqual(["/repos/acme/web/pulls/7", "/repos/acme/web/pulls/8"]);
    }),
  );

  it.effect("passes tracking opt-in through native search and pull hydration", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response([{ number: 7 }])))
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              rawPullRequest(7, {
                review_decision: "review-required",
                checks_state: "failing",
              }),
            ),
          ),
        );
      const api = yield* GiteaPullRequestApi.make;
      const page = yield* api.listPullRequests({
        host: "forge.example.test",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "reviewer",
        limit: 1,
        query: "needs review",
        includeTracking: true,
      });

      expect(page.items[0]).toMatchObject({
        reviewDecision: "review-required",
        checksState: "failing",
      });
      expect(callAt(0).path).toContain("include_tracking=true");
      expect(callAt(1).path).toBe("/repos/acme/web/pulls/7?include_tracking=true");
    }),
  );

  it.effect("returns a page-boundary search match without requesting the page after the cap", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation((request) => {
        if (request.path.includes("/pulls/100"))
          return Effect.succeed(response(rawPullRequest(100)));
        const url = new URL(request.path, "https://forge.example.test");
        const page = Number(url.searchParams.get("page"));
        return Effect.succeed(
          response(page === 100 ? [{ number: 100 }] : [{ number: "malformed" }], {
            "x-total-count": "5000",
            link: `<https://forge.example.test/gitea/api/v1/repos/acme/web/issues?type=pulls&q=match&page=${page + 1}&limit=50>; rel="next"`,
          }),
        );
      });
      const api = yield* GiteaPullRequestApi.make;
      const page = yield* api.listPullRequests({
        host: "forge.example.test",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "reviewer",
        limit: 1,
        query: "match",
      });
      const searchPages = mockedRequest.mock.calls
        .map(([request]) => request.path)
        .filter((path) => path.includes("/issues?"))
        .map((path) =>
          Number(new URL(path, "https://forge.example.test").searchParams.get("page")),
        );

      expect(page.items.map((item) => item.number)).toEqual([100]);
      assert.strictEqual(page.consumed, 100);
      assert.isTrue(page.truncated);
      expect(searchPages).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
      assert.strictEqual(mockedRequest.mock.calls.length, 101);
    }),
  );

  it.effect("post-filters merged state and keeps authored search case-insensitive", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response([{ number: 1 }, { number: 2 }])))
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              rawPullRequest(1, {
                state: "closed",
                merged: true,
                user: { login: "AUTHOR" },
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              rawPullRequest(2, {
                state: "closed",
                merged: true,
                user: { login: "other" },
              }),
            ),
          ),
        );
      const api = yield* GiteaPullRequestApi.make;
      const page = yield* api.listPullRequests({
        host: "forge.example.test",
        repository: "acme/web",
        state: "merged",
        involvement: "authored",
        viewer: "author",
        limit: 1,
        query: "release",
      });

      expect(page.items.map((item) => item.number)).toEqual([1]);
      assert.strictEqual(page.consumed, 1);
      assert.isTrue(page.truncated);
      expect(callAt(0).path).toContain("state=closed");
      expect(callAt(0).path).toContain("created_by=author");
    }),
  );

  it.effect("carries a search cursor as a raw-row offset without an updated-time filter", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(response([{ number: 1 }, { number: 2 }], { "x-total-count": "4" })),
        )
        .mockReturnValueOnce(
          Effect.succeed(response([{ number: 3 }, { number: 4 }], { "x-total-count": "4" })),
        )
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(3))))
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(4))));
      const api = yield* GiteaPullRequestApi.make;
      const page = yield* api.listPullRequests({
        host: "forge.example.test",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "reviewer",
        limit: 1,
        query: "cursor",
        cursor: {
          updatedBefore: "2026-09-02T10:10:00.000Z",
          delivered: 2,
        },
      });

      expect(page.items.map((item) => item.number)).toEqual([3]);
      assert.strictEqual(page.consumed, 1);
      assert.isTrue(page.truncated);
      expect(callAt(0).path).toContain("page=1");
      expect(callAt(0).path).not.toContain("updatedBefore");
      expect(callAt(1).path).toContain("page=2");
    }),
  );

  it.effect("fails at the pagination cap when native search has no matching pull request", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation(() =>
        Effect.succeed(response([{ number: "malformed" }], { "x-total-count": "101" })),
      );
      const api = yield* GiteaPullRequestApi.make;
      const error = yield* api
        .listPullRequests({
          host: "forge.example.test",
          repository: "acme/web",
          state: "open",
          involvement: "all",
          viewer: "reviewer",
          limit: 1,
          query: "does-not-exist",
        })
        .pipe(Effect.flip);

      expect(error.detail).toContain("safe page limit");
      assert.strictEqual(mockedRequest.mock.calls.length, 100);
    }),
  );

  it.effect("rescans capped Gitea pages to apply a raw-row cursor without gaps", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              Array.from({ length: 20 }, (_, index) => rawPullRequest(index + 1)),
              {
                link: '<https://forge.example.test/gitea/api/v1/repos/acme/web/pulls?page=2&limit=50>; rel="next"',
                "x-total-count": "40",
              },
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              Array.from({ length: 20 }, (_, index) => rawPullRequest(index + 21)),
              { "x-total-count": "40" },
            ),
          ),
        );
      const api = yield* GiteaPullRequestApi.make;
      const page = yield* api.listPullRequests({
        host: "forge.example.test",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "reviewer",
        limit: 1,
        cursor: {
          updatedBefore: "2026-09-02T10:10:00.000Z",
          delivered: 25,
        },
      });

      expect(page.items.map((item) => item.number)).toEqual([26]);
      assert.strictEqual(page.consumed, 1);
      assert.isTrue(page.truncated);
      assert.strictEqual(mockedRequest.mock.calls.length, 2);
    }),
  );

  it.effect("fails instead of returning an unadvanceable cursor at the page bound", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation(() =>
        Effect.succeed(response([rawPullRequest(1)], { "x-total-count": "101" })),
      );
      const api = yield* GiteaPullRequestApi.make;
      const error = yield* api
        .listPullRequests({
          host: "forge.example.test",
          repository: "acme/web",
          state: "open",
          involvement: "all",
          viewer: "reviewer",
          limit: 1,
          cursor: {
            updatedBefore: "2026-09-02T10:10:00.000Z",
            delivered: 100,
          },
        })
        .pipe(Effect.flip);

      expect(error.detail).toContain("safe page limit");
      assert.strictEqual(mockedRequest.mock.calls.length, 100);
    }),
  );

  it.effect("accepts nullable reviewer and label arrays from Gitea", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response(
            rawPullRequest(7, {
              requested_reviewers: null,
              labels: null,
            }),
          ),
        ),
      );
      const api = yield* GiteaPullRequestApi.make;
      const pullRequest = yield* api.getPullRequest({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
      });

      expect(pullRequest.reviewers).toEqual([]);
      expect(pullRequest.labels).toEqual([]);
    }),
  );

  it.effect("derives merge and branch-update choices from repository settings", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response({
            allow_merge_commits: true,
            allow_squash_merge: false,
            allow_rebase: true,
            allow_merge_update: false,
            allow_rebase_update: true,
            permissions: {
              pull: true,
              push: true,
              admin: false,
            },
          }),
        ),
      );
      const api = yield* GiteaPullRequestApi.make;
      const access = yield* api.getRepositoryAccess({
        host: "forge.example.test",
        repository: "acme/web",
      });

      expect(access).toEqual({
        canWrite: true,
        mergeCapabilities: {
          merge: true,
          squash: false,
          rebase: true,
        },
        updateMethods: ["rebase"],
      });
    }),
  );

  it.effect("does not advertise writes or merge methods from incomplete repository settings", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response({})));
      const api = yield* GiteaPullRequestApi.make;
      const access = yield* api.getRepositoryAccess({
        host: "forge.example.test",
        repository: "acme/web",
      });

      expect(access).toEqual({
        canWrite: false,
        mergeCapabilities: {
          merge: false,
          squash: false,
          rebase: false,
        },
        updateMethods: [],
      });
    }),
  );

  it.effect("reads reviews and anchors resolved stale comments to the correct diff side", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(
            response([
              {
                id: 21,
                body: "Please adjust this.",
                state: "REQUEST_CHANGES",
                submitted_at: "2026-09-03T11:00:00Z",
                stale: true,
                user: {
                  login: "reviewer",
                  full_name: "Reviewer",
                },
              },
            ]),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            response([
              {
                id: 31,
                body: "Rename this.",
                path: "src/old.ts",
                original_position: 8,
                position: 0,
                created_at: "2026-09-03T11:01:00Z",
                resolver: { login: "maintainer" },
                user: { login: "reviewer" },
              },
              {
                id: 32,
                body: "Agreed.",
                path: "src/old.ts",
                original_position: 8,
                position: 0,
                created_at: "2026-09-03T11:02:00Z",
                user: { login: "author" },
              },
            ]),
          ),
        );
      const api = yield* GiteaPullRequestApi.make;
      const activity = yield* api.listReviews({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
      });

      expect(activity.comments).toEqual([
        expect.objectContaining({
          id: "review:21",
          reviewState: "request changes",
        }),
        expect.objectContaining({
          id: "review-comment:31",
          path: "src/old.ts",
        }),
        expect.objectContaining({
          id: "review-comment:32",
          path: "src/old.ts",
        }),
      ]);
      expect(activity.threads).toEqual([
        expect.objectContaining({
          id: "31",
          path: "src/old.ts",
          line: 8,
          side: "left",
          isResolved: true,
          isOutdated: true,
          comments: [
            expect.objectContaining({
              id: "review-comment:31",
            }),
            expect.objectContaining({ id: "review-comment:32" }),
          ],
        }),
      ]);
      expect(callAt(1).path).toBe("/repos/acme/web/pulls/7/reviews/21/comments?page=1&limit=50");
    }),
  );

  it.effect(
    "marks review activity truncated when nested review comments exceed the conversation bound",
    () =>
      Effect.gen(function* () {
        mockedRequest.mockReturnValueOnce(
          Effect.succeed(
            response([
              { id: 21, body: "Review", state: "COMMENT", submitted_at: "2026-09-03T11:00:00Z" },
            ]),
          ),
        );
        for (let page = 0; page < 4; page += 1) {
          mockedRequest.mockReturnValueOnce(
            Effect.succeed(
              response(
                Array.from({ length: 50 }, (_, index) => ({
                  id: 31 + page * 50 + index,
                  body: "Comment",
                  path: "src/a.ts",
                  position: 1,
                  created_at: "2026-09-03T11:01:00Z",
                })),
                { "x-total-count": "501" },
              ),
            ),
          );
        }
        const api = yield* GiteaPullRequestApi.make;
        const result = yield* api.listReviews({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
        });
        assert.isTrue(result.truncated);
        expect(result.comments).toContainEqual(
          expect.objectContaining({ id: "review-comment:31" }),
        );
        expect(result.comments).toHaveLength(201);
        expect(callAt(4).path).toContain("page=4");
        expect(mockedRequest).toHaveBeenCalledTimes(5);
      }),
  );

  it.effect("does not repeat an unpaginated native review-comment response at the page size", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(
            response([
              {
                id: 21,
                body: "Review",
                state: "COMMENT",
                submitted_at: "2026-09-03T11:00:00Z",
              },
            ]),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              Array.from({ length: 51 }, (_, index) => ({
                id: index + 31,
                body: `Comment ${index + 1}`,
                path: "src/a.ts",
                position: index + 1,
                created_at: "2026-09-03T11:01:00Z",
              })),
            ),
          ),
        );
      const api = yield* GiteaPullRequestApi.make;
      const result = yield* api.listReviews({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
      });

      assert.isFalse(result.truncated);
      assert.strictEqual(
        result.comments.filter((comment) => comment.kind === "review-comment").length,
        51,
      );
      assert.strictEqual(mockedRequest.mock.calls.length, 2);
    }),
  );

  it.effect("does not mark an exact unpaginated review-comment safety bound as truncated", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(
            response([
              {
                id: 21,
                body: "Review",
                state: "COMMENT",
                submitted_at: "2026-09-03T11:00:00Z",
              },
            ]),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              Array.from({ length: 200 }, (_, index) => ({
                id: index + 31,
                body: `Comment ${index + 1}`,
                path: "src/a.ts",
                position: index + 1,
                created_at: "2026-09-03T11:01:00Z",
              })),
            ),
          ),
        );
      const api = yield* GiteaPullRequestApi.make;
      const result = yield* api.listReviews({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
      });

      assert.isFalse(result.truncated);
      assert.strictEqual(
        result.comments.filter((comment) => comment.kind === "review-comment").length,
        200,
      );
      assert.strictEqual(mockedRequest.mock.calls.length, 2);
    }),
  );

  it.effect("follows pagination links when Gitea caps comment pages below the limit", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              [
                {
                  id: 1,
                  body: "First",
                  created_at: "2026-09-03T11:00:00Z",
                },
              ],
              {
                link: '</api/v1/repos/acme/web/issues/7/comments?page=2&limit=50>; rel="next"',
              },
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            response([
              {
                id: 2,
                body: "Second",
                created_at: "2026-09-03T11:01:00Z",
              },
            ]),
          ),
        );
      const api = yield* GiteaPullRequestApi.make;
      const result = yield* api.listComments({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
      });

      expect(result.comments.map((comment) => comment.id)).toEqual(["issue:1", "issue:2"]);
      assert.isFalse(result.truncated);
      assert.strictEqual(mockedRequest.mock.calls.length, 2);
    }),
  );

  it.effect("continues past an empty filtered review page when total rows remain", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response([], { "x-total-count": "2" })))
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              [
                {
                  id: 22,
                  body: "Visible review",
                  state: "COMMENT",
                  submitted_at: "2026-09-03T12:00:00Z",
                  user: { login: "reviewer" },
                },
              ],
              { "x-total-count": "1" },
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(response([])));
      const api = yield* GiteaPullRequestApi.make;
      const result = yield* api.listReviews({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
      });

      expect(result.comments).toEqual([
        expect.objectContaining({ id: "review:22", body: "Visible review" }),
      ]);
      expect(callAt(1).path).toContain("page=2");
      assert.isFalse(result.truncated);
    }),
  );

  it.effect("encodes an inline review with native old and new positions", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response({})));
      const api = yield* GiteaPullRequestApi.make;
      yield* api.submitReview({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        verdict: "request-changes",
        body: "Two comments",
        comments: [
          {
            body: "Old line",
            path: "src/a.ts",
            position: { kind: "deleted", oldLine: 4 },
          },
          {
            body: "New line",
            path: "src/b.ts",
            position: { kind: "added", newLine: 9 },
          },
        ],
      });

      expect(decodeJson(callAt(0).body ?? "{}")).toEqual({
        event: "REQUEST_CHANGES",
        body: "Two comments",
        comments: [
          { body: "Old line", path: "src/a.ts", old_position: 4 },
          { body: "New line", path: "src/b.ts", new_position: 9 },
        ],
      });
    }),
  );

  it.effect("maps native warning statuses to failing checks", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response({
            total_count: 1,
            statuses: [{ context: "scan", status: "warning", updated_at: "2026-09-03T11:00:00Z" }],
          }),
        ),
      );
      const api = yield* GiteaPullRequestApi.make;
      const checks = yield* api.listChecks({
        host: "forge.example.test",
        repository: "acme/web",
        sha: "head-sha",
      });
      expect(checks).toEqual([expect.objectContaining({ name: "scan", status: "failure" })]);
    }),
  );

  it.effect("does not request commit statuses without a head revision", () =>
    Effect.gen(function* () {
      const api = yield* GiteaPullRequestApi.make;
      expect(
        yield* api.listChecks({ host: "forge.example.test", repository: "acme/web", sha: "" }),
      ).toEqual([]);
      expect(mockedRequest).not.toHaveBeenCalled();
    }),
  );

  it.effect("reads every capped page of commit statuses and keeps the newest context", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(
          Effect.succeed(
            response({
              total_count: 2,
              statuses: [
                {
                  context: "build",
                  status: "pending",
                  updated_at: "2026-09-03T11:00:00Z",
                },
              ],
            }),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            response({
              total_count: 2,
              statuses: [
                {
                  context: "build",
                  status: "success",
                  updated_at: "2026-09-03T11:01:00Z",
                },
              ],
            }),
          ),
        );
      const api = yield* GiteaPullRequestApi.make;
      const checks = yield* api.listChecks({
        host: "forge.example.test",
        repository: "acme/web",
        sha: "head-sha",
      });

      expect(checks).toEqual([
        expect.objectContaining({
          name: "build",
          status: "success",
        }),
      ]);
      expect(callAt(1).path).toContain("page=2");
    }),
  );

  it.effect("rejects repository and file traversal before any HTTP request", () =>
    Effect.gen(function* () {
      const api = yield* GiteaPullRequestApi.make;
      const repositoryError = yield* api
        .getPullRequest({
          host: "forge.example.test",
          repository: "../private",
          number: 7,
        })
        .pipe(Effect.flip);
      const fileError = yield* api
        .getDiffFileContents({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
          oldPath: "src/file.ts",
          newPath: "../../../other/repo/contents/private.txt",
          changeType: "change",
        })
        .pipe(Effect.flip);

      expect(repositoryError.detail).toContain("owner/name");
      expect(fileError.detail).toContain("without traversal");
      assert.strictEqual(mockedRequest.mock.calls.length, 0);
    }),
  );

  it.effect("loads full files from the exact base and head revisions", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation((request) => {
        if (request.path.endsWith("/pulls/7")) {
          return Effect.succeed(response(rawPullRequest(7)));
        }
        if (request.path.includes("ref=merge-base-sha")) {
          return Effect.succeed(
            response({
              type: "file",
              encoding: "base64",
              content: "YmVmb3JlXG4=",
            }),
          );
        }
        return Effect.succeed(
          response({
            type: "file",
            encoding: "base64",
            content: "YWZ0ZXJcblxu",
          }),
        );
      });
      const api = yield* GiteaPullRequestApi.make;
      const files = yield* api.getDiffFileContents({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        oldPath: "src/old name.ts",
        newPath: "src/new name.ts",
        changeType: "rename-changed",
      });

      expect(files).toEqual({
        oldContents: "before\\n",
        newContents: "after\\n\\n",
      });
      expect(mockedRequest.mock.calls.map(([request]) => request.path)).toEqual(
        expect.arrayContaining([
          "/repos/acme/web/contents/src/old%20name.ts?ref=merge-base-sha",
          "/repos/acme/web/contents/src/new%20name.ts?ref=head-sha",
        ]),
      );
    }),
  );

  it.effect("expands a commit diff from that commit and its first parent", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation((request) => {
        if (request.path.endsWith("/pulls/7")) {
          return Effect.succeed(response(rawPullRequest(7)));
        }
        if (request.path.includes("/git/commits/commit-sha")) {
          return Effect.succeed(
            response({
              sha: "commit-sha",
              parents: [{ sha: "parent-sha" }],
            }),
          );
        }
        if (request.path.includes("ref=parent-sha")) {
          return Effect.succeed(
            response({
              type: "file",
              encoding: "base64",
              content: "b2xk",
            }),
          );
        }
        return Effect.succeed(
          response({
            type: "file",
            encoding: "base64",
            content: "bmV3",
          }),
        );
      });
      const api = yield* GiteaPullRequestApi.make;
      const files = yield* api.getDiffFileContents({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        commit: "commit-sha",
        oldPath: "src/file.ts",
        newPath: "src/file.ts",
        changeType: "change",
      });

      expect(files).toEqual({
        oldContents: "old",
        newContents: "new",
      });
      expect(mockedRequest.mock.calls.map(([request]) => request.path)).toEqual(
        expect.arrayContaining([
          "/repos/acme/web/contents/src/file.ts?ref=parent-sha",
          "/repos/acme/web/contents/src/file.ts?ref=commit-sha",
        ]),
      );
    }),
  );

  it.effect("does not fall back to a mutable branch when a required revision is absent", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(response(rawPullRequest(7, { merge_base: "" }))),
      );
      const api = yield* GiteaPullRequestApi.make;
      const error = yield* api
        .getDiffFileContents({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
          oldPath: "src/file.ts",
          newPath: "src/file.ts",
          changeType: "change",
        })
        .pipe(Effect.flip);

      expect(error.detail).toContain("immutable revision before");
      assert.strictEqual(mockedRequest.mock.calls.length, 1);
    }),
  );

  it.effect("rejects a blank commit revision before reading file contents", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))))
        .mockReturnValueOnce(
          Effect.succeed(
            response({
              sha: "   ",
              parents: [{ sha: "parent-sha" }],
            }),
          ),
        );
      const api = yield* GiteaPullRequestApi.make;
      const error = yield* api
        .getDiffFileContents({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
          commit: "commit-sha",
          oldPath: "src/file.ts",
          newPath: "src/file.ts",
          changeType: "change",
        })
        .pipe(Effect.flip);

      expect(error.detail).toContain("immutable revision after");
      assert.strictEqual(mockedRequest.mock.calls.length, 2);
    }),
  );

  it.effect("posts a general pull request comment to its issue conversation", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response({})));
      const api = yield* GiteaPullRequestApi.make;
      yield* api.comment({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        body: "Looks good overall.",
      });

      expect(callAt(0)).toMatchObject({
        method: "POST",
        path: "/repos/acme/web/issues/7/comments",
      });
      expect(decodeJson(callAt(0).body ?? "{}")).toEqual({
        body: "Looks good overall.",
      });
    }),
  );

  it.effect(
    "edits ordinary and inline review comments through Gitea's issue-comment endpoint",
    () =>
      Effect.gen(function* () {
        mockedRequest
          .mockReturnValueOnce(Effect.succeed(response({})))
          .mockReturnValueOnce(Effect.succeed(response({})));
        const api = yield* GiteaPullRequestApi.make;
        yield* api.updateComment({
          host: "forge.example.test",
          repository: "acme/web",
          commentId: "issue:12",
          body: "Reworded.",
        });
        yield* api.updateComment({
          host: "forge.example.test",
          repository: "acme/web",
          commentId: "review-comment:34",
          body: "Also reworded.",
        });

        expect(callAt(0)).toMatchObject({
          method: "PATCH",
          path: "/repos/acme/web/issues/comments/12",
        });
        expect(callAt(1)).toMatchObject({
          method: "PATCH",
          path: "/repos/acme/web/issues/comments/34",
        });
      }),
  );

  it.effect(
    "reacts to a pull request description and inline review comment through issue routes",
    () =>
      Effect.gen(function* () {
        mockedRequest
          .mockReturnValueOnce(Effect.succeed(response({})))
          .mockReturnValueOnce(Effect.succeed(response({})));
        const api = yield* GiteaPullRequestApi.make;
        yield* api.setReaction({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
          content: "thumbs-up",
          reacted: true,
        });
        yield* api.setReaction({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
          subjectId: "review-comment:34",
          content: "heart",
          reacted: false,
        });

        expect(callAt(0)).toMatchObject({
          method: "POST",
          path: "/repos/acme/web/issues/7/reactions",
        });
        expect(decodeJson(callAt(0).body ?? "{}")).toEqual({ content: "+1" });
        expect(callAt(1)).toMatchObject({
          method: "DELETE",
          path: "/repos/acme/web/issues/comments/34/reactions",
        });
        expect(decodeJson(callAt(1).body ?? "{}")).toEqual({ content: "heart" });
      }),
  );

  it.effect("loads reactions for the pull request and every issue-backed remark", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response({ features: [] })))
        .mockReturnValueOnce(
          Effect.succeed(
            response([
              {
                content: "+1",
                created_at: "2026-09-05T00:00:00Z",
                user: { login: "reader" },
              },
              { content: "+1", user: { login: "teammate" } },
            ]),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(response([{ content: "heart", user: { login: "friend" } }])),
        )
        .mockReturnValueOnce(Effect.succeed(response([])));
      const api = yield* GiteaPullRequestApi.make;
      const reactions = yield* api.listConversationReactions({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        viewer: "Reader",
        subjectIds: ["issue:12", "review-comment:34", "review:21", "issue:12"],
      });

      expect(reactions.pullRequest).toEqual([
        { content: "thumbs-up", count: 2, actors: ["teammate"], viewerHasReacted: true },
      ]);
      expect(reactions.bySubjectId.get("issue:12")).toEqual([
        { content: "heart", count: 1, actors: ["friend"], viewerHasReacted: false },
      ]);
      expect(reactions.bySubjectId.get("review-comment:34")).toEqual([]);
      expect(reactions.bySubjectId.has("review:21")).toBe(false);
      expect(mockedRequest.mock.calls.map((call) => call[0].path)).toEqual([
        "/settings/api",
        "/repos/acme/web/issues/7/reactions?page=1&limit=50",
        "/repos/acme/web/issues/comments/12/reactions?page=1&limit=50",
        "/repos/acme/web/issues/comments/34/reactions?page=1&limit=50",
      ]);
    }),
  );

  it.effect("follows a reaction list when Gitea caps a requested page below its limit", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation((input) => {
        if (input.path === "/settings/api") return Effect.succeed(response({ features: [] }));
        if (input.path === "/repos/acme/web/issues/7/reactions?page=1&limit=50")
          return Effect.succeed(
            response([{ content: "heart", user: { login: "one" } }], { "x-total-count": "2" }),
          );
        if (input.path === "/repos/acme/web/issues/7/reactions?page=2&limit=50")
          return Effect.succeed(
            response([{ content: "eyes", user: { login: "two" } }], { "x-total-count": "2" }),
          );
        return Effect.die(`unexpected request: ${input.path}`);
      });
      const api = yield* GiteaPullRequestApi.make;
      const reactions = yield* api.listConversationReactions({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        viewer: "reader",
        subjectIds: [],
      });
      expect(reactions.pullRequest).toEqual([
        { content: "heart", count: 1, actors: ["one"], viewerHasReacted: false },
        { content: "eyes", count: 1, actors: ["two"], viewerHasReacted: false },
      ]);
    }),
  );

  it.effect("reports Gitea's missing review-summary reaction route", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response({ features: [] })));
      const api = yield* GiteaPullRequestApi.make;
      const error = yield* api
        .setReaction({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
          subjectId: "review:21",
          content: "eyes",
          reacted: true,
        })
        .pipe(Effect.flip);

      expect(error.detail).toContain("review summaries");
      assert.strictEqual(mockedRequest.mock.calls.length, 1);
      assert.strictEqual(callAt(0).path, "/settings/api");
    }),
  );

  it.effect("uses the review-summary reaction route when the server advertises it", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response({ features: ["pull-review-reactions"] })))
        .mockReturnValueOnce(Effect.succeed(response({})));
      const api = yield* GiteaPullRequestApi.make;
      yield* api.setReaction({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        subjectId: "review:21",
        content: "eyes",
        reacted: true,
      });
      expect(callAt(1)).toMatchObject({
        method: "POST",
        path: "/repos/acme/web/pulls/7/reviews/21/reactions",
      });
    }),
  );

  it.effect("preserves existing labels when adding another", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))))
        .mockReturnValueOnce(Effect.succeed(response({})));
      const api = yield* GiteaPullRequestApi.make;
      yield* api.setLabels({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        labels: ["ready"],
        applied: true,
      });

      expect(callAt(1)).toMatchObject({
        method: "PUT",
        path: "/repos/acme/web/issues/7/labels",
      });
      expect(decodeJson(callAt(1).body ?? "{}")).toEqual({
        labels: ["bug", "ready"],
      });
    }),
  );

  it.effect("protects a merge with the freshly read head commit", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))))
        .mockReturnValueOnce(Effect.succeed(response({})));
      const api = yield* GiteaPullRequestApi.make;
      yield* api.runAction({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        action: "merge",
        mergeMethod: "squash",
      });

      expect(callAt(1)).toMatchObject({
        method: "POST",
        path: "/repos/acme/web/pulls/7/merge",
      });
      expect(decodeJson(callAt(1).body ?? "{}")).toEqual({
        do: "squash",
        head_commit_id: "head-sha",
      });
    }),
  );

  it.effect("uses Gitea's native update style and verifies reversible draft transitions", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response({})))
        .mockReturnValueOnce(Effect.succeed(response({ features: [] })))
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))))
        .mockReturnValueOnce(Effect.succeed(response({})))
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              rawPullRequest(7, {
                title: "WIP: Pull request 7",
                draft: true,
              }),
            ),
          ),
        )
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              rawPullRequest(7, {
                title: "WIP: Pull request 7",
                draft: true,
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(response({})))
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))));
      const api = yield* GiteaPullRequestApi.make;
      yield* api.runAction({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        action: "update-branch",
        updateMethod: "rebase",
      });
      yield* api.runAction({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        action: "draft",
      });
      yield* api.runAction({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        action: "ready",
      });

      expect(callAt(0).path).toBe("/repos/acme/web/pulls/7/update?style=rebase");
      expect(decodeJson(callAt(3).body ?? "{}")).toEqual({
        title: "WIP: Pull request 7",
      });
      expect(decodeJson(callAt(6).body ?? "{}")).toEqual({
        title: "Pull request 7",
      });
      assert.strictEqual(mockedRequest.mock.calls.length, 8);
    }),
  );

  it.effect("restores the title when Gitea does not recognize the configured draft prefix", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response({ features: [] })))
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))))
        .mockReturnValueOnce(Effect.succeed(response({})))
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              rawPullRequest(7, {
                title: "WIP: Pull request 7",
                draft: false,
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(response({})));
      const api = yield* GiteaPullRequestApi.make;
      const error = yield* api
        .runAction({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
          action: "draft",
        })
        .pipe(Effect.flip);

      expect(error.detail).toContain("T3CODE_GITEA_DRAFT_PREFIXES");
      expect(decodeJson(callAt(4).body ?? "{}")).toEqual({
        title: "Pull request 7",
      });
    }),
  );

  it.effect("reads armed auto-merge state from Gitea's durable timeline events", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response({ features: [] })))
        .mockReturnValueOnce(
          Effect.succeed(
            response([
              { id: 10, type: "pull_scheduled_merge" },
              { id: 11, type: "comment" },
              { id: 12, type: "pull_cancel_scheduled_merge" },
              { id: 13, type: "pull_scheduled_merge" },
            ]),
          ),
        );
      const api = yield* GiteaPullRequestApi.make;

      assert.isTrue(
        yield* api.getAutoMergeEnabled({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
        }),
      );
      expect(callAt(1).path).toBe("/repos/acme/web/issues/7/timeline?page=1&limit=50");
    }),
  );

  it.effect("paginates the timeline before deciding that auto-merge is armed", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response({ features: [] })))
        .mockReturnValueOnce(
          Effect.succeed(
            response(
              Array.from({ length: 50 }, (_, id) => ({
                id,
                type: "comment",
              })),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(response([{ id: 51, type: "pull_scheduled_merge" }])));
      const api = yield* GiteaPullRequestApi.make;

      assert.isTrue(
        yield* api.getAutoMergeEnabled({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
        }),
      );
      expect(callAt(2).path).toContain("page=2");
    }),
  );

  it.effect("honors a server timeline page-size cap before reading the final merge state", () =>
    Effect.gen(function* () {
      mockedRequest.mockReturnValueOnce(Effect.succeed(response({ features: [] })));
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response([{ id: 1, type: "pull_scheduled_merge" }], { "x-total-count": "2" }),
        ),
      );
      mockedRequest.mockReturnValueOnce(
        Effect.succeed(
          response([{ id: 2, type: "pull_cancel_scheduled_merge" }], { "x-total-count": "2" }),
        ),
      );
      const api = yield* GiteaPullRequestApi.make;
      assert.isFalse(
        yield* api.getAutoMergeEnabled({
          host: "forge.example.test",
          repository: "acme/web",
          number: 7,
        }),
      );
      expect(callAt(2).path).toContain("page=2");
    }),
  );

  it.effect("includes requested native teams in reviewer candidates and sends their names", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation((input) => {
        if (input.path === "/repos/acme/web/pulls/7")
          return Effect.succeed(
            response(
              rawPullRequest(7, {
                requested_reviewers_teams: [
                  { id: 41, name: "maintainers", organization: { username: "acme" } },
                ],
              }),
            ),
          );
        if (input.path.startsWith("/repos/acme/web/reviewers?"))
          return Effect.succeed(response([{ id: 2, login: "reviewer" }]));
        if (input.path === "/repos/acme/web/teams")
          return Effect.succeed(
            response([{ id: 41, name: "maintainers", organization: { username: "acme" } }]),
          );
        if (input.path === "/repos/acme/web/pulls/7/requested_reviewers")
          return Effect.succeed(response({}));
        return Effect.die(`unexpected request: ${input.path}`);
      });
      const api = yield* GiteaPullRequestApi.make;
      const candidates = yield* api.listReviewerCandidates({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
      });

      expect(candidates).toEqual({
        candidates: [
          expect.objectContaining({ id: "reviewer", kind: "user", isRequested: true }),
          expect.objectContaining({
            id: "maintainers",
            kind: "team",
            login: "maintainers",
            name: "acme",
            isRequested: true,
          }),
        ],
        truncated: false,
      });
      yield* api.setReviewerRequest({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        requested: true,
        reviewers: [candidates.candidates[1]!],
      });
      const request = callAt(3);
      expect(decodeJson(request.body ?? "{}")).toEqual({
        reviewers: [],
        team_reviewers: ["maintainers"],
      });
    }),
  );

  it.effect("treats a native repository team 405 as a personal repository", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation((input) => {
        if (input.path === "/repos/acme/web/pulls/7")
          return Effect.succeed(response(rawPullRequest(7)));
        if (input.path.startsWith("/repos/acme/web/reviewers?"))
          return Effect.succeed(response([{ id: 2, login: "reviewer" }]));
        if (input.path === "/repos/acme/web/teams")
          return Effect.fail(
            new GiteaApi.GiteaApiError({
              operation: "listTeamReviewerCandidates",
              reason: "failed",
              detail: "Gitea returned HTTP 405.",
              status: 405,
            }),
          );
        return Effect.die(`unexpected request: ${input.path}`);
      });
      const api = yield* GiteaPullRequestApi.make;
      const candidates = yield* api.listReviewerCandidates({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
      });

      expect(candidates.candidates).toEqual([
        expect.objectContaining({ id: "reviewer", kind: "user" }),
      ]);
    }),
  );

  it.effect("includes pull requests requested from a viewer team in reviewing listings", () =>
    Effect.gen(function* () {
      mockedRequest.mockImplementation((input) => {
        if (input.path === "/user/teams?page=1&limit=50")
          return Effect.succeed(response([{ id: 4, name: "first" }], { "x-total-count": "2" }));
        if (input.path === "/user/teams?page=2&limit=50")
          return Effect.succeed(
            response([{ id: 9, name: "maintainers" }], { "x-total-count": "2" }),
          );
        if (input.path.startsWith("/repos/acme/web/pulls?"))
          return Effect.succeed(
            response(
              [
                rawPullRequest(7, {
                  requested_reviewers: [],
                  requested_reviewers_teams: [{ id: 9, name: "maintainers" }],
                }),
              ],
              { "x-total-count": "1" },
            ),
          );
        return Effect.die(`unexpected request: ${input.path}`);
      });
      const api = yield* GiteaPullRequestApi.make;
      const page = yield* api.listPullRequests({
        host: "forge.example.test",
        repository: "acme/web",
        state: "open",
        involvement: "reviewing",
        viewer: "viewer",
        limit: 10,
      });

      expect(page.items.map((pullRequest) => pullRequest.number)).toEqual([7]);
      assert.strictEqual(mockedRequest.mock.calls.length, 3);
    }),
  );

  it.effect("arms and cancels Gitea auto-merge through the native merge route", () =>
    Effect.gen(function* () {
      mockedRequest
        .mockReturnValueOnce(Effect.succeed(response(rawPullRequest(7))))
        .mockReturnValueOnce(Effect.succeed(response({})))
        .mockReturnValueOnce(Effect.succeed(response({})));
      const api = yield* GiteaPullRequestApi.make;
      yield* api.runAction({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        action: "enable-auto-merge",
        mergeMethod: "squash",
      });
      yield* api.runAction({
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
        action: "disable-auto-merge",
      });

      expect(callAt(1)).toMatchObject({
        method: "POST",
        path: "/repos/acme/web/pulls/7/merge",
      });
      expect(decodeJson(callAt(1).body ?? "{}")).toEqual({
        do: "squash",
        head_commit_id: "head-sha",
        merge_when_checks_succeed: true,
      });
      expect(callAt(2)).toMatchObject({
        method: "DELETE",
        path: "/repos/acme/web/pulls/7/merge",
      });
    }),
  );
});
