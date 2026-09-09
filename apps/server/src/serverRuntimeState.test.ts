import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import * as ServerRuntimeState from "./serverRuntimeState.ts";

const managedLauncher = ServiceLauncherClient.ServiceLauncherClient.of({
  managed: true,
  requestUpdate: () => Effect.die("unexpected update request"),
  prepareTrial: Effect.succeed(undefined),
});

const isServerRuntimeStateError = Schema.is(ServerRuntimeState.ServerRuntimeStateError);

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

describe("serverRuntimeState", () => {
  it.effect("persists and reads the runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "runtime", "server.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        host: "127.0.0.1",
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        devUrl: "http://localhost:5733/",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.deepEqual(Option.getOrThrow(restored), state);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps daemon discovery when another server overwrites and clears shared state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-runtime-test-" });
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 15357,
      });
      const sharedPath = path.join(baseDir, "userdata", "server-runtime.json");
      yield* ServerRuntimeState.persistServiceRuntimeState({ baseDir, state, launcherPid: 123 });
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: sharedPath,
        state: { ...state, pid: 456, port: 3774 },
      });
      yield* ServerRuntimeState.clearPersistedServerRuntimeState(sharedPath);
      const daemon = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        yield* ServerRuntimeState.serviceRuntimeStatePath(baseDir),
      );
      assert.deepEqual(Option.getOrThrow(daemon), { ...state, launcherPid: 123 });
      yield* ServerRuntimeState.persistServiceRuntimeState({
        baseDir,
        state: { ...state, pid: 789, port: 15358 },
        launcherPid: 123,
      });
      const restarted = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        yield* ServerRuntimeState.serviceRuntimeStatePath(baseDir),
      );
      assert.equal(Option.getOrThrow(restarted).port, 15358);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "continues startup publication when the daemon discovery directory is unwritable",
    () => {
      const logs: CapturedLog[] = [];
      const logger = Logger.make(({ fiber, message }) => {
        logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-service-runtime-failure-",
        });
        // A file in place of the directory fails reliably, including in root-run CI.
        yield* fs.writeFileString(path.join(baseDir, "runtime"), "not a directory");
        const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 15357,
        });
        const sharedPath = path.join(baseDir, "userdata", "server-runtime.json");
        yield* Effect.gen(function* () {
          yield* ServerRuntimeState.acquireServerRuntimeState({
            config: { baseDir, serverRuntimeStatePath: sharedPath },
            state,
          });
          assert.deepEqual(
            Option.getOrThrow(
              yield* ServerRuntimeState.readPersistedServerRuntimeState(sharedPath),
            ),
            state,
          );
          assert.equal(logs[0]?.message, "Failed to persist service runtime state");
        }).pipe(
          Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, managedLauncher),
          Effect.scoped,
        );
        assert.isFalse(yield* fs.exists(sharedPath));
      }).pipe(
        Effect.provide(
          Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    },
  );

  it.effect.each(["stop", "handoff", "stop-during-handoff", "new-owner"] as const)(
    "cleans daemon discovery on %s",
    (mode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-lifecycle-" });
        const sharedPath = path.join(baseDir, "userdata", "server-runtime.json");
        const servicePath = yield* ServerRuntimeState.serviceRuntimeStatePath(baseDir);
        const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
          config: { host: undefined, devUrl: undefined },
          port: 15357,
        });
        yield* Effect.gen(function* () {
          yield* ServerRuntimeState.acquireServerRuntimeState({
            config: { baseDir, serverRuntimeStatePath: sharedPath },
            state,
          });
          assert.isTrue(yield* fs.exists(servicePath));
          if (mode === "handoff" || mode === "stop-during-handoff") {
            yield* fs.writeFileString(
              path.join(baseDir, "runtime", "service-state.json"),
              JSON.stringify({
                protocol: SERVICE_LAUNCHER_PROTOCOL,
                activeVersion: "1.0.0",
                update: {
                  id: "test",
                  fromVersion: "1.0.0",
                  targetVersion: "1.1.0",
                  dbPath: "/tmp/state.sqlite",
                  status: "pending",
                },
              }),
            );
          }
          if (mode === "stop-during-handoff")
            yield* fs.writeFileString(path.join(baseDir, "runtime", ".service-stopping"), "");
          if (mode === "new-owner") {
            yield* ServerRuntimeState.persistServerRuntimeState({
              path: sharedPath,
              state: { ...state, pid: state.pid + 1 },
            });
            yield* ServerRuntimeState.persistServiceRuntimeState({
              baseDir,
              state: { ...state, pid: state.pid + 1 },
              launcherPid: process.ppid,
            });
          }
        }).pipe(
          Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, managedLauncher),
          Effect.scoped,
        );
        assert.equal(yield* fs.exists(servicePath), mode === "handoff" || mode === "new-owner");
        assert.equal(yield* fs.exists(sharedPath), mode === "new-owner");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records the dev web URL when the server fronts a dev server", () =>
    Effect.gen(function* () {
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: new URL("http://localhost:5733") },
        port: 13_773,
      });

      assert.equal(state.devUrl, "http://localhost:5733/");
      assert.equal(state.origin, "http://127.0.0.1:13773");

      const withoutDev = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });
      assert.isFalse("devUrl" in withoutDev);
    }),
  );

  it.effect("treats a missing runtime state file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves malformed state decode failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to decode server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "decode");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to decode server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state read failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.makeDirectory(statePath);

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to read server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to read server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state persistence failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const blockedDirectory = path.join(root, "not-a-directory");
      const statePath = path.join(blockedDirectory, "server.json");
      yield* fileSystem.writeFileString(blockedDirectory, "blocked");

      const error = yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "persist");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to persist server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
