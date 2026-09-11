import { expect, it, vi } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerResponse,
} from "effect/unstable/http";

import * as GiteaAttachment from "./GiteaAttachment.ts";

const url = "https://forge.test/gitea/attachments/82cde921-c3fc-4c01-85b8-edf737cdaa83";
const config = ConfigProvider.layer(
  ConfigProvider.fromEnv({
    env: {
      T3CODE_GITEA_BASE_URL: "https://forge.test/gitea",
      T3CODE_GITEA_TOKEN: "private-token",
    },
  }),
);

function httpLayer(response: Response) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const requestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
      expect(Option.getOrNull(requestInit)?.redirect).toBe("manual");
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  return {
    execute,
    layer: Layer.merge(config, Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute))),
  };
}

it.effect("streams a private Gitea image using server credentials", () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const { execute, layer } = httpLayer(
    new Response(bytes, { headers: { "Content-Type": "image/png" } }),
  );
  return Effect.gen(function* () {
    const response = yield* GiteaAttachment.imageResponse(url);
    expect(response.status).toBe(200);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      url,
      headers: { authorization: "token private-token" },
    });
    const web = HttpServerResponse.toWeb(response);
    expect(new Uint8Array(yield* Effect.promise(() => web.arrayBuffer()))).toEqual(bytes);
    expect(web.headers.get("content-type")).toBe("image/png");
    expect(web.headers.get("authorization")).toBeNull();
    expect(web.headers.get("content-security-policy")).toContain("sandbox");
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect.each([
  "https://elsewhere.test/gitea/attachments/82cde921-c3fc-4c01-85b8-edf737cdaa83",
  "https://forge.test/api/v1/user",
])("does not send credentials to %s", (source) => {
  const { execute, layer } = httpLayer(new Response());
  return Effect.gen(function* () {
    const error = yield* GiteaAttachment.imageResponse(source).pipe(Effect.flip);
    expect(error._tag).toBe("GiteaAttachmentError");
    expect(execute).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect.each([
  { status: 302, headers: { Location: "https://elsewhere.test/image.png" }, expected: 502 },
  { status: 404, headers: {}, expected: 404 },
  { status: 200, headers: { "Content-Type": "text/html" }, expected: 415 },
])(
  "rejects an upstream response with status $status and headers $headers",
  ({ status, headers, expected }) => {
    const { execute, layer } = httpLayer(new Response("", { status, headers }));
    return Effect.gen(function* () {
      const response = yield* GiteaAttachment.imageResponse(url);
      expect(response.status).toBe(expected);
      expect(execute).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);
