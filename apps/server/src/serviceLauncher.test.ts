// @effect-diagnostics-next-line nodeBuiltinImport:off - observes the children the launcher spawns with Node built-ins.
import type * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off - the free-space probe is a plain Promise callback.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - models the service manager reading disk through the launcher's Promise callback.
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import {
  renderBootServicePlist,
  renderBootServiceTask,
  renderBootServiceUnit,
} from "./cloud/bootService.ts";
import {
  databaseBackupAdmission,
  Launcher,
  pruneRuntimeVersions,
  main,
  readServiceEnvironment,
  type BackupSpaceProbe,
  readServiceState,
  registerServiceTask,
  serviceLauncherIsRunning,
  serviceLauncherLockPath,
  writeServiceState,
} from "./serviceLauncher.ts";
import {
  compareExactServiceVersions,
  decodeServiceState,
  isExactServiceVersion,
  SERVICE_BOOT_VERSION_FILE,
  disabledServiceTask,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";

const spawnedChildren = vi.hoisted((): Array<NodeChildProcess.ChildProcess> => []);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    spawnedChildren.push(child);
    return child;
  };
  return { ...actual, spawn: spawn as typeof actual.spawn };
});

const writeSparseFile = (filePath: string, size: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, "");
    yield* fileSystem.truncate(filePath, size);
  });

it("accepts only exact semantic versions", () => {
  for (const version of ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3-0", "1.2.3+001"]) {
    assert.isTrue(isExactServiceVersion(version), version);
  }
  for (const version of ["latest", "01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+."]) {
    assert.isFalse(isExactServiceVersion(version), version);
  }
});

it("orders exact semantic versions without treating build metadata as precedence", () => {
  assert.equal(compareExactServiceVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareExactServiceVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.1", "2.0.0-alpha.2"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.2", "2.0.0-alpha.beta"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha-beta", "2.0.0-alpha-alpha"), 1);
  assert.equal(compareExactServiceVersions("2.0.0", "2.0.0-rc.1"), 1);
  assert.equal(compareExactServiceVersions("2.0.0+one", "2.0.0+two"), 0);
});

it("rejects contradictory service state", () => {
  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "0.0.31",
      update: {
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.32",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-3",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-2",
        fromVersion: "1.0.0",
        targetVersion: "0.9.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );
});

const unitPlan = (root: string, version: string) => ({
  program: [`${root}/runtime/versions/${version}/t3`, "__service-launcher"],
  baseDir: root,
  logPath: `${root}/logs/boot-service.log`,
  unitPath: `${root}/unit/t3code.service`,
});

const writeFakeRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionDir: string,
  childSource: string,
  distribution: "archive" | "npm" = "archive",
) =>
  Effect.gen(function* () {
    const entryPath = path.join(
      versionDir,
      distribution === "npm" ? "node_modules/t3/dist/bin.mjs" : "t3",
    );
    yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
    yield* fs.writeFileString(entryPath, `#!${process.execPath}\n${childSource}`);
    yield* fs.chmod(entryPath, 0o755);
    yield* fs.writeFileString(
      path.join(versionDir, ".install-complete"),
      `${path.basename(versionDir)}\n`,
    );
    return entryPath;
  });

const runLauncher = async (root: string) => {
  vi.stubEnv("T3CODE_HOME", root);
  try {
    await main();
  } finally {
    vi.unstubAllEnvs();
  }
};

const fakeServiceUnit = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  version: string,
  render = renderBootServiceUnit,
) =>
  Effect.gen(function* () {
    const plan = unitPlan(root, version);
    yield* fs.makeDirectory(path.dirname(plan.unitPath), { recursive: true });
    const contents = render(plan);
    yield* fs.writeFileString(plan.unitPath, contents);
    const unit = {
      path: plan.unitPath,
      reloads: 0,
      loadedContents: contents,
      failReload: false,
      reload: async () => {
        unit.reloads += 1;
        if (unit.failReload) throw new Error("daemon-reload failed");
        unit.loadedContents = await NodeFSP.readFile(unit.path, "utf8");
      },
    };
    return unit;
  });

it.layer(NodeServices.layer)("service state persistence", (it) => {
  it.effect(
    "loads optional service.env literally without changing inherited or managed variables",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-env-" });
        const inherited = Object.freeze({
          PATH: "inherited-path",
          T3CODE_HOME: root,
          T3_BOOT_SERVICE_UNIT: "managed-unit",
          T3_SERVICE_LAUNCHER_CONTEXT: "managed-context",
          T3CODE_PORT: "ambient",
        });
        assert.deepEqual(
          yield* Effect.promise(() => readServiceEnvironment(root, inherited)),
          inherited,
        );
        yield* fs.writeFileString(
          path.join(root, SERVICE_ENV_FILE),
          [
            "# service configuration",
            "export T3CODE_PORT=1234 # inline comment",
            'T3CODE_TOKEN="literal $HOME ${USER} $(whoami) # token"',
            'MULTILINE="first\nsecond"',
            "EMPTY=",
            "PATH=/bad",
            "Path=/bad",
            "T3CODE_HOME=/bad",
            "t3code_home=/bad",
            "T3_BOOT_SERVICE_UNIT=bad",
            "t3_boot_service_unit=bad",
            "T3_SERVICE_LAUNCHER_CONTEXT=bad",
            "t3_service_launcher_context=bad",
          ].join("\n"),
        );
        assert.deepEqual(yield* Effect.promise(() => readServiceEnvironment(root, inherited)), {
          ...inherited,
          T3CODE_PORT: "1234",
          T3CODE_TOKEN: "literal $HOME ${USER} $(whoami) # token",
          MULTILINE: "first\nsecond",
          EMPTY: "",
        });
      }),
  );

  it.effect("registers its task again without enabling one the CLI disabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-task-" });
      const unitPath = path.join(root, "t3code-task.xml");
      const unit = renderBootServiceTask(unitPlan(root, "1.1.0"), {
        userId: "PC\\theo",
        homeDir: "C:\\Users\\theo",
        conhostPath: "conhost.exe",
      });
      yield* fs.writeFileString(unitPath, unit);
      // Task Scheduler's copy: `t3 doctor` disabled it to keep the service stopped.
      let task = disabledServiceTask(unit.replace("1.1.0", "1.0.0"));
      const schtasks = async (...args: ReadonlyArray<string>) => {
        if (args[0] === "/Create") task = await NodeFSP.readFile(args[2] ?? "", "utf8");
        return { stdout: task };
      };

      yield* Effect.promise(() => registerServiceTask(unitPath, "t3code-PC-theo", schtasks));
      assert.equal(task, disabledServiceTask(unit));
      assert.deepEqual(yield* fs.readDirectory(root), ["t3code-task.xml"]);

      task = unit.replace("1.1.0", "1.0.0");
      yield* Effect.promise(() => registerServiceTask(unitPath, "t3code-PC-theo", schtasks));
      assert.equal(task, unit);
    }),
  );

  it.effect("finds its unit through the manager's environment, not service.env", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-unit-" });
      const home = path.join(root, "home");
      const unitPath = path.join(home, "Library", "LaunchAgents", "t3code.plist");
      const render = (version: string) =>
        renderBootServicePlist(unitPlan(root, version), { homeDir: home, environmentPath: "" });
      yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
      yield* fs.writeFileString(unitPath, render("1.0.0"));
      // The server may run with another HOME; the launch agent still lives in the manager's.
      yield* fs.writeFileString(path.join(root, SERVICE_ENV_FILE), "HOME=/elsewhere\n");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.1.0"),
        "process.exit(0);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(path.join(root, "runtime", "service-state.json"), {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.1.0",
          update: {
            id: "update-1",
            fromVersion: "1.0.0",
            targetVersion: "1.1.0",
            status: "committed",
          },
        }),
      );
      vi.stubEnv("HOME", home);
      vi.stubEnv("T3_BOOT_SERVICE_UNIT", "t3code.plist");

      yield* Effect.promise(() =>
        expect(runLauncher(root)).rejects.toThrow("Active child exited unexpectedly (0)."),
      );

      assert.equal(yield* fs.readFileString(unitPath), render("1.1.0"));
    }),
  );

  it.effect("keeps the service manager's append log bounded when it starts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-log-" });
      const home = path.join(root, "home");
      const unitPath = path.join(home, "Library", "LaunchAgents", "t3code.plist");
      const plan = unitPlan(root, "1.0.0");
      yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
      yield* fs.writeFileString(
        unitPath,
        renderBootServicePlist(plan, { homeDir: home, environmentPath: "" }),
      );
      const oversized = 64 * 1024 * 1024;
      yield* fs.makeDirectory(path.dirname(plan.logPath), { recursive: true });
      yield* fs.writeFileString(plan.logPath, "");
      yield* fs.truncate(plan.logPath, oversized);
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "process.exit(0);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(path.join(root, "runtime", "service-state.json"), {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      vi.stubEnv("HOME", home);
      vi.stubEnv("T3_BOOT_SERVICE_UNIT", "t3code.plist");

      yield* Effect.promise(() =>
        expect(runLauncher(root)).rejects.toThrow("Active child exited unexpectedly (0)."),
      );

      const { size } = yield* fs.stat(plan.logPath);
      expect(Number(size)).toBeLessThan(oversized);
    }),
  );

  it.effect("adopts a legacy install record without rewriting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-migrate-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const activeVersion = "0.0.43-nightly.20260919.1962+build.1";
      const versionDir = path.join(root, "runtime", "versions", activeVersion);
      yield* writeFakeRuntime(
        fs,
        path,
        versionDir,
        `
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./started", import.meta.url), "");
process.exit(0);
`,
      );
      const legacyContents = `{ "protocol": 2, "activeVersion": "${activeVersion}" }`;
      yield* fs.writeFileString(statePath, legacyContents);
      const restartPending = path.join(root, "runtime", ".restart-pending");
      yield* fs.writeFileString(restartPending, `${activeVersion}\n`);

      yield* Effect.promise(() =>
        expect(runLauncher(root)).rejects.toThrow("Active child exited unexpectedly (0)."),
      );

      assert.isTrue(yield* fs.exists(path.join(versionDir, "started")));
      assert.isFalse(yield* fs.exists(restartPending));
      assert.equal(yield* fs.readFileString(statePath), legacyContents);
    }),
  );

  it.effect("refuses non-install legacy documents without rewriting or spawning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-reject-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "process.exit(0);\n",
      );
      const legacy = { protocol: 2, activeVersion: "1.0.0" };
      const childCount = spawnedChildren.length;
      for (const contents of [
        JSON.stringify({
          ...legacy,
          update: {
            id: "u",
            fromVersion: "1.0.0",
            targetVersion: "1.1.0",
            dbPath: "/tmp/state.sqlite",
            status: "pending",
          },
        }),
        JSON.stringify({ ...legacy, update: null }),
        JSON.stringify({ ...legacy, extra: true }),
        JSON.stringify({ ...legacy, protocol: 1 }),
        JSON.stringify({ ...legacy, protocol: 5 }),
        JSON.stringify({ ...legacy, activeVersion: "latest" }),
        "{ invalid JSON",
      ]) {
        yield* fs.writeFileString(statePath, contents);
        yield* Effect.promise(() =>
          expect(runLauncher(root)).rejects.toThrow("Service state is invalid or unsupported."),
        );
        assert.equal(yield* fs.readFileString(statePath), contents);
        assert.equal(spawnedChildren.length, childCount);
      }
    }),
  );

  it.effect("refuses a legacy state whose runtime is missing without rewriting or spawning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-layout-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const contents = '{ "protocol": 2, "activeVersion": "1.0.0" }';
      yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
      yield* fs.writeFileString(statePath, contents);
      const childCount = spawnedChildren.length;

      yield* Effect.promise(() =>
        expect(runLauncher(root)).rejects.toThrow(
          "Selected t3@1.0.0 runtime is missing or incomplete.",
        ),
      );
      assert.equal(yield* fs.readFileString(statePath), contents);
      assert.equal(spawnedChildren.length, childCount);
    }),
  );

  it.effect("a fresh launcher clears a restart deferred by t3 update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-restart-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const restartPending = path.join(root, "runtime", SERVICE_RESTART_PENDING_FILE);
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        "setInterval(() => {}, 1_000);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const run = () =>
        Effect.gen(function* () {
          const launcher = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
          );
          const running = launcher.run();
          yield* Effect.promise(() => launcher.stop("SIGTERM"));
          yield* Effect.promise(() => running);
        });

      yield* fs.writeFileString(restartPending, "1.0.1\n");
      yield* run();
      assert.isTrue(yield* fs.exists(restartPending));

      yield* fs.writeFileString(restartPending, "1.0.0\n");
      yield* run();
      assert.isFalse(yield* fs.exists(restartPending));
    }),
  );

  it.effect("prunes old runtimes but keeps rollback, newer, and bootable versions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-prune-" });
      const runtimeDir = path.join(root, "runtime");
      const versionsDir = path.join(runtimeDir, "versions");
      const entries = [
        "0.0.8",
        "0.0.9",
        "0.0.10",
        "0.0.11",
        "0.0.12",
        "0.0.13",
        "0.0.14",
        "0.0.15",
        "0.1.0",
        ".staging-x",
      ];
      for (const entry of entries) {
        yield* fs.makeDirectory(path.join(versionsDir, entry), { recursive: true });
      }
      // A unit replacement from 0.0.8 to 0.0.9 did not finish, and a deferred
      // `t3 update` restart still waits on 0.0.11; the running launcher is
      // 0.0.10.
      yield* fs.writeFileString(path.join(runtimeDir, SERVICE_BOOT_VERSION_FILE), "0.0.8\n0.0.9\n");
      yield* fs.writeFileString(path.join(runtimeDir, SERVICE_RESTART_PENDING_FILE), "0.0.11\n");

      yield* Effect.promise(() =>
        pruneRuntimeVersions(
          root,
          {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "0.0.15",
            // 0.0.14 failed earlier; the last good version is 0.0.12.
            update: {
              id: "update-1",
              fromVersion: "0.0.12",
              targetVersion: "0.0.15",
              status: "committed",
            },
          },
          [path.join(versionsDir, "0.0.10", "t3"), undefined],
        ),
      );

      // Only 0.0.13 is gone. 0.0.14 is the newest older version, 0.0.12 the
      // committed update's origin, 0.0.8 and 0.0.9 what the unit may boot,
      // 0.0.10 the running launcher, 0.0.11 the deferred restart, 0.1.0 a
      // possible staged update, and non-version entries are never touched.
      assert.deepEqual((yield* fs.readDirectory(versionsDir)).toSorted(), [
        ".staging-x",
        "0.0.10",
        "0.0.11",
        "0.0.12",
        "0.0.14",
        "0.0.15",
        "0.0.8",
        "0.0.9",
        "0.1.0",
      ]);
    }),
  );

  it.effect("stops pruning when a version marker exists but cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-prune-" });
      const runtimeDir = path.join(root, "runtime");
      const versionsDir = path.join(runtimeDir, "versions");
      for (const version of ["0.0.1", "0.0.2", "0.0.3"]) {
        yield* fs.makeDirectory(path.join(versionsDir, version), { recursive: true });
      }
      // A directory in the marker's place fails the read with EISDIR.
      yield* fs.makeDirectory(path.join(runtimeDir, SERVICE_BOOT_VERSION_FILE));

      const outcome = yield* Effect.promise(() =>
        pruneRuntimeVersions(
          root,
          { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: "0.0.3" },
          [],
        ).then(
          () => "pruned",
          () => "stopped",
        ),
      );

      assert.equal(outcome, "stopped");
      assert.deepEqual((yield* fs.readDirectory(versionsDir)).toSorted(), [
        "0.0.1",
        "0.0.2",
        "0.0.3",
      ]);
    }),
  );

  it.effect.each([
    { unitVersion: "1.0.0", replacement: "an intentional downgrade" },
    { unitVersion: "1.2.0", replacement: "another T3 home" },
  ])(
    "recovers a rolled-back update with unit $unitVersion and preserves $replacement",
    ({ unitVersion, replacement }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-repoint-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", "1.1.0"),
          "setInterval(() => {}, 1_000);\n",
        );
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.1.0",
            update: {
              id: "update-1",
              fromVersion: "1.1.0",
              targetVersion: "1.2.0",
              status: "rolled-back",
            },
          }),
        );
        const unit = yield* fakeServiceUnit(fs, path, root, unitVersion);
        const expected = renderBootServiceUnit(
          unitPlan(root, unitVersion === "1.0.0" ? "1.1.0" : unitVersion),
        );
        const createLauncher = Effect.gen(function* () {
          return new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)), {
            serviceUnit: unit,
          });
        });
        const run = (launcher: Launcher) =>
          Effect.gen(function* () {
            const running = launcher.run();
            yield* Effect.promise(() => launcher.stop("SIGTERM"));
            yield* Effect.promise(() => running);
          });

        yield* run(yield* createLauncher);
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.loadedContents, expected);

        yield* run(yield* createLauncher);
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.loadedContents, expected);

        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.1.0",
            update: {
              id: "update-2",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              status: "committed",
            },
          }),
        );
        const staleLauncher = yield* createLauncher;
        // A local install can replace the selection or service owner without stopping this launcher.
        const selectedRoot =
          replacement === "another T3 home" ? path.join(root, "other-home") : root;
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(selectedRoot, "runtime", "versions", "1.0.0"),
          "setInterval(() => {}, 1_000);\n",
        );
        const selectedStatePath = path.join(selectedRoot, "runtime", "service-state.json");
        yield* Effect.promise(() =>
          writeServiceState(selectedStatePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );
        const selectedUnit = renderBootServiceUnit({
          ...unitPlan(selectedRoot, "1.0.0"),
          unitPath: unit.path,
        });
        yield* fs.writeFileString(unit.path, selectedUnit);
        yield* Effect.promise(() => unit.reload());
        const oldHomeState = yield* fs.readFileString(statePath);
        const selectedState = yield* fs.readFileString(selectedStatePath);

        yield* run(staleLauncher);
        assert.equal(yield* fs.readFileString(statePath), oldHomeState);
        assert.equal(yield* fs.readFileString(selectedStatePath), selectedState);
        assert.equal(yield* fs.readFileString(unit.path), selectedUnit, replacement);
        assert.equal(unit.loadedContents, selectedUnit, replacement);
      }),
  );

  it.effect("stays idle instead of exiting when another server owns the T3 home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-refused-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "versions", "1.0.0"),
        `process.exit(${SERVER_EXIT_CODE_STATE_DIR_OWNED});\n`,
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const refused = Promise.withResolvers<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
            if (String(chunk).includes("owns this T3 home")) refused.resolve();
            return true;
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      let completed = false;
      const running = launcher.run().finally(() => {
        completed = true;
      });
      yield* Effect.promise(() => refused.promise);
      assert.isFalse(completed);
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);
    }),
  );

  const commitUpdate = (
    render = renderBootServiceUnit,
    missingUnit = false,
    legacyInstall = false,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service 100% & <test>-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const activatedPath = path.join(root, "activated");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      const unit = yield* fakeServiceUnit(fs, path, root, "1.0.0", render);
      if (missingUnit) yield* fs.remove(unit.path);
      const childSource = `
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
assert.equal(context.protocol, ${SERVICE_LAUNCHER_PROTOCOL});
if (context.update?.status === "pending") {
  const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
  assert.equal(state.activeVersion, "1.0.0");
  assert.equal(state.update.status, "pending");
  ${
    missingUnit
      ? `assert.equal(existsSync(${JSON.stringify(unit.path)}), false);`
      : `assert.equal(readFileSync(${JSON.stringify(unit.path)}, "utf8"), ${JSON.stringify(unit.loadedContents)});`
  }
  process.on("message", (message) => {
    if (message.type === "committed") {
      const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
      assert.equal(state.protocol, ${SERVICE_LAUNCHER_PROTOCOL});
      assert.equal(state.activeVersion, "1.1.0");
      assert.equal(state.update.status, "committed");
      writeFileSync(${JSON.stringify(activatedPath)}, message.updateId);
      process.exit(0);
    }
  });
  process.send({ type: "prepared", updateId: context.update.id });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${JSON.stringify(databasePath)} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      // The old CLI installs the new runtime but writes state with its own protocol.
      yield* fs.writeFileString(
        statePath,
        `${JSON.stringify(
          {
            protocol: legacyInstall ? 3 : SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          },
          null,
          2,
        )}\n`,
      );
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        { serviceUnit: unit },
      );
      const failure = yield* Effect.promise(() =>
        launcher.run().then(
          () => "launcher unexpectedly completed",
          (cause: unknown) => String(cause),
        ),
      );
      assert.include(failure, "Active child exited unexpectedly (0)");
      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.1.0");
      assert.equal(state.update?.status, "committed");
      assert.equal(yield* fs.readFileString(activatedPath), state.update?.id);
      const recover = () =>
        Effect.gen(function* () {
          const fresh = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
            { serviceUnit: unit },
          );
          const running = fresh.run();
          yield* Effect.promise(() => fresh.stop("SIGTERM"));
          yield* Effect.promise(() => running);
        });
      return { fs, root, unit, recover };
    });

  it.effect.each([
    {
      name: "systemd after a protocol-3 local upgrade",
      render: renderBootServiceUnit,
      legacyInstall: true,
    },
    {
      name: "launchd",
      legacyInstall: false,
      render: (plan: Parameters<typeof renderBootServicePlist>[0]) =>
        renderBootServicePlist(plan, {
          homeDir: "/Users/test & <user>",
          environmentPath: "/usr/bin:/custom/runtime/versions/1.0.0",
        }),
    },
    {
      name: "Task Scheduler",
      legacyInstall: false,
      render: (plan: Parameters<typeof renderBootServiceTask>[0]) =>
        renderBootServiceTask(
          { ...plan, program: [`${plan.program[0]}.exe`, "__service-launcher"] },
          { userId: "PC\\theo", homeDir: "C:\\Users\\theo", conhostPath: "conhost.exe" },
        ),
    },
  ])(
    "commits and repoints $name only after the trial reports prepared",
    ({ render, legacyInstall }) =>
      Effect.gen(function* () {
        const { fs, root, unit } = yield* commitUpdate(render, false, legacyInstall);
        const expected = render(unitPlan(root, "1.1.0"));
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.loadedContents, expected);
        assert.equal(unit.reloads, 1);
      }),
  );

  it.effect(
    "keeps a durable commit through unit failure and retries a failed reload on restart",
    () =>
      Effect.gen(function* () {
        const { fs, root, unit, recover } = yield* commitUpdate(renderBootServiceUnit, true);
        assert.equal(unit.reloads, 0);
        const original = renderBootServiceUnit(unitPlan(root, "1.0.0"));
        const expected = renderBootServiceUnit(unitPlan(root, "1.1.0"));
        assert.equal(unit.loadedContents, original);
        yield* fs.writeFileString(unit.path, original);
        unit.failReload = true;
        yield* recover();
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.reloads, 1);
        assert.equal(unit.loadedContents, original);

        unit.failReload = false;
        yield* recover();
        assert.equal(yield* fs.readFileString(unit.path), expected);
        assert.equal(unit.loadedContents, expected);
        assert.equal(unit.reloads, 2);
      }),
  );

  it.effect.each(["archive", "npm"] as const)(
    "rolls back to a %s runtime when the trial reports the wrong update ID",
    (originDistribution) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-rollback-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        const observationsPath = path.join(root, "environment-observations.jsonl");
        const envPath = path.join(root, SERVICE_ENV_FILE);
        yield* fs.writeFileString(envPath, "T3CODE_TEST_SERVICE_TOKEN=initial\n");
        vi.stubEnv("T3CODE_HOME", root);
        vi.stubEnv("T3CODE_TEST_SERVICE_TOKEN", "inherited");
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
        yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        yield* fs.writeFileString(databasePath, "before trial");
        const encodedDatabasePath = JSON.stringify(databasePath);
        const childSource = `
import { appendFileSync, writeFileSync } from "node:fs";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({
  token: process.env.T3CODE_TEST_SERVICE_TOKEN,
  update: context.update?.status ?? "active",
}) + "\\n");
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: "wrong-update" });
} else if (context.update === undefined) {
  writeFileSync(${JSON.stringify(envPath)}, "T3CODE_TEST_SERVICE_TOKEN=changed\\n");
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            childSource,
            version === "1.0.0" ? originDistribution : "archive",
          );
        }
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );
        const unit = yield* fakeServiceUnit(fs, path, root, "0.9.0");

        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
          {
            serviceUnit: unit,
            environment: yield* Effect.promise(() => readServiceEnvironment(root)),
          },
        );
        yield* Effect.promise(() =>
          launcher.run().then(
            () => Promise.reject(new Error("launcher unexpectedly completed")),
            () => Promise.resolve(),
          ),
        );

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.activeVersion, "1.0.0");
        assert.equal(state.update?.status, "rolled-back");
        assert.equal(
          yield* fs.readFileString(unit.path),
          renderBootServiceUnit(unitPlan(root, "1.0.0")),
        );
        assert.equal(unit.reloads, 1);
        assert.equal(
          state.update?.status === "rolled-back" ? state.update.reason : undefined,
          "invalid-prepared",
        );
        const observations = (yield* fs.readFileString(observationsPath))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.deepEqual(observations, [
          { token: "initial", update: "active" },
          { token: "initial", update: "pending" },
          { token: "initial", update: "rolled-back" },
        ]);
        assert.equal((yield* HostProcess.Environment).T3CODE_TEST_SERVICE_TOKEN, "inherited");
        assert.equal(yield* fs.readFileString(envPath), "T3CODE_TEST_SERVICE_TOKEN=changed\n");
      }),
  );

  it.effect.each(
    (["file", "symlink", "dangling symlink"] as const).flatMap((kind) =>
      (["cloned", "compressed"] as const).map((backup) => ({ kind, backup })),
    ),
  )(
    "restores a $backup backup when a migrating trial exits, with the database a $kind",
    ({ kind, backup }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-db-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        const databaseFile =
          kind === "file" ? databasePath : path.join(root, "data", "original.sqlite");
        const linkTarget = kind === "dangling symlink" ? "../original.sqlite" : databaseFile;
        const original = "database before migration";
        const backupListingPath = path.join(root, "backup-listing.txt");
        yield* fs.makeDirectory(path.dirname(databaseFile), { recursive: true });
        if (kind === "dangling symlink") {
          yield* fs.makeDirectory(path.join(root, "data", "sub"));
          yield* fs.symlink(path.join(root, "data", "sub"), path.dirname(databasePath));
        } else {
          yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        }
        yield* fs.writeFileString(databaseFile, original);
        if (kind !== "file") yield* fs.symlink(linkTarget, databasePath);
        yield* fs.writeFileString(`${databaseFile}-wal`, "committed wal");
        const encodedDatabasePath = JSON.stringify(databasePath);
        const childSource = `
import { existsSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  const backupDir = join(${JSON.stringify(path.join(root, "runtime", "db-backup"))}, context.update.id${backup === "cloned" ? "" : ' + "-zstd"'});
  const plainDir = join(${JSON.stringify(path.join(root, "runtime", "db-backup"))}, context.update.id);
  writeFileSync(${JSON.stringify(backupListingPath)}, readdirSync(backupDir).sort().join(",") + (existsSync(plainDir) ? "" : " (no plain dir)"));
  writeFileSync(context.update.dbPath, "database after migration");
  writeFileSync(realpathSync(context.update.dbPath) + "-wal", "trial wal");
  writeFileSync(realpathSync(context.update.dbPath) + "-shm", "trial shm");
  ${kind === "dangling symlink" ? "unlinkSync(realpathSync(context.update.dbPath));" : ""}
  process.exit(1);
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            childSource,
          );
        }
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );

        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
          { backupSpaceProbe: { canClone: () => Promise.resolve(backup === "cloned") } },
        );
        yield* Effect.promise(() =>
          launcher.run().then(
            () => Promise.reject(new Error("launcher unexpectedly completed")),
            () => Promise.resolve(),
          ),
        );

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.activeVersion, "1.0.0");
        assert.equal(state.update?.status, "rolled-back");
        assert.equal(
          yield* fs.readFileString(backupListingPath),
          backup === "cloned"
            ? "database,database-wal"
            : "database-wal.zst,database.zst (no plain dir)",
        );
        assert.equal(yield* fs.readFileString(databaseFile), original);
        if (kind === "dangling symlink" && backup === "compressed") {
          assert.equal((yield* fs.stat(databaseFile)).mode & 0o777, 0o600);
        }
        if (kind !== "file") assert.equal(yield* fs.readLink(databasePath), linkTarget);
        assert.isFalse(yield* fs.exists(path.join(root, "original.sqlite")));
        assert.equal(yield* fs.readFileString(`${databaseFile}-wal`), "committed wal");
        assert.isFalse(yield* fs.exists(`${databaseFile}-shm`));
        const updateId = state.update?.id;
        assert.isDefined(updateId);
        assert.deepEqual(yield* fs.readDirectory(path.join(root, "runtime", "db-backup")), []);
      }),
  );

  it.effect.each(["wal", "delete"] as const)(
    "backs up a %s-mode database (online when WAL) and restores its final state",
    (journalMode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-online-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        const observationsPath = path.join(root, "observations.json");
        yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        // SQLite keeps -wal beside the symlink's target, so the backup must restore it there.
        yield* fs.symlink("actual.sqlite", databasePath);
        const seed = new NodeSqlite.DatabaseSync(databasePath);
        seed.exec(`
        PRAGMA journal_mode = ${journalMode};
        CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
        INSERT INTO events (payload) SELECT 'before the update ' || i FROM n;
      `);
        seed.close();

        const encoded = JSON.stringify({ root, databasePath, observationsPath, journalMode });
        const childSource = `
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const paths = ${encoded};
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(paths.observationsPath + ".trial", JSON.stringify(
    readdirSync(paths.root + "/runtime/db-backup/" + context.update.id +
      (existsSync(paths.root + "/runtime/db-backup/" + context.update.id) ? "" : "-zstd")).sort(),
  ));
  const trial = new DatabaseSync(context.update.dbPath);
  trial.exec("PRAGMA journal_mode = " + paths.journalMode + "; INSERT INTO events (payload) VALUES ('trial');");
  trial.close();
  process.exit(1);
} else if (context.update === undefined) {
  const db = new DatabaseSync(paths.databasePath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = " + paths.journalMode + ";");
  const insert = db.prepare("INSERT INTO events (payload) VALUES (?)");
  const writer = setInterval(() => insert.run("written while serving"), 1);
  process.once("SIGTERM", () => {
    clearInterval(writer);
    insert.run("last write before stopping");
    const backupRoot = paths.root + "/runtime/db-backup";
    writeFileSync(paths.observationsPath, JSON.stringify({
      backupsAtStop: readdirSync(backupRoot).map((entry) => readdirSync(backupRoot + "/" + entry)),
      rows: db.prepare("SELECT count(*) AS n FROM events").get().n,
    }));
    db.close();
    process.exit(0);
  });
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath });
} else {
  process.exit(0);
}
`;
        for (const version of ["1.0.0", "1.1.0"]) {
          yield* writeFakeRuntime(
            fs,
            path,
            path.join(root, "runtime", "versions", version),
            childSource,
          );
        }
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );

        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
          {
            backupSpaceProbe: { canClone: async () => false },
          },
        );
        yield* Effect.promise(() =>
          launcher.run().then(
            () => Promise.reject(new Error("launcher unexpectedly completed")),
            () => Promise.resolve(),
          ),
        );

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.update?.status, "rolled-back");
        const observed = JSON.parse(yield* fs.readFileString(observationsPath));
        // A WAL database's main file is copied before the server is asked to stop; others fall back offline.
        assert.deepEqual(observed.backupsAtStop, journalMode === "wal" ? [["database"]] : []);
        assert.isAbove(observed.rows, 501);
        // Only the online copy holds no -shm: the offline fallback copies the one the server left.
        assert.deepEqual(
          JSON.parse(yield* fs.readFileString(`${observationsPath}.trial`)),
          journalMode === "wal" ? ["database", "database-wal"] : ["database.zst"],
        );
        const restored = new NodeSqlite.DatabaseSync(databasePath);
        try {
          assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
          assert.equal(
            restored.prepare("SELECT count(*) AS n FROM events").get()?.n,
            observed.rows,
          );
          assert.equal(
            restored
              .prepare(
                "SELECT count(*) AS n FROM events WHERE payload = 'last write before stopping'",
              )
              .get()?.n,
            1,
          );
        } finally {
          restored.close();
        }
      }),
  );

  const requestUpdate = (backupSpaceProbe: Partial<BackupSpaceProbe>, databaseSize?: number) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-space-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const replyPath = path.join(root, "rejection.txt");
      const trialMarker = path.join(root, "trial-started");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      if (databaseSize === undefined) yield* fs.writeFileString(databasePath, "database");
      else yield* writeSparseFile(databasePath, databaseSize);
      const encoded = JSON.stringify({ databasePath, replyPath, trialMarker });
      const childSource = `
import { writeFileSync } from "node:fs";
const paths = ${encoded};
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(paths.trialMarker, "started");
  process.exit(1);
} else if (context.update === undefined) {
  process.on("message", (message) => {
    if (message.type === "update-rejected") {
      writeFileSync(paths.replyPath, message.reason);
      process.exit(0);
    }
  });
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        { backupSpaceProbe },
      );
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      return {
        reason: yield* fs.readFileString(replyPath).pipe(Effect.orElseSucceed(() => "")),
        trialStarted: yield* fs.exists(trialMarker),
        state: yield* Effect.promise(() => readServiceState(statePath)),
        database:
          databaseSize === undefined
            ? yield* fs.readFileString(databasePath)
            : Number((yield* fs.stat(databasePath)).size),
        backups: yield* fs.readDirectory(path.join(root, "runtime", "db-backup")),
      };
    });

  it.effect("refuses a backup that cannot fit and leaves the server running", () =>
    Effect.gen(function* () {
      const { reason, trialStarted, state } = yield* requestUpdate({
        readFreeBytes: () => Promise.resolve(0),
        canClone: () => Promise.resolve(true),
      });

      assert.include(reason, "Not enough free disk space");
      assert.include(reason, "The server was not stopped");
      assert.isFalse(trialStarted);
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  // Free space drops to zero once the server stops; only the pre-stop admission decides the recheck.
  it.effect.each([
    {
      case: "returns to the old version when a compressed-budget backup overruns it",
      databaseSize: 1.5 * 1024 ** 3,
      freeBeforeStop: 1.5 * 1024 ** 3,
      trialStarted: false,
    },
    {
      case: "starts the trial when a full copy fit before stopping",
      databaseSize: undefined,
      freeBeforeStop: 500 * 1024 ** 2,
      trialStarted: true,
    },
  ])(
    "rechecks space after a compressed backup: $case",
    ({ databaseSize, freeBeforeStop, trialStarted: expected }) =>
      Effect.gen(function* () {
        let freeChecks = 0;
        const { trialStarted, state, database, backups } = yield* requestUpdate(
          {
            readFreeBytes: () => Promise.resolve(freeChecks++ === 0 ? freeBeforeStop : 0),
            canClone: () => Promise.resolve(false),
          },
          databaseSize,
        );

        assert.equal(trialStarted, expected);
        assert.equal(state.activeVersion, "1.0.0");
        assert.equal(
          state.update?.status === "failed" && state.update.reason === "db-backup-failed",
          !expected,
        );
        assert.equal(database, databaseSize ?? "database");
        assert.deepEqual(backups, []);
      }),
  );

  it.effect("refuses the update when free space cannot be checked", () =>
    Effect.gen(function* () {
      const { reason, trialStarted, state } = yield* requestUpdate({
        readFreeBytes: () => Promise.reject(new Error("statfs unavailable")),
      });

      assert.include(
        reason,
        "Could not check that the database backup fits before updating: statfs unavailable",
      );
      assert.isFalse(trialStarted);
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("holds its lock while it serves and stops the server over IPC, marker set", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-control-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const reportPath = path.join(root, "stopped-with-marker");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      const encoded = JSON.stringify({
        databasePath,
        reportPath,
        markerPath: path.join(root, "runtime", SERVICE_STOP_MARKER_FILE),
      });
      const childSource = `
const fs = require("node:fs");
const paths = ${encoded};
process.on("message", (message) => {
  if (message.type !== "stop") return;
  fs.writeFileSync(paths.reportPath, String(fs.existsSync(paths.markerPath)));
  process.exit(0);
});
process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath });
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const lockPath = serviceLauncherLockPath(root);
      const serving = Promise.withResolvers<void>();
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        {
          lockPath,
          stopChildOverIpc: true,
          // The update request proves the child is up; refusing it leaves the server running.
          backupSpaceProbe: {
            readFreeBytes: () => {
              serving.resolve();
              return Promise.resolve(0);
            },
            canClone: () => Promise.resolve(false),
          },
        },
      );
      const running = launcher.run();
      yield* Effect.promise(() => Promise.race([serving.promise, running]));

      assert.isTrue(yield* Effect.promise(() => serviceLauncherIsRunning(lockPath)));
      // What losing the task's console does.
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);
      assert.equal(yield* fs.readFileString(reportPath), "true");
      assert.isFalse(yield* Effect.promise(() => serviceLauncherIsRunning(lockPath)));
    }),
  );

  it.effect("leaves a pending update alone when stopped while it starts up", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-startup-stop-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      // Recovery would roll this back: the target runtime is missing.
      const pending = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
        update: {
          id: "update-1",
          fromVersion: "1.0.0",
          targetVersion: "1.1.0",
          dbPath: path.join(root, "userdata", "state.sqlite"),
          status: "pending",
        },
      } as const;
      yield* Effect.promise(() => writeServiceState(statePath, pending));
      const lockPath = serviceLauncherLockPath(root);
      const launcher = new Launcher(root, pending, { lockPath });

      const running = launcher.run();
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);

      // The lock is released only once the launcher is done with the home.
      assert.isFalse(yield* Effect.promise(() => serviceLauncherIsRunning(lockPath)));
      assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), pending);
    }),
  );

  it.effect("records no update when the server exits during the backup check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-exit-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      const encoded = JSON.stringify({ databasePath });
      const childSource = `
const paths = ${encoded};
process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath }, () =>
  process.exit(3),
);
setInterval(() => {}, 1_000);
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        {
          backupSpaceProbe: {
            readFreeBytes: () => {
              const child = spawnedChildren.at(-1)!;
              return new Promise((resolve) => {
                if (!child.connected) resolve(Number.MAX_SAFE_INTEGER);
                else child.once("disconnect", () => resolve(Number.MAX_SAFE_INTEGER));
              });
            },
          },
        },
      );
      const failure = yield* Effect.promise(() =>
        launcher.run().then(
          () => new Error("launcher unexpectedly completed"),
          (cause: unknown) => cause as Error,
        ),
      );

      assert.include(failure.message, "Active child exited unexpectedly (3)");
      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("checks database backup space against clone or compressed-copy needs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-blocker-" });
      const databasePath = path.join(root, "state.sqlite");
      yield* writeSparseFile(databasePath, 10 * 1024 ** 3);
      const check = (free: number, cloneable: boolean) =>
        Effect.promise(() =>
          databaseBackupAdmission(root, databasePath, {
            readFreeBytes: () => Promise.resolve(free),
            canClone: () => Promise.resolve(cloneable),
          }),
        );

      assert.deepEqual(yield* check(11 * 1024 ** 3, false), { fullCopyFits: true });
      assert.deepEqual(yield* check(1.5 * 1024 ** 3, true), { fullCopyFits: false });
      assert.include((yield* check(0.5 * 1024 ** 3, true)).refusal, "1.0 GB needed, 0.5 GB free");
      assert.deepEqual(yield* check(3.5 * 1024 ** 3, false), { fullCopyFits: false });
      const { refusal } = yield* check(3 * 1024 ** 3, false);
      assert.include(refusal, "Not enough free disk space");
      assert.include(refusal, "3.5 GB needed, 3.0 GB free");
      assert.include(refusal, "The server was not stopped");
    }),
  );
  it.effect("reclaims partial backups left by killed updates before checking space", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-launcher-orphan-" });
      const databasePath = path.join(root, "state.sqlite");
      yield* writeSparseFile(databasePath, 10 * 1024 ** 3);
      const backupRoot = path.join(root, "runtime", "db-backup");
      const orphan = path.join(backupRoot, "earlier-update.staging");
      const completed = path.join(backupRoot, "completed-update");
      yield* fs.makeDirectory(orphan, { recursive: true });
      yield* fs.writeFileString(path.join(orphan, "database"), "partial copy");
      yield* fs.makeDirectory(completed);
      yield* fs.writeFileString(path.join(completed, "database"), "complete copy");

      // The orphan is what keeps this disk too full for a full copy.
      const blocker = yield* Effect.promise(() =>
        databaseBackupAdmission(root, databasePath, {
          readFreeBytes: () => Promise.resolve((NodeFS.existsSync(orphan) ? 8 : 11) * 1024 ** 3),
          canClone: () => Promise.resolve(false),
        }),
      );

      assert.deepEqual(blocker, { fullCopyFits: true });
      assert.isFalse(yield* fs.exists(orphan));
      assert.isTrue(yield* fs.exists(path.join(completed, "database")));
    }),
  );
});
