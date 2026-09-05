import { assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import { isCurrentPullWorkflow, list } from "./GiteaWorkflows.ts";

const run = {
  id: 7,
  needs_approval: true,
  pull_request_head_sha: "contributor-head",
  head_sha: "synthetic-merge",
  event: "pull_request",
  html_url: "https://forge.test/org/repo/actions/runs/7",
  pull_requests: [{ number: 3 }],
};
const input = { repository: "org/repo", number: 3, headSha: "contributor-head" };

it("matches the recorded contributor commit rather than a synthetic merge revision", () => {
  assert.isTrue(isCurrentPullWorkflow(run, input));
  for (const candidate of [
    { ...run, needs_approval: false },
    { ...run, pull_request_head_sha: "previous-head" },
    { ...run, pull_request_head_sha: undefined },
    { ...run, pull_requests: [{ number: 4 }] },
    { ...run, event: "push" },
  ])
    assert.isFalse(isCurrentPullWorkflow(candidate, input));
});

it.effect("reads capped pages completely and selects only this PR's current blocked runs", () =>
  Effect.gen(function* () {
    const request = vi.fn<GiteaApi.GiteaApi["Service"]["request"]>();
    request.mockReturnValueOnce(
      Effect.succeed({
        body: JSON.stringify({
          total_count: 2,
          workflow_runs: [{ ...run, pull_request_head_sha: "old" }],
        }),
        truncated: false,
        headers: {},
      }),
    );
    request.mockReturnValueOnce(
      Effect.succeed({
        body: JSON.stringify({ total_count: 2, workflow_runs: [run] }),
        truncated: false,
        headers: {},
      }),
    );
    const api = GiteaApi.GiteaApi.of({
      baseUrl: Option.some("https://forge.test"),
      request,
      probeAuth: Effect.die("not used"),
    });
    expect(yield* list(api, input)).toEqual([run]);
    expect(request.mock.calls[1]?.[0].path).toContain("page=2");
  }),
);

it.effect("fails incomplete pagination instead of reporting no approvals", () =>
  Effect.gen(function* () {
    const request = vi.fn<GiteaApi.GiteaApi["Service"]["request"]>(() =>
      Effect.succeed({
        body: JSON.stringify({ total_count: 1, workflow_runs: [] }),
        truncated: false,
        headers: {},
      }),
    );
    const api = GiteaApi.GiteaApi.of({
      baseUrl: Option.some("https://forge.test"),
      request,
      probeAuth: Effect.die("not used"),
    });
    assert.strictEqual((yield* list(api, input).pipe(Effect.flip)).reason, "failed");
  }),
);
