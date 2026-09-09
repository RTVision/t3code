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
import { writeFileStringAtomically } from "./atomicWrite.ts";
import type * as ServerConfig from "./config.ts";
import { formatHostForUrl, isWildcardHost } from "./startupAccess.ts";

export const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  launcherPid: Schema.optional(Schema.Int),
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  // Present when the server fronts a dev web server (VITE_DEV_SERVER_URL).
  // Dev is single-origin: browsers must pair through this URL, not `origin`.
  devUrl: Schema.optional(Schema.String),
  startedAt: Schema.String,
});
export type PersistedServerRuntimeState = typeof PersistedServerRuntimeState.Type;

export const serviceRuntimeStatePath = (baseDir: string) =>
  Effect.map(Path.Path, (path) => path.join(baseDir, "runtime", "server-runtime.json"));

/** Retained during child restarts; discovery checks the supervisor is still alive. */
export const persistServiceRuntimeState = (input: {
  readonly baseDir: string;
  readonly state: PersistedServerRuntimeState;
  readonly launcherPid: number;
}) =>
  Effect.gen(function* () {
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
  });

/** Publish discovery for this server and retain daemon ownership only during handoff. */
export const acquireServerRuntimeState = Effect.fn("server.acquireRuntimeState")(function* (input: {
  readonly config: Pick<ServerConfig.ServerConfig["Service"], "baseDir" | "serverRuntimeStatePath">;
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
      yield* persistServerRuntimeState({
        path: input.config.serverRuntimeStatePath,
        state: input.state,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to persist server runtime state", { cause }),
        ),
      );
    }),
    () =>
      Effect.gen(function* () {
        yield* clearPersistedServerRuntimeState(
          input.config.serverRuntimeStatePath,
          input.state.pid,
        );
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
});

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
  readonly config: Pick<ServerConfig.ServerConfig["Service"], "host" | "devUrl">;
  readonly port: number;
}): Effect.Effect<PersistedServerRuntimeState> =>
  Effect.map(DateTime.now, (now) => ({
    version: 1,
    pid: process.pid,
    ...(input.config.host ? { host: input.config.host } : {}),
    port: input.port,
    origin: runtimeOriginForConfig(input.config, input.port),
    ...(input.config.devUrl ? { devUrl: input.config.devUrl.toString() } : {}),
    startedAt: DateTime.formatIso(now),
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

export const clearPersistedServerRuntimeState = (path: string, expectedPid?: number) =>
  Effect.gen(function* () {
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
 * Report whether the pid recorded in a persisted runtime state is still
 * running. Signal 0 delivers nothing; it only reports whether the pid exists.
 * EPERM means it exists but belongs to another user, which still counts as
 * alive.
 */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

export const readPersistedServerRuntimeState = (path: string) =>
  Effect.gen(function* () {
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
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
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
      Effect.map(Option.some),
      Effect.mapError(
        (cause) =>
          new ServerRuntimeStateError({
            operation: "decode",
            statePath: path,
            cause,
          }),
      ),
    );
  }).pipe(
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
