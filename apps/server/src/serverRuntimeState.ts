import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import {
  parseServiceState,
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import packageJson from "../package.json" with { type: "json" };
import type * as ServerConfig from "./config.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  launcherPid: Schema.optional(Schema.Int),
  ownerId: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  privateNetworkOnly: Schema.optional(Schema.Boolean),
  port: Schema.Int,
  origin: Schema.String,
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export const serviceRuntimeStatePath = (baseDir: string) =>
  Effect.map(Path.Path, (path) => path.join(baseDir, "runtime", "server-runtime.json"));

/** Retained during child restarts; discovery checks the supervisor is still alive. */
const persistServiceRuntimeState = Effect.fn("server.persistServiceRuntimeState")(
  function* (input: {
    readonly baseDir: string;
    readonly state: PersistedServerRuntimeState;
    readonly launcherPid: number;
  }) {
    yield* persistServerRuntimeState({
      path: yield* serviceRuntimeStatePath(input.baseDir),
      state: { ...input.state, launcherPid: input.launcherPid },
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to persist service runtime state").pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
    );
  },
);

/** Retain service discovery during handoff; shared discovery belongs to ServerOwnership. */
export const acquireServiceRuntimeState = Effect.fn("server.acquireServiceRuntimeState")(
  function* (input: {
    readonly config: Pick<ServerConfig.ServerConfig["Service"], "baseDir">;
    readonly state: PersistedServerRuntimeState;
  }) {
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        if (launcher.managed) {
          yield* persistServiceRuntimeState({
            baseDir: input.config.baseDir,
            state: input.state,
            launcherPid: process.ppid,
          });
        }
      }),
      () =>
        Effect.gen(function* () {
          if (!launcher.managed) return;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const runtimeDir = path.join(input.config.baseDir, "runtime");
          const service = yield* fs.readFileString(path.join(runtimeDir, SERVICE_STATE_FILE)).pipe(
            Effect.map(parseServiceState),
            Effect.orElseSucceed(() => undefined),
          );
          const stopping = yield* fs.exists(path.join(runtimeDir, SERVICE_STOP_MARKER_FILE));
          if (service?.update?.status === "pending" && !stopping) return;
          yield* clearPersistedServerRuntimeState(
            yield* serviceRuntimeStatePath(input.config.baseDir),
            input.state.pid,
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to clear server runtime state", { cause }),
          ),
        ),
    );
  },
);

export class ServerRuntimeStateError extends Schema.TaggedError<ServerRuntimeStateError>()(
  "ServerRuntimeStateError",
  {
    operation: Schema.Literals(["persist", "read", "decode", "clear"]),
    statePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} server runtime state at ${this.statePath}.`;
  }
}

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const runtimeOriginForConfig = (
  config: Pick<ServerConfig.ServerConfig["Service"], "host">,
  port: number,
): PersistedServerRuntimeState["origin"] => {
  const hostname =
    config.host && !isWildcardHost(config.host) ? formatHostForUrl(config.host) : "127.0.0.1";
  return `http://${hostname}:${port}`;
};

export const makePersistedServerRuntimeState = (input: {
  readonly config: Pick<
    ServerConfig.ServerConfig["Service"],
    "host" | "privateNetworkOnly" | "devUrl"
  >;
  readonly port: number;
  readonly serviceManaged?: boolean;
}): Effect.Effect<PersistedServerRuntimeState> =>
  Effect.map(DateTime.now, (now) => ({
    version: 1,
    pid: process.pid,
    ...(input.config.host ? { host: input.config.host } : {}),
    ...(input.config.privateNetworkOnly ? { privateNetworkOnly: true } : {}),
    port: input.port,
    origin: runtimeOriginForConfig(input.config, input.port),
    ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
    startedAt: DateTime.formatIso(now),
    ...(input.serviceManaged ? { serviceManaged: true } : {}),
    serverVersion: packageJson.version,
  }));

export const persistServerRuntimeState = (input: {
  readonly path: string;
  readonly state: PersistedServerRuntimeState;
}) =>
  writeFileStringAtomically({
    filePath: input.path,
    contents: `${JSON.stringify(input.state)}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation: "persist",
          statePath: input.path,
          cause,
        }),
    ),
  );

export const clearPersistedServerRuntimeState = Effect.fn(
  "server.clearPersistedServerRuntimeState",
)(function* (path: string, expectedPid?: number) {
  const fs = yield* FileSystem.FileSystem;
  if (expectedPid !== undefined) {
    const current = yield* readPersistedServerRuntimeState(path);
    if (Option.isNone(current) || current.value.pid !== expectedPid) return;
  }
  yield* fs.remove(path, { force: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ServerRuntimeStateError({
          operation: "clear",
          statePath: path,
          cause,
        }),
    ),
    Effect.catchTags({
      ServerRuntimeStateError: (error) =>
        Effect.logWarning(error.message).pipe(
          Effect.annotateLogs({
            operation: error.operation,
            statePath: error.statePath,
            cause: error,
          }),
        ),
    }),
  );
});

/**
 * Signal 0 delivers nothing; it only reports whether the pid exists. EPERM
 * means it exists but belongs to another user, which still counts as alive.
 */
export const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export const readPersistedServerRuntimeState = Effect.fn(
  "serverRuntimeState.readPersistedServerRuntimeState",
)(
  function* (path: string) {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new ServerRuntimeStateError({
                  operation: "read",
                  statePath: path,
                  cause,
                }),
              ),
        onSuccess: (contents) => Effect.succeedSome(contents),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<PersistedServerRuntimeState>();
    }

    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return Option.none<PersistedServerRuntimeState>();
    }

    return yield* decodePersistedServerRuntimeState(trimmed).pipe(
      Effect.asSome,
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  },
  Effect.catchTags({
    ServerRuntimeStateError: (error) =>
      Effect.logWarning(error.message).pipe(
        Effect.annotateLogs({
          operation: error.operation,
          statePath: error.statePath,
          cause: error,
        }),
        Effect.as(Option.none<PersistedServerRuntimeState>()),
      ),
  }),
);
