import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GiteaApi from "./GiteaApi.ts";
import * as GiteaSourceControlProvider from "./GiteaSourceControlProvider.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const encodeBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const repository = {
  full_name: "team/repo",
  clone_url: "https://forge.example.test/team/repo.git",
  ssh_url: "git@forge.example.test:team/repo.git",
  default_branch: "develop",
};
const context = {
  provider: { kind: "gitea" as const, name: "Gitea", baseUrl: "https://forge.example.test" },
  remoteName: "origin",
  remoteUrl: repository.ssh_url,
};
function pull(number = 42, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: "A Gitea PR",
    html_url: `https://forge.example.test/team/repo/pulls/${number}`,
    state: "open",
    merged: false,
    draft: false,
    updated_at: "2026-09-04T00:00:00Z",
    head: { ref: "feature", repo: repository },
    base: { ref: "develop", repo: repository },
    ...overrides,
  };
}
function setup(
  respond: (input: Parameters<GiteaApi.GiteaApi["Service"]["request"]>[0]) => {
    readonly body: unknown;
    readonly headers?: Record<string, string>;
  },
) {
  const request = vi.fn<GiteaApi.GiteaApi["Service"]["request"]>((input) => {
    const result = respond(input);
    return Effect.succeed({
      body: encodeBody(result.body),
      headers: result.headers ?? {},
      truncated: false,
    });
  });
  const fetchBranch = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteBranch"]>(
    () => Effect.void,
  );
  const fetchTracking = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]>(
    () => Effect.void,
  );
  const ensureRemote = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["ensureRemote"]>(() =>
    Effect.succeed("fork"),
  );
  const switchRef = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["switchRef"]>((input) =>
    Effect.succeed({ refName: input.refName }),
  );
  const localBranches = vi.fn<GitVcsDriver.GitVcsDriver["Service"]["listLocalBranchNames"]>(() =>
    Effect.succeed([]),
  );
  const provider = GiteaSourceControlProvider.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GiteaApi.GiteaApi)({
          baseUrl: Option.some("https://forge.example.test"),
          request,
        }),
        FileSystem.layerNoop({ readFileString: () => Effect.succeed("PR body") }),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          fetchRemoteBranch: fetchBranch,
          fetchRemoteTrackingBranch: fetchTracking,
          ensureRemote,
          switchRef,
          listLocalBranchNames: localBranches,
          setBranchUpstream: () => Effect.void,
        }),
      ),
    ),
  );
  return { provider, request, fetchBranch, fetchTracking, ensureRemote, switchRef, localBranches };
}

it.effect("maps merged state, draft and deleted source repository accurately", () => {
  const { provider } = setup(() => ({
    body: pull(42, {
      state: "closed",
      merged: true,
      draft: true,
      head: { ref: "feature", repo: null },
    }),
  }));
  return Effect.gen(function* () {
    const result = yield* (yield* provider).getChangeRequest({
      cwd: "/repo",
      context,
      reference: "42",
    });
    assert.strictEqual(result.state, "merged");
    assert.isTrue(result.isDraft);
    assert.isTrue(result.isCrossRepository);
    assert.isNull(result.headRepositoryNameWithOwner);
  });
});

it.effect("compares repository identities case-insensitively", () => {
  const { provider } = setup(() => ({
    body: pull(42, {
      head: { ref: "feature", repo: { ...repository, full_name: "TEAM/REPO" } },
      base: { ref: "develop", repo: { ...repository, full_name: "team/repo" } },
    }),
  }));
  return Effect.gen(function* () {
    const result = yield* (yield* provider).getChangeRequest({
      cwd: "/repo",
      context,
      reference: "42",
    });
    assert.isFalse(result.isCrossRepository);
  });
});

it.effect("finds branch matches beyond a short server-capped page", () => {
  const { provider, request } = setup((input) =>
    input.path.includes("page=1")
      ? {
          body: [pull(1, { head: { ref: "unrelated", repo: repository } })],
          headers: {
            "x-total-count": "2",
            link: '</api/v1/repos/team/repo/pulls?page=2>; rel="next"',
          },
        }
      : { body: [pull(2)], headers: { "x-total-count": "2" } },
  );
  return Effect.gen(function* () {
    const results = yield* (yield* provider).listChangeRequests({
      cwd: "/repo",
      context,
      headSelector: "feature",
      state: "open",
    });
    assert.deepStrictEqual(
      results.map((item) => item.number),
      [2],
    );
    assert.strictEqual(request.mock.calls.length, 2);
  });
});

it.effect("stops at the requested limit when a branch match appears on page 100", () => {
  const { provider, request } = setup((input) => {
    const page = Number(new URL(input.path, context.provider.baseUrl).searchParams.get("page"));
    return page < 100
      ? {
          body: [pull(page, { head: { ref: "unrelated", repo: repository } })],
          headers: {
            "x-total-count": "5000",
            link: `<${context.provider.baseUrl}/api/v1/repos/team/repo/pulls?page=${page + 1}>; rel="next"`,
          },
        }
      : {
          body: [pull(100)],
          headers: {
            "x-total-count": "5000",
            link: `<${context.provider.baseUrl}/api/v1/repos/team/repo/pulls?page=101>; rel="next"`,
          },
        };
  });
  return Effect.gen(function* () {
    const results = yield* (yield* provider).listChangeRequests({
      cwd: "/repo",
      context,
      headSelector: "feature",
      state: "open",
      limit: 1,
    });
    const pages = request.mock.calls.map(([input]) =>
      Number(new URL(input.path, context.provider.baseUrl).searchParams.get("page")),
    );
    assert.deepStrictEqual(
      results.map((item) => item.number),
      [100],
    );
    assert.strictEqual(pages.length, 100);
    assert.strictEqual(pages[99], 100);
  });
});

it.effect("uses a default listing limit of 20", () => {
  const { provider, request } = setup(() => ({
    body: Array.from({ length: 21 }, (_, index) => pull(index + 1)),
  }));
  return Effect.gen(function* () {
    const results = yield* (yield* provider).listChangeRequests({
      cwd: "/repo",
      context,
      headSelector: "feature",
      state: "open",
    });
    assert.strictEqual(results.length, 20);
    assert.strictEqual(request.mock.calls.length, 1);
  });
});

it.effect("fails clearly after 100 pages when no branch matches", () => {
  const { provider, request } = setup((input) => {
    const page = Number(new URL(input.path, context.provider.baseUrl).searchParams.get("page"));
    return {
      body: [pull(page, { head: { ref: "unrelated", repo: repository } })],
      headers: {
        "x-total-count": "5000",
        link: `<${context.provider.baseUrl}/api/v1/repos/team/repo/pulls?page=${page + 1}>; rel="next"`,
      },
    };
  });
  return Effect.gen(function* () {
    const error = yield* (yield* provider)
      .listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "feature",
        state: "open",
        limit: 1,
      })
      .pipe(Effect.flip);
    assert.strictEqual(error.detail, "Too many Gitea PR pages to resolve this branch reliably.");
    assert.strictEqual(request.mock.calls.length, 100);
  });
});

it.effect("returns no results without requesting pages when the limit is zero", () => {
  const { provider, request } = setup(() => ({ body: [pull()] }));
  return Effect.gen(function* () {
    const results = yield* (yield* provider).listChangeRequests({
      cwd: "/repo",
      context,
      headSelector: "feature",
      state: "open",
      limit: 0,
    });
    assert.deepStrictEqual(results, []);
    assert.strictEqual(request.mock.calls.length, 0);
  });
});

it.effect("filters merged and closed results after querying Gitea's closed PRs", () => {
  const { provider, request } = setup(() => ({
    body: [pull(1, { state: "closed", merged: true }), pull(2, { state: "closed", merged: false })],
  }));
  return Effect.gen(function* () {
    const merged = yield* (yield* provider).listChangeRequests({
      cwd: "/repo",
      context,
      headSelector: "feature",
      state: "merged",
      limit: 10,
    });
    const closed = yield* (yield* provider).listChangeRequests({
      cwd: "/repo",
      context,
      headSelector: "feature",
      state: "closed",
      limit: 10,
    });
    assert.deepStrictEqual(
      merged.map((item) => item.number),
      [1],
    );
    assert.deepStrictEqual(
      closed.map((item) => item.number),
      [2],
    );
    assert.strictEqual(
      new URL(request.mock.calls[0]?.[0].path ?? "", context.provider.baseUrl).searchParams.get(
        "state",
      ),
      "closed",
    );
    assert.strictEqual(
      new URL(request.mock.calls[1]?.[0].path ?? "", context.provider.baseUrl).searchParams.get(
        "state",
      ),
      "closed",
    );
  });
});

it.effect("distinguishes identical branch names in different forks", () => {
  const { provider } = setup(() => ({
    body: [
      pull(1, { head: { ref: "feature", repo: { ...repository, full_name: "other/repo" } } }),
      pull(2),
    ],
  }));
  return Effect.gen(function* () {
    const results = yield* (yield* provider).listChangeRequests({
      cwd: "/repo",
      context,
      headSelector: "team:feature",
      state: "open",
    });
    assert.deepStrictEqual(
      results.map((item) => item.number),
      [2],
    );
  });
});

it.effect("matches source owners case-insensitively", () => {
  const { provider } = setup(() => ({
    body: [
      pull(1, {
        head: { ref: "feature", repo: { ...repository, full_name: "AUTHOR/REPO" } },
      }),
    ],
  }));
  return Effect.gen(function* () {
    const results = yield* (yield* provider).listChangeRequests({
      cwd: "/repo",
      context,
      headSelector: "author:feature",
      state: "open",
    });
    assert.deepStrictEqual(
      results.map((item) => item.number),
      [1],
    );
  });
});

it.effect("uses the repository default branch and native clone URLs", () => {
  const { provider } = setup(() => ({ body: repository }));
  return Effect.gen(function* () {
    const service = yield* provider;
    assert.strictEqual(yield* service.getDefaultBranch({ cwd: "/repo", context }), "develop");
    assert.deepStrictEqual(
      yield* service.getRepositoryCloneUrls({ cwd: "/repo", context, repository: "team/repo" }),
      { nameWithOwner: "team/repo", url: repository.clone_url, sshUrl: repository.ssh_url },
    );
  });
});

it.effect("rejects a mismatched host before transmitting credentials", () => {
  const { provider, request } = setup(() => ({ body: repository }));
  return Effect.gen(function* () {
    const error = yield* (yield* provider)
      .getChangeRequest({
        cwd: "/repo",
        context: { ...context, remoteUrl: "git@elsewhere.test:team/repo.git" },
        reference: "42",
      })
      .pipe(Effect.flip);
    assert.include(error.detail, "does not belong");
    assert.strictEqual(request.mock.calls.length, 0);
  });
});

it.effect("creates PRs with the selected source owner and base ref", () => {
  const { provider, request } = setup(() => ({ body: pull() }));
  return Effect.gen(function* () {
    yield* (yield* provider).createChangeRequest({
      cwd: "/repo",
      context,
      headSelector: "author:feature",
      baseRefName: "develop",
      title: "PR title",
      bodyFile: "/tmp/body",
    });
    const call = request.mock.calls[0]?.[0];
    assert.strictEqual(call?.method, "POST");
    const body = yield* decodeBody(call?.body);
    assert.deepStrictEqual(body, {
      title: "PR title",
      body: "PR body",
      head: "author:feature",
      base: "develop",
    });
  });
});

it.effect("qualifies a fork source when only the target owner is selected", () => {
  const { provider, request } = setup(() => ({ body: pull() }));
  return Effect.gen(function* () {
    yield* (yield* provider).createChangeRequest({
      cwd: "/repo",
      context: { ...context, remoteUrl: "git@forge.example.test:fork/repo.git" },
      target: { owner: "upstream", refName: "develop" },
      headSelector: "feature",
      baseRefName: "main",
      title: "Fork PR",
      bodyFile: "/tmp/body",
    });
    const call = request.mock.calls[0]?.[0];
    const body = yield* decodeBody(call?.body);
    assert.strictEqual(call?.path, "/repos/upstream/repo/pulls");
    assert.deepStrictEqual(body, {
      title: "Fork PR",
      body: "PR body",
      head: "fork:feature",
      base: "develop",
    });
  });
});

it.effect("publishes under the authenticated user or an explicit organization", () => {
  const { provider, request } = setup((input) => ({
    body: input.path === "/user" ? { login: "team" } : repository,
  }));
  return Effect.gen(function* () {
    const service = yield* provider;
    yield* service.createRepository({
      cwd: "/repo",
      repository: "team/repo",
      visibility: "private",
    });
    assert.strictEqual(request.mock.calls[1]?.[0].path, "/user/repos");
    yield* service.createRepository({
      cwd: "/repo",
      repository: "organization/repo",
      visibility: "public",
    });
    assert.strictEqual(request.mock.calls[3]?.[0].path, "/orgs/organization/repos");
  });
});

it.effect("checks out a fork through its source repository using the existing Git driver", () => {
  const fork = {
    ...repository,
    full_name: "author/repo",
    ssh_url: "git@forge.example.test:author/repo.git",
  };
  const { provider, ensureRemote, fetchBranch, switchRef } = setup(() => ({
    body: pull(42, { head: { ref: "Feature/Needs Review", repo: fork } }),
  }));
  return Effect.gen(function* () {
    yield* (yield* provider).checkoutChangeRequest({ cwd: "/repo", context, reference: "42" });
    assert.strictEqual(ensureRemote.mock.calls[0]?.[0].preferredName, "author");
    assert.strictEqual(ensureRemote.mock.calls[0]?.[0].url, fork.ssh_url);
    assert.strictEqual(fetchBranch.mock.calls[0]?.[0].remoteBranch, "Feature/Needs Review");
    assert.strictEqual(
      fetchBranch.mock.calls[0]?.[0].localBranch,
      "t3code/pr-42/feature/needs-review",
    );
    assert.strictEqual(switchRef.mock.calls[0]?.[0].refName, "t3code/pr-42/feature/needs-review");
  });
});

it.effect("preserves an existing local branch unless force is requested", () => {
  const { provider, fetchBranch, fetchTracking, localBranches } = setup(() => ({ body: pull() }));
  localBranches.mockReturnValue(Effect.succeed(["feature"]));
  return Effect.gen(function* () {
    yield* (yield* provider).checkoutChangeRequest({ cwd: "/repo", context, reference: "42" });
    assert.strictEqual(fetchBranch.mock.calls.length, 0);
    assert.strictEqual(fetchTracking.mock.calls.length, 1);
  });
});

it.effect("refuses checkout of a deleted source repository", () => {
  const { provider, fetchBranch } = setup(() => ({
    body: pull(42, { head: { ref: "feature", repo: null } }),
  }));
  return Effect.gen(function* () {
    const error = yield* (yield* provider)
      .checkoutChangeRequest({ cwd: "/repo", context, reference: "42" })
      .pipe(Effect.flip);
    assert.include(error.detail, "deleted or is inaccessible");
    assert.strictEqual(fetchBranch.mock.calls.length, 0);
  });
});

it.effect("rejects invalid pull request timestamps at the API boundary", () => {
  const { provider } = setup(() => ({ body: pull(42, { updated_at: "not-a-date" }) }));
  return Effect.gen(function* () {
    const error = yield* (yield* provider).getChangeRequest({cwd: "/repo", context, reference: "42"}).pipe(Effect.flip);
    assert.strictEqual(error._tag, "SourceControlProviderError");
  });
});
