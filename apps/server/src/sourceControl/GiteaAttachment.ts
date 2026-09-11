import { resolveGiteaAttachmentUrl } from "@t3tools/shared/giteaAttachments";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
} from "effect/unstable/http";

export class GiteaAttachmentError extends Schema.TaggedError<GiteaAttachmentError>()(
  "GiteaAttachmentError",
  { detail: Schema.String },
) {}

export const validateUrl = Effect.fn("GiteaAttachment.validateUrl")(function* (url: string) {
  const configured = yield* Config.string("T3CODE_GITEA_BASE_URL").pipe(Config.option);
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

/** Fetches private images without exposing the host's token in a client URL. */
export const imageResponse = Effect.fn("GiteaAttachment.imageResponse")(function* (url: string) {
  const resolved = yield* validateUrl(url);
  const configuredToken = yield* Config.redacted("T3CODE_GITEA_TOKEN").pipe(Config.option);
  const token = Option.isSome(configuredToken) ? Redacted.value(configuredToken.value).trim() : "";
  if (token.length === 0) {
    return yield* new GiteaAttachmentError({ detail: "Gitea authentication is not configured." });
  }
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClient.withScope(client)
    .execute(
      HttpClientRequest.get(resolved).pipe(
        HttpClientRequest.setHeader("Authorization", `token ${token}`),
        HttpClientRequest.setHeader("Accept", "image/*"),
      ),
    )
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("30 seconds"),
    );
  // Redirects must not forward the server's credentials to another host.
  if (response.status !== 200) {
    return HttpServerResponse.text("Image unavailable", {
      status: response.status === 404 ? 404 : 502,
    });
  }
  const contentType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (!contentType || !/^image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)$/u.test(contentType)) {
    return HttpServerResponse.text("Unsupported image type", { status: 415 });
  }
  const body = response.stream.pipe(
    Stream.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Stream.fail(new GiteaAttachmentError({ detail: "Gitea image body timed out." })),
    }),
  );
  return HttpServerResponse.stream(body, {
    contentType,
    headers: {
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    },
  });
});
