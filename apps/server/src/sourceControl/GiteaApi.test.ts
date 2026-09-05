import { assert, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as GiteaApi from "./GiteaApi.ts";

function makeLayer(
  input: {
    readonly env?: Record<string, string>;
    readonly response?: (request: HttpClientRequest.HttpClientRequest) => Response;
  } = {},
) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        input.response?.(request) ?? Response.json({ login: "reviewer" }),
      ),
    ),
  );
  const layer = GiteaApi.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: input.env ?? {
            T3CODE_GITEA_BASE_URL: "https://forge.example.test/gitea",
            T3CODE_GITEA_TOKEN: "test-token",
          },
        }),
      ),
    ),
  );
  return { layer, execute };
}

it.effect("authenticates against the configured host and proxy subpath", () => {
  const { layer, execute } = makeLayer();
  return Effect.gen(function* () {
    const api = yield* GiteaApi.GiteaApi;
    const auth = yield* api.probeAuth;
    assert.strictEqual(auth.status, "authenticated");
    assert.deepStrictEqual(auth.account, Option.some("reviewer"));
    assert.deepStrictEqual(auth.host, Option.some("forge.example.test"));
    const request = execute.mock.calls[0]?.[0];
    assert.strictEqual(request?.url, "https://forge.example.test/gitea/api/v1/user");
    assert.strictEqual(request?.headers.authorization, "token test-token");
  }).pipe(Effect.provide(layer));
});

it.effect("does not report configuration alone as authenticated", () => {
  const { layer, execute } = makeLayer({ env: {} });
  return Effect.gen(function* () {
    const api = yield* GiteaApi.GiteaApi;
    assert.strictEqual((yield* api.probeAuth).status, "unauthenticated");
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("rejects blank credentials without sending a request", () => {
  const { layer, execute } = makeLayer({
    env: {
      T3CODE_GITEA_BASE_URL: "https://forge.example.test",
      T3CODE_GITEA_TOKEN: "  ",
    },
  });
  return Effect.gen(function* () {
    const api = yield* GiteaApi.GiteaApi;
    assert.strictEqual((yield* api.probeAuth).status, "unauthenticated");
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses cross-host pagination and paths outside the configured API root", () => {
  const { layer, execute } = makeLayer();
  return Effect.gen(function* () {
    const api = yield* GiteaApi.GiteaApi;
    for (const path of [
      "https://elsewhere.test/api/v1/user",
      "//elsewhere.test/user",
      "../user",
      "https://forge.example.test/user",
      "https://user:password@forge.example.test/gitea/api/v1/user",
    ]) {
      const error = yield* api
        .request({ operation: "test", method: "GET", path })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "failed");
    }
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("accepts a pagination link within the configured API root", () => {
  const { layer, execute } = makeLayer();
  return Effect.gen(function* () {
    const api = yield* GiteaApi.GiteaApi;
    const path = "https://forge.example.test/gitea/api/v1/repos/org/repo/pulls?page=2";
    yield* api.request({ operation: "list", method: "GET", path });
    assert.strictEqual(execute.mock.calls[0]?.[0].url, path);
  }).pipe(Effect.provide(layer));
});

it.effect("does not follow a redirect or replay a write", () => {
  const { layer, execute } = makeLayer({
    response: () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://elsewhere.test/collect" },
      }),
  });
  return Effect.gen(function* () {
    const api = yield* GiteaApi.GiteaApi;
    const error = yield* api
      .request({
        operation: "comment",
        method: "POST",
        path: "/repos/org/repo/issues/1/comments",
        body: '{"body":"hello"}',
      })
      .pipe(Effect.flip);
    assert.strictEqual(error.status, 307);
    assert.strictEqual(execute.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("disables automatic redirects in the production Fetch transport", () => {
  const fetch = vi.fn<(...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>>(async (_url, init) => {
    assert.strictEqual(init?.redirect, "manual");
    return new Response(null, {
      status: 307,
      headers: { location: "https://forge.example.test/outside-api" },
    });
  });
  const layer = GiteaApi.layer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_GITEA_BASE_URL: "https://forge.example.test",
            T3CODE_GITEA_TOKEN: "test-token",
          },
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const api = yield* GiteaApi.GiteaApi;
    const error = yield* api
      .request({
        operation: "comment",
        method: "POST",
        path: "/repos/team/repo/issues/1/comments",
        body: '{"body":"hello"}',
      })
      .pipe(Effect.flip);
    assert.strictEqual(error.status, 307);
    assert.strictEqual(fetch.mock.calls.length, 1);
  }).pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, Object.assign(fetch, { preconnect: vi.fn() })));
});

it.effect("distinguishes rejected credentials from permission failures", () =>
  Effect.gen(function* () {
    for (const [status, expected] of [
      [401, "unauthenticated"],
      [403, "unknown"],
      [404, "unknown"],
    ] as const) {
      const { layer } = makeLayer({
        response: () => new Response("private server details", { status }),
      });
      const auth = yield* Effect.gen(function* () {
        return yield* (yield* GiteaApi.GiteaApi).probeAuth;
      }).pipe(Effect.provide(layer));
      assert.strictEqual(auth.status, expected);
      assert.isFalse(Option.getOrElse(auth.detail, () => "").includes("private server details"));
    }
  }),
);

it.effect("carries rate-limit retry timing without exposing response bodies", () => {
  const { layer } = makeLayer({
    response: () =>
      new Response("secret diagnostic", { status: 429, headers: { "retry-after": "30" } }),
  });
  return Effect.gen(function* () {
    const api = yield* GiteaApi.GiteaApi;
    const error = yield* api
      .request({ operation: "list", method: "GET", path: "/user" })
      .pipe(Effect.flip);
    assert.strictEqual(error.reason, "rate-limited");
    assert.strictEqual(error.retryAt, 30_000);
    assert.isFalse(error.message.includes("secret diagnostic"));
  }).pipe(Effect.provide(layer));
});

it.effect("bounds diff responses and refuses to decode truncated JSON", () => {
  const { layer } = makeLayer({ response: () => new Response("abcdefghij") });
  return Effect.gen(function* () {
    const api = yield* GiteaApi.GiteaApi;
    const response = yield* api.request({
      operation: "diff",
      method: "GET",
      path: "/repos/org/repo/pulls/1.diff",
      maxBytes: 4,
    });
    assert.strictEqual(response.body, "abcd");
    assert.isTrue(response.truncated);
    const error = yield* GiteaApi.decodeGiteaResponse("list", Schema.String, response).pipe(
      Effect.flip,
    );
    assert.strictEqual(error.detail, "Gitea's JSON response was too large.");
  }).pipe(Effect.provide(layer));
});

it.effect("validates the authenticated viewer response", () => {
  const { layer } = makeLayer({ response: () => Response.json({ login: "" }) });
  return Effect.gen(function* () {
    const api = yield* GiteaApi.GiteaApi;
    const auth = yield* api.probeAuth;
    assert.strictEqual(auth.status, "unknown");
    assert.deepStrictEqual(auth.account, Option.none());
  }).pipe(Effect.provide(layer));
});

it("normalizes web roots without accepting credentials or query parameters", () => {
  assert.strictEqual(
    GiteaApi.normalizeGiteaBaseUrl(" https://FORGE.example:8443/gitea/ "),
    "https://forge.example:8443/gitea",
  );
  for (const url of [
    "git@forge.example:org/repo",
    "ftp://forge.example",
    "https://user:secret@forge.example",
    "https://forge.example?token=secret",
    "https://forge.example#fragment",
  ]) {
    assert.isNull(GiteaApi.normalizeGiteaBaseUrl(url));
  }
});
