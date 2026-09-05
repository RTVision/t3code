import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { layer as environmentLayer } from "../../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as Pool from "../../backend/DesktopBackendPool.ts";
import type {
  DesktopBackendInstance,
  DesktopBackendStartConfig,
} from "../../backend/DesktopBackendManager.ts";
import * as Settings from "../../settings/DesktopAppSettings.ts";
import * as Saved from "../../settings/DesktopSavedEnvironments.ts";
import { resolveEditorRoute } from "./terminalEditors.ts";

const config: DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: [],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "127.0.0.1",
    desktopBootstrapToken: "test",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
  runningUser: "alice",
  wslNodePath: "/usr/bin/node",
};
function instance(id: string, value = config, ready = true): DesktopBackendInstance {
  return {
    id: Pool.BackendInstanceId(id),
    label: Effect.succeed(id),
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.some(value)),
    snapshot: Effect.succeed({
      desiredRunning: true,
      ready,
      activePid: Option.some(123),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    waitForReady: () => Effect.succeed(ready),
  };
}
const saved: PersistedSavedEnvironmentRecord = {
  environmentId: EnvironmentId.make("saved-test"),
  label: "Test",
  httpBaseUrl: "http://127.0.0.1:12345",
  wsBaseUrl: "ws://127.0.0.1:12345",
  createdAt: "2026-01-01T00:00:00Z",
  lastConnectedAt: null,
  desktopSsh: {
    alias: "work",
    hostname: "work.test",
    username: "remote-user",
    port: 2222,
    runner: { kind: "wsl", distro: "Ubuntu", user: "alice" },
  },
};
const environment = environmentLayer({
  dirname: "/repo/apps/desktop/src",
  homeDirectory: "/tmp/terminal-route-test",
  platform: "win32",
  processArch: "x64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: true,
  resourcesPath: "/missing/resources",
  runningUnderArm64Translation: false,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      DesktopConfig.layerTest({ T3CODE_HOME: "/tmp/terminal-route-test" }),
    ),
  ),
);
function harness(
  instances: DesktopBackendInstance[],
  records = [saved],
  settings = {
    ...Settings.DEFAULT_DESKTOP_SETTINGS,
    wslBackendEnabled: true,
    wslOnly: false,
    sshRunner: "wsl" as const,
    wslDistro: null,
  },
) {
  return Layer.mergeAll(
    environment,
    Pool.layerTest(instances),
    Saved.layerTest({ records }),
    Settings.layerTest(settings),
  );
}
it.effect(
  "resolves a WSL-only primary from its running account and preserves its Linux runtime",
  () =>
    Effect.gen(function* () {
      const descriptor = yield* resolveEditorRoute({ kind: "primary" });
      assert.deepEqual(descriptor.route, {
        kind: "wsl",
        distro: "Ubuntu",
        user: "alice",
        node: "/usr/bin/node",
      });
    }).pipe(Effect.provide(harness([instance("primary")]))),
);
it.effect("uses the configured WSL instance instead of the first pool entry for saved SSH", () =>
  Effect.gen(function* () {
    const descriptor = yield* resolveEditorRoute({
      kind: "saved",
      environmentId: saved.environmentId,
    });
    assert.deepEqual(descriptor.route, {
      kind: "wsl-ssh",
      distro: "Ubuntu",
      user: "alice",
      host: "work",
      sshUser: "remote-user",
      port: 2222,
    });
  }).pipe(
    Effect.provide(
      harness([
        instance("wsl:other", { ...config, runningDistro: "Debian", runningUser: "bob" }),
        instance("wsl:default"),
      ]),
    ),
  ),
);
it.effect("rejects a changed credential account instead of silently using it", () =>
  Effect.gen(function* () {
    const failure = yield* resolveEditorRoute({
      kind: "saved",
      environmentId: saved.environmentId,
    }).pipe(Effect.flip);
    assert.equal(failure._tag, "TerminalEditorRouteError");
    assert.include(failure.message, "account");
  }).pipe(Effect.provide(harness([instance("wsl:default", { ...config, runningUser: "bob" })]))),
);
it.effect("does not infer local execution from a forwarded loopback URL", () =>
  Effect.gen(function* () {
    const failure = yield* resolveEditorRoute({
      kind: "saved",
      environmentId: saved.environmentId,
    }).pipe(Effect.flip);
    assert.include(failure.message, "saved SSH environment");
  }).pipe(
    Effect.provide(
      harness(
        [instance("primary")],
        [
          {
            environmentId: saved.environmentId,
            label: saved.label,
            httpBaseUrl: saved.httpBaseUrl,
            wsBaseUrl: saved.wsBaseUrl,
            createdAt: saved.createdAt,
            lastConnectedAt: null,
          },
        ],
      ),
    ),
  ),
);
it.effect("rejects a disconnected desktop backend", () =>
  Effect.gen(function* () {
    const failure = yield* resolveEditorRoute({ kind: "primary" }).pipe(Effect.flip);
    assert.include(failure.message, "Connect");
  }).pipe(Effect.provide(harness([instance("primary", config, false)]))),
);
