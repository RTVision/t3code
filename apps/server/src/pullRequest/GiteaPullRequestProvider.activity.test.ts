import { assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import * as GiteaPullRequestApi from "./GiteaPullRequestApi.ts";
import * as GiteaPullRequestProvider from "./GiteaPullRequestProvider.ts";

const request = vi.fn<GiteaApi.GiteaApi["Service"]["request"]>();

const response = (value: unknown) => ({
  body: JSON.stringify(value),
  truncated: false,
  headers: {},
});
const failure = () =>
  Effect.fail(new GiteaApi.GiteaApiError({ operation: "test", reason: "failed", detail: "offline" }));

const pull = {
  number: 7,
  title: "PR",
  body: "body",
  state: "open",
  merged: false,
  draft: false,
  html_url: "https://forge.example.test/acme/web/pulls/7",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  base: { ref: "main", sha: "base", repo: { full_name: "acme/web" } },
  head: { ref: "feature", sha: "head", repo: { full_name: "acme/web" } },
};

const apiLayer = GiteaPullRequestApi.layer.pipe(
  Layer.provide(
    Layer.succeed(
      GiteaApi.GiteaApi,
      GiteaApi.GiteaApi.of({
        baseUrl: Option.some("https://forge.example.test"),
        request,
        probeAuth: Effect.die("unused"),
      }),
    ),
  ),
);

function route(viewerFails: boolean, reactionsFail: boolean) {
  request.mockImplementation((input) => {
    if (input.path === "/user")
      return viewerFails ? failure() : Effect.succeed(response({ login: "reader" }));
    if (input.path === "/settings/api") return Effect.succeed(response({ features: [] }));
    if (input.path === "/repos/acme/web/pulls/7") return Effect.succeed(response(pull));
    if (input.path === "/repos/acme/web/issues/7/comments?page=1&limit=50")
      return Effect.succeed(
        response([{ id: 1, body: "ordinary", created_at: "2026-01-01T00:00:00Z" }]),
      );
    if (input.path === "/repos/acme/web/pulls/7/reviews?page=1&limit=50")
      return Effect.succeed(
        response([{ id: 2, body: "summary", submitted_at: "2026-01-01T00:00:00Z" }]),
      );
    if (input.path === "/repos/acme/web/pulls/7/reviews/2/comments")
      return Effect.succeed(
        response([
          { id: 3, body: "inline", created_at: "2026-01-01T00:00:00Z", path: "a.ts", position: 1 },
        ]),
      );
    if (input.path === "/repos/acme/web/pulls/7/commits?page=1&limit=50")
      return Effect.succeed(response([]));
    if (input.path.includes("/reactions?"))
      return reactionsFail ? failure() : Effect.succeed(response([]));
    return Effect.die(`unexpected ${input.path}`);
  });
}

for (const [name, viewerFails, reactionsFail] of [
  ["viewer", true, false],
  ["reactions", false, true],
] as const) {
  it.effect(`keeps loaded conversation when ${name} enrichment fails`, () =>
    Effect.gen(function* () {
      route(viewerFails, reactionsFail);
      const provider = yield* GiteaPullRequestProvider.make.pipe(Effect.provide(apiLayer));
      const activity = yield* provider.getChangeRequestActivity({
        cwd: "/tmp",
        host: "forge.example.test",
        repository: "acme/web",
        number: 7,
      });
      expect(activity.comments.map((comment) => comment.body)).toEqual([
        "ordinary",
        "summary",
        "inline",
      ]);
      assert.strictEqual(activity.reviewThreads[0]?.comments[0]?.body, "inline");
    }),
  );
}
