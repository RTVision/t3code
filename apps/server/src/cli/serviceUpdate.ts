import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  WsRpcGroup,
  WS_METHODS,
  type ServerConfig,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import type * as Config from "../config.ts";
import { BootServiceDowngradeRefusedError } from "../cloud/bootService.ts";
import { compareExactServiceVersions, parseServiceState } from "../cloud/serviceProtocol.ts";
import { readPersistedServerRuntimeState, serviceRuntimeStatePath } from "../serverRuntimeState.ts";

export class ServiceUpdateConnectionError extends Schema.TaggedError<ServiceUpdateConnectionError>()(
  "ServiceUpdateConnectionError",
  { message: Schema.String },
) {}

export const requestServiceUpdate = Effect.fn("cli.service.requestUpdate")(function* <E, R, E2, R2>(
  client: {
    readonly config: Effect.Effect<Pick<ServerConfig, "environment">, E, R>;
    readonly update: (targetVersion: string) => Effect.Effect<ServerSelfUpdateResult, E2, R2>;
  },
  targetVersion: string,
  allowDowngrade = false,
) {
  const config = yield* client.config;
  if (config.environment.capabilities.serverSelfUpdate !== "boot-service") {
    return yield* new ServiceUpdateConnectionError({
      message:
        "The running server is not managed by the T3 service launcher. Stop the foreground server or desktop host, then start the daemon before updating it.",
    });
  }
  const installedVersion = config.environment.serverVersion;
  if (compareExactServiceVersions(targetVersion, installedVersion) < 0) {
    if (allowDowngrade) return false;
    return yield* new BootServiceDowngradeRefusedError({ installedVersion, targetVersion });
  }
  if (installedVersion === targetVersion) return "current" as const;
  return yield* client.update(targetVersion);
});

/** Use the installed schema until the launcher has backed up the database. */
export const issueServiceUpdateToken = Effect.fn("cli.service.issueUpdateToken")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const rawState = yield* fs
    .readFileString(path.join(baseDir, "runtime", "service-state.json"))
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
      ),
    );
  if (rawState === null) return null;
  const state = parseServiceState(rawState);
  if (state === undefined || state.update?.status === "pending") {
    return yield* new ServiceUpdateConnectionError({
      message:
        "The service state is invalid or an update is already in progress. Retry after the daemon is ready.",
    });
  }
  const entryPath = path.join(
    baseDir,
    "runtime",
    "versions",
    state.activeVersion,
    "node_modules",
    "t3",
    "dist",
    "bin.mjs",
  );
  const result = yield* runner.run({
    command: process.execPath,
    args: [
      entryPath,
      "auth",
      "session",
      "issue",
      "--base-dir",
      baseDir,
      "--ttl",
      "10m",
      "--label",
      "t3 service update",
      "--token-only",
    ],
    timeout: Duration.seconds(30),
    maxOutputBytes: 16_384,
  });
  const token = result.stdout.trim();
  if (result.code !== 0 || !token || /\s/.test(token)) {
    return yield* new ServiceUpdateConnectionError({
      message: "The installed daemon CLI could not issue an update credential.",
    });
  }
  return token;
});

/** No service-manager commands: the running server owns installation and handoff. */
export const updateRunningService = Effect.fn("cli.service.updateRunning")(function* (
  config: Pick<Config.ServerConfig["Service"], "baseDir" | "serverRuntimeStatePath">,
  targetVersion: string,
  allowDowngrade = false,
) {
  const serviceState = yield* readPersistedServerRuntimeState(
    yield* serviceRuntimeStatePath(config.baseDir),
  );
  const runtime = Option.isSome(serviceState)
    ? serviceState
    : yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtime)) return false;
  const state = runtime.value;
  const alive = yield* Effect.sync(() => {
    try {
      process.kill(state.launcherPid ?? state.pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      return true;
    }
  });
  if (!alive) return false;
  const origin = new URL(state.origin);
  if (origin.protocol !== "http:") {
    return yield* new ServiceUpdateConnectionError({
      message: "The daemon runtime record must point to an HTTP server.",
    });
  }
  const token = yield* issueServiceUpdateToken(config.baseDir).pipe(
    Effect.provide(ProcessRunner.layer),
  );
  if (token === null) {
    if (Option.isSome(serviceState)) {
      return yield* new ServiceUpdateConnectionError({
        message:
          "The running daemon's service state is missing. Repair the existing service before updating it.",
      });
    }
    return false;
  }
  const wsUrl = new URL("/ws", origin);
  wsUrl.protocol = "ws:";
  const constructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (url, protocols) =>
      new NodeSocket.NodeWS.WebSocket(url, protocols, {
        headers: { authorization: `Bearer ${token}` },
      }) as unknown as globalThis.WebSocket,
  );
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(wsUrl.toString()).pipe(Layer.provide(constructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
  const result = yield* Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    return yield* requestServiceUpdate(
      {
        config: client[WS_METHODS.serverGetConfig]({}).pipe(Effect.timeout(Duration.seconds(10))),
        update: (version) => client[WS_METHODS.serverUpdateServer]({ targetVersion: version }),
      },
      targetVersion,
      allowDowngrade,
    );
  }).pipe(Effect.provide(protocol), Effect.timeout(Duration.minutes(10)), Effect.scoped);
  return result === false ? false : result === "current" ? "current" : "updating";
});
