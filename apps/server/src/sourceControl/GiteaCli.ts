import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type SourceControlProviderAuth, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as ForgejoCli from "./ForgejoCli.ts";
import { ServerConfig } from "../config.ts";

import { providerAuth } from "./SourceControlProviderDiscovery.ts";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export const GITEA_SETUP_HINT =
  "Install tea 0.16 or later and run tea login add as the daemon user. Select a default with tea login default <name> or set T3CODE_GITEA_BASE_URL, then restart T3.";

const GiteaConfig = Config.all({
  legacyToken: Config.redacted("T3CODE_GITEA_TOKEN").pipe(Config.option),
  baseUrl: Config.string("T3CODE_GITEA_BASE_URL").pipe(Config.option),
  sshHosts: Config.string("T3CODE_GITEA_SSH_HOSTS").pipe(Config.withDefault("")),
});

const GiteaViewer = Schema.Struct({ login: TrimmedNonEmptyString });

export class GiteaCliError extends Schema.TaggedError<GiteaCliError>()("GiteaCliError", {
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

export class GiteaCli extends Context.Service<
  GiteaCli,
  {
    readonly baseUrl: Option.Option<string>;
    /** Explicit SSH aliases for this forge; API requests still use only baseUrl. */
    readonly sshHosts?: ReadonlyArray<string>;
    readonly request: (input: {
      readonly operation: string;
      readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      /** API-relative path or a pagination URL on the configured API root. */
      readonly path: string;
      readonly body?: string;
      readonly maxBytes?: number;
    }) => Effect.Effect<GiteaResponse, GiteaCliError>;
    readonly probeAuth: Effect.Effect<SourceControlProviderAuth>;
  }
>()("t3/sourceControl/GiteaCli") {}

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
): Effect.Effect<S["Type"], GiteaCliError, S["DecodingServices"]> {
  if (response.truncated) {
    return Effect.fail(
      new GiteaCliError({
        operation,
        reason: "failed",
        detail: "Gitea's JSON response was too large.",
      }),
    );
  }
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.body).pipe(
    Effect.mapError(
      () =>
        new GiteaCliError({ operation, reason: "failed", detail: "Gitea returned invalid JSON." }),
    ),
  );
}

export const make = Effect.gen(function* () {
  const config = yield* GiteaConfig;
  const cli = yield* ForgejoCli.ForgejoCli;
  const { cwd } = yield* ServerConfig;
  const logins = cli.listLogins
    ? yield* cli.listLogins({ cwd, command: "tea" }).pipe(Effect.orElseSucceed(() => []))
    : [];
  const selected =
    logins.find((login) => login.default === "true") ??
    (logins.length === 1 ? logins[0] : undefined);
  const baseUrl = Option.fromNullishOr(
    normalizeGiteaBaseUrl(Option.getOrElse(config.baseUrl, () => selected?.url ?? "")),
  );
  const request: GiteaCli["Service"]["request"] = Effect.fn("GiteaCli.request")(function* (input) {
    if (Option.isNone(baseUrl))
      return yield* new GiteaCliError({
        operation: input.operation,
        reason: "unconfigured",
        detail: GITEA_SETUP_HINT,
      });
    const root = new URL(`${baseUrl.value}/api/v1/`);
    const url = yield* Effect.try({
      try: () => new URL(input.path.replace(/^\/(?!\/)/u, ""), root),
      catch: () =>
        new GiteaCliError({
          operation: input.operation,
          reason: "failed",
          detail: "Invalid Gitea API path.",
        }),
    });
    if (
      url.origin !== root.origin ||
      !url.pathname.startsWith(root.pathname) ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return yield* new GiteaCliError({
        operation: input.operation,
        reason: "failed",
        detail: "Gitea requests must stay within the selected tea server's API root.",
      });
    }
    const body =
      input.body === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(input.body).pipe(
            Effect.mapError(
              () =>
                new GiteaCliError({
                  operation: input.operation,
                  reason: "failed",
                  detail: "Invalid Gitea request body.",
                }),
            ),
          );
    const result = yield* Effect.gen(function* () {
      const target = yield* cli.resolveServer({ cwd, command: "tea", reference: baseUrl.value });
      if (normalizeGiteaBaseUrl(target.baseUrl) !== baseUrl.value) {
        return yield* new ForgejoCli.ForgejoCliError({
          command: "tea",
          cwd,
          detail:
            "T3CODE_GITEA_BASE_URL must match the tea login URL, including its scheme and proxy subpath.",
        });
      }
      return yield* cli.api({
        cwd,
        resolvedTarget: target,
        path: url.pathname.slice(root.pathname.length) + url.search,
        method: input.method,
        ...(input.body === undefined ? {} : { body }),
        maxOutputBytes: input.maxBytes ?? MAX_RESPONSE_BYTES,
      });
    }).pipe(
      Effect.mapError(
        (error) =>
          new GiteaCliError({
            operation: input.operation,
            reason:
              error.reason === "missing-cli"
                ? "unconfigured"
                : error.reason === "authentication"
                  ? "unauthenticated"
                  : error.reason === "rate-limit"
                    ? "rate-limited"
                    : "failed",
            detail:
              error.reason === "authentication" && Option.isSome(config.legacyToken)
                ? `${error.detail} T3 no longer reads T3CODE_GITEA_TOKEN; run tea login add as the daemon user and enter the existing token.`
                : error.detail,
            ...(error.httpStatus === undefined ? {} : { status: error.httpStatus }),
            ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
          }),
      ),
    );
    const { headers } = ForgejoCli.parseTeaResponse(result.stderr);
    return { body: result.stdout, truncated: result.stdoutTruncated, headers };
  });
  return GiteaCli.of({
    baseUrl,
    sshHosts: [
      ...config.sshHosts
        .toLowerCase()
        .split(/[,\s]+/u)
        .filter(Boolean),
      ...logins
        .filter((login) => normalizeGiteaBaseUrl(login.url) === Option.getOrUndefined(baseUrl))
        .flatMap((login) => (login.ssh_host ? [login.ssh_host.toLowerCase()] : [])),
    ],
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
        Effect.succeed(providerAuth({ status: "unauthenticated", detail: error.detail })),
      ),
    ),
  });
});

export const layer = Layer.effect(GiteaCli, make).pipe(Layer.provide(ForgejoCli.layer));
