import { resolveGiteaAttachmentUrl } from "@t3tools/shared/giteaAttachments";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GiteaCli from "./GiteaCli.ts";
import * as ForgejoCli from "./ForgejoCli.ts";
import { ServerConfig } from "../config.ts";
import { HttpServerResponse } from "effect/unstable/http";

export class GiteaAttachmentError extends Schema.TaggedError<GiteaAttachmentError>()(
  "GiteaAttachmentError",
  { detail: Schema.String },
) {}

export const validateUrl = Effect.fn("GiteaAttachment.validateUrl")(function* (url: string) {
  const { baseUrl: configured } = yield* GiteaCli.GiteaCli;
  const resolved = Option.isSome(configured)
    ? resolveGiteaAttachmentUrl(url, configured.value)
    : null;
  if (resolved === null) {
    return yield* new GiteaAttachmentError({
      detail: "The image is not an attachment on the configured Gitea server.",
    });
  }
  return resolved;
});

/** Tea owns image authentication; binary bodies never pass through text decoding. */
export const imageResponse = Effect.fn("GiteaAttachment.imageResponse")(function* (url: string) {
  const resolved = yield* validateUrl(url);
  const cli = yield* ForgejoCli.ForgejoCli;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { cwd } = yield* ServerConfig;
  const target = yield* cli.resolveServer({ cwd, command: "tea", reference: resolved });
  if (resolveGiteaAttachmentUrl(resolved, target.baseUrl) === null) {
    return yield* new GiteaAttachmentError({
      detail: "The image is not on the selected tea server.",
    });
  }
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gitea-image-" });
  const output = path.join(directory, "image");
  const result = yield* cli.execute({
    cwd,
    command: "tea",
    args: ["api", "--include", "--login", target.login, "--output", output, resolved],
    timeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
  });
  const { status, headers } = ForgejoCli.parseTeaResponse(result.stderr);
  if (status !== 200)
    return HttpServerResponse.text("Image unavailable", { status: status === 404 ? 404 : 502 });
  const contentType = headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (!contentType || !/^image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)$/u.test(contentType)) {
    return HttpServerResponse.text("Unsupported image type", { status: 415 });
  }
  const stat = yield* fs.stat(output);
  if (stat.size > 32n * 1024n * 1024n)
    return HttpServerResponse.text("Image too large", { status: 413 });
  const bytes = yield* fs.readFile(output);
  return HttpServerResponse.uint8Array(bytes, {
    contentType,
    headers: {
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    },
  });
});
