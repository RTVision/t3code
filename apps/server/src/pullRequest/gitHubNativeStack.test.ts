import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeGitHubNativeStackRead } from "./gitHubNativeStack.ts";

const input = { cwd: "/w", repository: "acme/web", host: "github.com", number: 2, limit: 100 };
const repo = { url: "https://api.github.com/repos/acme/web" };
const member = (number: number) => ({
  number,
  title: `Change ${number}`,
  html_url: `https://github.com/acme/web/pull/${number}`,
  state: "open",
  draft: false,
  merged_at: null as string | null,
  head: { ref: `branch-${number}`, repo },
  base: { ref: number === 1 ? "main" : `branch-${number - 1}`, repo },
});
const stack = (members = [member(1), member(2)]) => ({
  number: 6,
  node_id: "PRS_6",
  pull_requests: members,
});
function fixture(responses: ReadonlyArray<unknown>, truncated = false) {
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  const encoded = responses.map((response) => encode(response));
  const requests: ReadonlyArray<string>[] = [];
  const read = makeGitHubNativeStackRead((request) =>
    Effect.sync(() => {
      requests.push(request.args);
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: encoded[requests.length - 1] ?? "",
        stderr: "",
        stdoutTruncated: truncated,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
      };
    }),
  );
  return { read, requests };
}

it.effect(
  "reads an exact membership and preserves merged roots with qualified source identity",
  () =>
    Effect.gen(function* () {
      const root = { ...member(1), state: "closed", merged_at: "2026-09-01T00:00:00Z" };
      const { read, requests } = fixture([[{ number: 6 }], stack([root, member(2)])]);
      const result = yield* read(input);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toContain("repos/acme/web/stacks?pull_request=2&per_page=2&page=1");
      expect(result.status).toBe("present");
      if (result.status !== "present") return;
      expect(
        result.members.map((pr) => [pr.number, pr.state, pr.headRepositoryNameWithOwner]),
      ).toEqual([
        [1, "merged", "acme/web"],
        [2, "open", "acme/web"],
      ]);
      expect(result.coverage).toBe("complete");
    }),
);

it.effect("only a successful empty exact lookup establishes no native stack", () =>
  Effect.gen(function* () {
    const { read, requests } = fixture([[]]);
    expect(yield* read(input)).toEqual({ status: "none" });
    expect(requests).toHaveLength(1);
    const broken = fixture([[{ number: 6 }]], true);
    expect(Result.isFailure(yield* Effect.result(broken.read(input)))).toBe(true);
  }),
);

it.effect("bounds native membership while retaining the selected member", () =>
  Effect.gen(function* () {
    const { read } = fixture([[{ number: 6 }], stack([member(1), member(2), member(3)])]);
    const result = yield* read({ ...input, number: 3, limit: 2 });
    expect(result.status).toBe("present");
    if (result.status !== "present") return;
    expect(result.members.map((pr) => pr.number)).toEqual([2, 3]);
    expect(result.coverage).toBe("partial");
  }),
);

it.effect(
  "rejects mismatched repositories, duplicate members, missing focus and ambiguous membership",
  () =>
    Effect.gen(function* () {
      const foreign = {
        ...member(2),
        base: { ref: "main", repo: { url: "https://api.github.com/repos/other/web" } },
      };
      for (const responses of [
        [[{ number: 6 }], stack([member(1), foreign])],
        [[{ number: 6 }], stack([member(2), member(2)])],
        [[{ number: 6 }], stack([member(1)])],
        [[{ number: 6 }], stack([{ ...member(2), title: " " }])],
        [[{ number: 6 }], { ...stack(), node_id: "" }],
        [[{ number: 6 }, { number: 7 }]],
      ]) {
        const { read } = fixture(responses);
        expect(Result.isFailure(yield* Effect.result(read(input)))).toBe(true);
      }
    }),
);

it.effect("does not infer source identity from membership or a different API host", () =>
  Effect.gen(function* () {
    const fork = {
      ...member(1),
      head: { ref: "branch-1", repo: { url: "https://api.github.com/repos/fork/web" } },
    };
    const unknown = {
      ...member(2),
      head: { ref: "branch-2", repo: { url: "https://other.example/repos/acme/web" } },
    };
    const { read } = fixture([[{ number: 6 }], stack([fork, unknown])]);
    const result = yield* read(input);
    if (result.status !== "present") return yield* Effect.die("expected native members");
    expect(result.members.map((pr) => pr.headRepositoryNameWithOwner)).toEqual(["fork/web", null]);
  }),
);

it.effect("leaves unverified enterprise hosts unavailable without an API request", () =>
  Effect.gen(function* () {
    const { read, requests } = fixture([]);
    expect(Result.isFailure(yield* Effect.result(read({ ...input, host: "git.acme.test" })))).toBe(
      true,
    );
    expect(requests).toHaveLength(0);
  }),
);
