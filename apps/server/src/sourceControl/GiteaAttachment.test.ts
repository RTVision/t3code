import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import * as GiteaCli from "./GiteaCli.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HttpServerResponse } from "effect/unstable/http";
import * as ServerConfig from "../config.ts";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as GiteaAttachment from "./GiteaAttachment.ts";

const url = "https://forge.test/gitea/attachments/82cde921-c3fc-4c01-85b8-edf737cdaa83";
const bytes = new Uint8Array([137, 80, 78, 71, 255, 0, 13, 10]);
function fixture(status = 200, contentType = "image/png", imageBytes = bytes) {
  const paths: string[] = [];
  const execute = vi.fn<ForgejoCli.ForgejoCli["Service"]["execute"]>();
  const cliLayer = Layer.effect(
    ForgejoCli.ForgejoCli,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      execute.mockImplementation((input) =>
        Effect.gen(function* () {
          const path = input.args[input.args.indexOf("--output") + 1];
          if (!path) return yield* Effect.die("missing image destination");
          paths.push(path);
          yield* fs.writeFile(path, imageBytes).pipe(Effect.orDie);
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "",
            stderr: `HTTP/1.1 ${status}\nContent-Type: ${contentType}\n`,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
      );
      return yield* ForgejoCli.ForgejoCli.pipe(
        Effect.provide(
          Layer.mock(ForgejoCli.ForgejoCli)({
            execute,
            resolveServer: () =>
              Effect.succeed({
                command: "tea",
                login: "work",
                repository: "",
                baseUrl: "https://forge.test/gitea",
              }),
          }),
        ),
      );
    }),
  );
  const layer = Layer.mergeAll(
    cliLayer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-tea-image-test-" }),
    Layer.mock(GiteaCli.GiteaCli)({ baseUrl: Option.some("https://forge.test/gitea") }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return { layer, execute, paths };
}

it.effect("downloads an authenticated image through tea without decoding binary bytes", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const response = yield* GiteaAttachment.imageResponse(url).pipe(Effect.scoped);
    const web = HttpServerResponse.toWeb(response);
    expect(new Uint8Array(yield* Effect.promise(() => web.arrayBuffer()))).toEqual(bytes);
    expect(f.execute.mock.calls[0]?.[0].args).toContain("work");
    expect(f.execute.mock.calls[0]?.[0].args.at(-1)).toBe(url);
    expect(web.headers.get("content-type")).toBe("image/png");
    expect(web.headers.get("authorization")).toBeNull();
    for (const path of f.paths) expect(yield* fs.exists(path)).toBe(false);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect.each([
  "https://elsewhere.test/gitea/attachments/82cde921-c3fc-4c01-85b8-edf737cdaa83",
  "https://forge.test/api/v1/user",
])("rejects a non-attachment URL before invoking tea: %s", (source) => {
  const f = fixture();
  return Effect.gen(function* () {
    expect((yield* GiteaAttachment.imageResponse(source).pipe(Effect.flip))._tag).toBe(
      "GiteaAttachmentError",
    );
    expect(f.execute).not.toHaveBeenCalled();
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect.each([
  { status: 404, contentType: "image/png", expected: 404 },
  { status: 200, contentType: "text/html", expected: 415 },
  { status: 500, contentType: "text/plain", expected: 502 },
])("handles tea's HTTP $status / $contentType response", ({ status, contentType, expected }) => {
  const f = fixture(status, contentType);
  return Effect.gen(function* () {
    expect((yield* GiteaAttachment.imageResponse(url)).status).toBe(expected);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect("rejects an oversized downloaded image", () => {
  const f = fixture(200, "image/png", new Uint8Array(32 * 1024 * 1024 + 1));
  return GiteaAttachment.imageResponse(url).pipe(
    Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(413))),
    Effect.provide(f.layer),
    Effect.scoped,
  );
});
