import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { type SourceControlProviderAuth, TrimmedNonEmptyString } from "@t3tools/contracts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { providerAuth } from "./SourceControlProviderDiscovery.ts";
import { retryAtFromHeader } from "./SourceControlRateLimit.ts";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export const GITEA_SETUP_HINT =
  "Set T3CODE_GITEA_BASE_URL and T3CODE_GITEA_TOKEN on the server, then rescan.";

const GiteaConfig = Config.all({
  baseUrl: Config.string("T3CODE_GITEA_BASE_URL").pipe(Config.option),
  token: Config.redacted("T3CODE_GITEA_TOKEN").pipe(Config.option),
});

const GiteaViewer = Schema.Struct({ login: TrimmedNonEmptyString });

export class GiteaApiError extends Schema.TaggedErrorClass<GiteaApiError>()("GiteaApiError", {
  operation: Schema.String,
  reason: Schema.Literals(["unconfigured", "unauthenticated", "rate-limited", "failed"]),
  detail: Schema.String,
  status: Schema.optional(Schema.Int),
  retryAt: Schema.optional(Schema.Number),
}) {
  override get message(): string {
    return `Gitea failed in ${this.operation}: ${this.detail}`;
  }
}

export interface GiteaResponse {
  readonly body: string;
  readonly truncated: boolean;
  readonly headers: Readonly<Record<string, string>>;
}

export class GiteaApi extends Context.Service<
  GiteaApi,
  {
    readonly baseUrl: Option.Option<string>;
    readonly request: (input: {
      readonly operation: string;
      readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      /** API-relative path or a pagination URL on the configured API root. */
      readonly path: string;
      readonly body?: string;
      readonly maxBytes?: number;
    }) => Effect.Effect<GiteaResponse, GiteaApiError>;
    readonly probeAuth: Effect.Effect<SourceControlProviderAuth>;
  }
>()("t3/sourceControl/GiteaApi") {}

/** Configuration is the web root, including a subpath for installations behind a proxy. */
export function normalizeGiteaBaseUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

export function decodeGiteaResponse<S extends Schema.Top>(
  operation: string,
  schema: S,
  response: GiteaResponse,
): Effect.Effect<S["Type"], GiteaApiError, S["DecodingServices"]> {
  if (response.truncated) {
    return Effect.fail(
      new GiteaApiError({
        operation,
        reason: "failed",
        detail: "Gitea's JSON response was too large.",
      }),
    );
  }
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.body).pipe(
    Effect.mapError(
      () =>
        new GiteaApiError({ operation, reason: "failed", detail: "Gitea returned invalid JSON." }),
    ),
  );
}

export const make = Effect.gen(function* () {
  const config = yield* GiteaConfig;
  const client = yield* HttpClient.HttpClient;
  const baseUrl = Option.flatMap(config.baseUrl, (value) =>
    Option.fromNullishOr(normalizeGiteaBaseUrl(value)),
  );

  const request: GiteaApi["Service"]["request"] = Effect.fn("GiteaApi.request")(
    function* (input) {
      if (Option.isNone(baseUrl) || Option.isNone(config.token)) {
        return yield* new GiteaApiError({
          operation: input.operation,
          reason: "unconfigured",
          detail:
            Option.isSome(config.baseUrl) && Option.isNone(baseUrl)
              ? "T3CODE_GITEA_BASE_URL must be a valid HTTP or HTTPS web root without credentials, query, or fragment."
              : GITEA_SETUP_HINT,
        });
      }
      const token = Redacted.value(config.token.value).trim();
      if (token.length === 0) {
        return yield* new GiteaApiError({
          operation: input.operation,
          reason: "unconfigured",
          detail: GITEA_SETUP_HINT,
        });
      }
      const root = new URL(`${baseUrl.value}/api/v1/`);
      const url = yield* Effect.try({
        try: () => new URL(input.path.replace(/^\/(?!\/)/u, ""), root),
        catch: () =>
          new GiteaApiError({
            operation: input.operation,
            reason: "failed",
            detail: "Invalid Gitea API path.",
          }),
      });
      if (
        url.origin !== root.origin ||
        !url.pathname.startsWith(root.pathname) ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== ""
      ) {
        return yield* new GiteaApiError({
          operation: input.operation,
          reason: "failed",
          detail: "Gitea API requests must stay within the configured API root.",
        });
      }
      const outgoing = HttpClientRequest.make(input.method)(url.toString()).pipe(
        HttpClientRequest.setHeader("Authorization", `token ${token}`),
        HttpClientRequest.setHeader("Accept", "application/json, text/plain"),
      );
      const response = yield* client
        .execute(
          input.body === undefined
            ? outgoing
            : outgoing.pipe(HttpClientRequest.bodyText(input.body, "application/json")),
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(
            () =>
              new GiteaApiError({
                operation: input.operation,
                reason: "failed",
                detail: "Could not reach the configured Gitea server.",
              }),
          ),
        );
      // Do not follow redirects: a returned location must never move a write or its credentials.
      if (response.status < 200 || response.status >= 300) {
        const now = yield* Clock.currentTimeMillis;
        return yield* new GiteaApiError({
          operation: input.operation,
          reason:
            response.status === 401
              ? "unauthenticated"
              : response.status === 429
                ? "rate-limited"
                : "failed",
          status: response.status,
          ...(response.status === 429
            ? { retryAt: retryAtFromHeader(response.headers["retry-after"], now) }
            : {}),
          detail:
            response.status >= 300 && response.status < 400
              ? `Gitea returned HTTP ${response.status}. Check T3CODE_GITEA_BASE_URL, including its scheme and any proxy subpath.`
              : `Gitea returned HTTP ${response.status}.`,
        });
      }
      if (response.status === 204 || response.status === 205) {
        return { body: "", truncated: false, headers: response.headers };
      }
      const body = yield* collectUint8StreamText({
        stream: response.stream,
        maxBytes: input.maxBytes ?? MAX_RESPONSE_BYTES,
      }).pipe(
        Effect.mapError(
          () =>
            new GiteaApiError({
              operation: input.operation,
              reason: "failed",
              detail: "Could not read Gitea's response.",
            }),
        ),
      );
      return { body: body.text, truncated: body.truncated, headers: response.headers };
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeout("30 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new GiteaApiError({
              operation: input.operation,
              reason: "failed",
              detail: "Gitea request timed out.",
            }),
          ),
        ),
      ),
  );

  return GiteaApi.of({
    baseUrl,
    request,
    probeAuth: request({ operation: "probeAuth", method: "GET", path: "/user" }).pipe(
      Effect.flatMap((response) => decodeGiteaResponse("probeAuth", GiteaViewer, response)),
      Effect.map((viewer) =>
        providerAuth({
          status: "authenticated",
          account: viewer.login,
          host: Option.map(baseUrl, (value) => new URL(value).host).pipe(Option.getOrUndefined),
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          providerAuth({
            status:
              error.reason === "unconfigured" || error.reason === "unauthenticated"
                ? "unauthenticated"
                : "unknown",
            host: Option.map(baseUrl, (value) => new URL(value).host).pipe(Option.getOrUndefined),
            detail: error.detail,
          }),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(GiteaApi, make);
