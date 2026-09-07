import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { layer as environmentLayer } from "../../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as Pool from "../../backend/DesktopBackendPool.ts";
import type {
  DesktopBackendInstance,
  DesktopBackendStartConfig,
} from "../../backend/DesktopBackendManager.ts";
import * as Settings from "../../settings/DesktopAppSettings.ts";
import { DesktopConnectionCatalogStore } from "../../app/DesktopConnectionCatalogStore.ts";
import {
  BearerConnectionProfile,
  SshConnectionProfile,
  type ConnectionProfile,
} from "@t3tools/client-runtime/connection";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  ConnectionCatalogDocument,
} from "@t3tools/client-runtime/platform";
import { resolveEditorRoute } from "./terminalEditors.ts";

const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));
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
const saved = new SshConnectionProfile({
  connectionId: "ssh-test",
  environmentId: EnvironmentId.make("saved-test"),
  label: "Test",
  target: {
    alias: "work",
    hostname: "work.test",
    username: "remote-user",
    port: 2222,
    runner: { kind: "wsl", distro: "Ubuntu", user: "alice" },
  },
});
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
  records: readonly ConnectionProfile[] = [saved],
  settings = {
    ...Settings.DEFAULT_DESKTOP_SETTINGS,
    wslBackendEnabled: true,
    wslOnly: false,
    sshRunner: "wsl" as const,
    wslDistro: null,
  },
) {
  let catalog = Option.some(
    encodeCatalog({ ...EMPTY_CONNECTION_CATALOG_DOCUMENT, profiles: records }),
  );
  return Layer.mergeAll(
    environment,
    Pool.layerTest(instances),
    Layer.succeed(DesktopConnectionCatalogStore, {
      get: Effect.sync(() => catalog),
      set: (value) =>
        Effect.sync(() => {
          catalog = Option.some(value);
          return true;
        }),
      clear: Effect.void,
    }),
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
      node: "/usr/bin/node",
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
          new BearerConnectionProfile({
            connectionId: "bearer-test",
            environmentId: saved.environmentId,
            label: saved.label,
            httpBaseUrl: "http://127.0.0.1:12345",
            wsBaseUrl: "ws://127.0.0.1:12345",
          }),
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

it.effect(
  "reads the rebound account from the catalog after reconnect, without a legacy registry",
  () =>
    Effect.gen(function* () {
      const connection = { kind: "saved", environmentId: saved.environmentId } as const;
      const failure = yield* resolveEditorRoute(connection).pipe(Effect.flip);
      assert.include(failure.message, "Reconnect");
      const store = yield* DesktopConnectionCatalogStore;
      yield* store.set(encodeCatalog({ ...EMPTY_CONNECTION_CATALOG_DOCUMENT, profiles: [saved] }));
      const descriptor = yield* resolveEditorRoute(connection);
      assert.deepEqual(descriptor.route, {
        kind: "wsl-ssh",
        distro: "Ubuntu",
        user: "alice",
        node: "/usr/bin/node",
        host: "work",
        sshUser: "remote-user",
        port: 2222,
      });
    }).pipe(
      Effect.provide(
        harness(
          [instance("wsl:default")],
          [
            new SshConnectionProfile({
              ...saved,
              target: { ...saved.target, runner: { kind: "wsl", distro: "Ubuntu" } },
            }),
          ],
        ),
      ),
    ),
);
