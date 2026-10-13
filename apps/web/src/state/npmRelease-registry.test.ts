import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { npmReleasePublished } from "./npmRelease";

function check(status: number, body: unknown, urls: string[]) {
  const client = HttpClient.make((request) => {
    urls.push(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
    );
  });
  return npmReleasePublished("0.0.79").pipe(Effect.provideService(HttpClient.HttpClient, client));
}

describe("npm release availability", () => {
  it.effect("checks RTVision's package before offering a remote server update", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      expect(yield* check(200, { version: "0.0.79" }, urls)).toBe(true);
      expect(urls).toEqual(["https://npm-registry.rtvision.com/@rtvision%2Ft3/0.0.79"]);
    }),
  );

  it.effect("keeps an unpublished version unavailable", () =>
    Effect.gen(function* () {
      expect(yield* check(404, {}, [])).toBe(false);
    }),
  );

  it.effect("rejects metadata for another version", () =>
    Effect.gen(function* () {
      expect(yield* check(200, { version: "0.0.78" }, [])).toBe(false);
    }),
  );

  it.effect("keeps registry failures unknown instead of claiming an unpublished version", () =>
    Effect.gen(function* () {
      expect(yield* check(503, {}, []).pipe(Effect.isFailure)).toBe(true);
    }),
  );
});
