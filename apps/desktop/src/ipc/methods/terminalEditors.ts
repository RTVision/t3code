import {
  TerminalEditorCapability,
  TerminalEditorProbeInput,
  TerminalEditorOpenRequest,
  TerminalEditorLaunchResult,
  TerminalEditorSettingsInput,
  type DesktopEditorConnectionRef,
  TerminalEditorReason,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DesktopEnvironment } from "../../app/DesktopEnvironment.ts";
import {
  DesktopBackendPool,
  BackendInstanceId,
  PRIMARY_INSTANCE_ID,
} from "../../backend/DesktopBackendPool.ts";
import { DesktopSavedEnvironments } from "../../settings/DesktopSavedEnvironments.ts";
import { WSL_INSTANCE_ID_PREFIX } from "../../wsl/DesktopWslBackend.ts";
import { DesktopAppSettings } from "../../settings/DesktopAppSettings.ts";
import { matchesSshRunner, selectSshRunner } from "../../ssh/DesktopSshRunner.ts";
import {
  TerminalEditorRuntime,
  routeHash,
  type EditorRouteDescriptor,
} from "../../editors/terminalEditorRuntime.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export class TerminalEditorRouteError extends Schema.TaggedErrorClass<TerminalEditorRouteError>()(
  "TerminalEditorRouteError",
  { reason: Schema.String, message: Schema.String },
) {}
const unavailable = (reason: TerminalEditorReason, message: string) =>
  Effect.fail(new TerminalEditorRouteError({ reason, message }));
const Runtimes = Context.Reference<Map<string, TerminalEditorRuntime>>(
  "desktop/terminalEditorRuntimes",
  { defaultValue: () => new Map() },
);
const runtime = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment;
  const hostEnvironment = yield* HostProcessEnvironment;
  const instances = yield* Runtimes;
  let value = instances.get(environment.stateDir);
  if (!value) {
    value = new TerminalEditorRuntime({
      platform: environment.platform,
      environment: hostEnvironment,
      stateDir: environment.stateDir,
      runtime: process.execPath,
      helperDir: environment.isPackaged
        ? environment.path.join(environment.resourcesPath, "neovim-terminal")
        : environment.path.join(environment.appRoot, "apps/desktop/scripts/neovim-terminal"),
    });
    instances.set(environment.stateDir, value);
  }
  return value;
});

export const resolveEditorRoute = Effect.fn("desktop.editors.resolveRoute")(function* (
  connection: DesktopEditorConnectionRef,
): Effect.fn.Return<
  EditorRouteDescriptor,
  | TerminalEditorRouteError
  | import("../../settings/DesktopSavedEnvironments.ts").DesktopSavedEnvironmentsReadRegistryError,
  DesktopBackendPool | DesktopEnvironment | DesktopSavedEnvironments | DesktopAppSettings
> {
  const pool = yield* DesktopBackendPool;
  const environment = yield* DesktopEnvironment;
  if (connection.kind !== "saved") {
    const instance = yield* pool.get(
      connection.kind === "primary" ? PRIMARY_INSTANCE_ID : BackendInstanceId(connection.backendId),
    );
    if (Option.isNone(instance))
      return yield* unavailable(
        "route-unavailable",
        "The desktop environment no longer exists. Select a connected environment.",
      );
    const config = yield* instance.value.currentConfig;
    const snapshot = yield* instance.value.snapshot;
    if (Option.isNone(config) || !snapshot.ready)
      return yield* unavailable("disconnected", "Connect this environment before checking Neovim.");
    const value = config.value;
    if (value.executablePath.toLowerCase() === "wsl.exe") {
      if (!value.runningDistro || !value.runningUser)
        return yield* unavailable(
          "account-mismatch",
          "Reconnect the WSL backend to capture its exact distro and account.",
        );
      const route = {
        kind: "wsl",
        distro: value.runningDistro,
        user: value.runningUser,
        ...(value.wslNodePath ? { node: value.wslNodePath } : {}),
      } as const;
      return {
        route,
        identity: routeHash([connection, route.distro, route.user]),
        generation: routeHash([route, Option.getOrNull(snapshot.activePid)]),
      };
    }
    return {
      route: { kind: "native" },
      identity: routeHash([connection, "native"]),
      generation: routeHash([connection, Option.getOrNull(snapshot.activePid)]),
    };
  }
  const registry = yield* DesktopSavedEnvironments;
  const record = (yield* registry.getRegistry).find(
    (record) => record.environmentId === connection.environmentId,
  );
  if (!record?.desktopSsh)
    return yield* unavailable(
      "ssh-association-required",
      "Add and select this host as a saved SSH environment in Settings → Connections to open Neovim on it.",
    );
  const target = record.desktopSsh;
  const settings = yield* (yield* DesktopAppSettings).get;
  const common = {
    host: target.alias || target.hostname,
    ...(target.username ? { sshUser: target.username } : {}),
    ...(target.port ? { port: target.port } : {}),
  };
  if (selectSshRunner(environment.platform, settings) === "wsl") {
    const instance = yield* pool.get(
      settings.wslOnly
        ? PRIMARY_INSTANCE_ID
        : BackendInstanceId(`${WSL_INSTANCE_ID_PREFIX}${settings.wslDistro ?? "default"}`),
    );
    const currentConfig = Option.isSome(instance)
      ? yield* instance.value.currentConfig
      : Option.none();
    const config = Option.getOrUndefined(currentConfig);
    if (
      !config?.runningDistro ||
      !config.runningUser ||
      target.runner?.kind !== "wsl" ||
      !target.runner.user
    )
      return yield* unavailable(
        "runner-mismatch",
        "Reconnect or add this SSH environment in Settings → Connections to bind its WSL credential account.",
      );
    if (
      !matchesSshRunner(target.runner, {
        kind: "wsl",
        distro: config.runningDistro,
        user: config.runningUser,
      })
    )
      return yield* unavailable(
        "runner-mismatch",
        "Restore this environment's SSH runner, WSL distro and account in Settings → Connections.",
      );
    const route = {
      kind: "wsl-ssh",
      distro: target.runner.distro,
      user: target.runner.user,
      ...common,
    } as const;
    return {
      route,
      identity: routeHash([connection, target]),
      generation: routeHash([
        target,
        record.lastConnectedAt,
        record.httpBaseUrl,
        settings.sshRunner,
        settings.wslOnly,
        settings.wslDistro,
        config.runningUser,
      ]),
    };
  }
  if (
    !matchesSshRunner(
      target.runner,
      environment.platform === "win32" ? { kind: "windows" } : undefined,
    )
  )
    return yield* unavailable(
      "runner-mismatch",
      "Restore this environment's SSH runner in Settings → Connections. Neovim will not switch credential stores.",
    );
  return {
    route: { kind: "ssh", ...common },
    identity: routeHash([connection, target]),
    generation: routeHash([target, record.lastConnectedAt, record.httpBaseUrl]),
  };
});

const promise = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new TerminalEditorRouteError({
        reason: "probe-error",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
const isRouteError = Schema.is(TerminalEditorRouteError);
const isReason = Schema.is(TerminalEditorReason);
const reasonOf = (error: unknown): TerminalEditorReason =>
  isRouteError(error) && isReason(error.reason) ? error.reason : "route-unavailable";
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const probeTerminalEditor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PROBE_TERMINAL_EDITOR_CHANNEL,
  payload: TerminalEditorProbeInput,
  result: TerminalEditorCapability,
  handler: Effect.fn("desktop.editors.probe")(
    function* (input) {
      const descriptor = yield* resolveEditorRoute(input.connection);
      const service = yield* runtime;
      return yield* promise(() =>
        service.probe(descriptor, input.connectionGeneration, input.rescan),
      );
    },
    Effect.catch((error) =>
      Effect.succeed({
        state: "unavailable" as const,
        reason: reasonOf(error),
        message: messageOf(error),
        routeGeneration: "",
        preferenceKey: "",
        terminals: [],
        selectedTerminal: null,
        executableOverride: null,
      }),
    ),
  ),
});
export const openTerminalEditor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_TERMINAL_EDITOR_CHANNEL,
  payload: TerminalEditorOpenRequest,
  result: TerminalEditorLaunchResult,
  handler: Effect.fn("desktop.editors.open")(
    function* (input) {
      const service = yield* runtime;
      const before = yield* resolveEditorRoute(input.connection);
      yield* promise(() => service.probe(before, input.connectionGeneration));
      const current = yield* resolveEditorRoute(input.connection);
      return yield* promise(() => service.open(current, input));
    },
    Effect.catch((error) =>
      Effect.succeed({
        status: "failed" as const,
        reason: reasonOf(error),
        message: messageOf(error),
      }),
    ),
  ),
});
export const setTerminalEditorSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_TERMINAL_EDITOR_SETTINGS_CHANNEL,
  payload: TerminalEditorSettingsInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.editors.settings")(function* (input) {
    const descriptor = yield* resolveEditorRoute(input.connection);
    const service = yield* runtime;
    yield* promise(() => service.save(descriptor, input));
  }),
});
