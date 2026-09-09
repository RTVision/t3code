import { expect, it } from "@effect/vitest";
import { EnvironmentId, ServerSelfUpdateError, type ServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ProcessRunner, type ProcessRunInput } from "../processRunner.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "../cloud/serviceProtocol.ts";
import {
  issueServiceUpdateToken,
  requestServiceUpdate,
  updateRunningService,
} from "./serviceUpdate.ts";

const config = (version = "0.0.42", managed = true): Pick<ServerConfig, "environment"> => ({
  environment: {
    environmentId: EnvironmentId.make("test"),
    label: "OpenRC daemon",
    platform: { os: "linux", arch: "x64" },
    serverVersion: version,
    capabilities: managed
      ? { repositoryIdentity: true, serverSelfUpdate: "boot-service" }
      : { repositoryIdentity: true },
  },
});

it.effect("updates a launcher-managed daemon using its RPC", () =>
  Effect.gen(function* () {
    const versions: string[] = [];
    const result = yield* requestServiceUpdate(
      {
        config: Effect.succeed(config()),
        update: (targetVersion) =>
          Effect.sync(() => {
            versions.push(targetVersion);
            return { targetVersion, method: "boot-service" as const };
          }),
      },
      "0.0.43",
    );
    expect(versions).toEqual(["0.0.43"]);
    expect(result).toMatchObject({ method: "boot-service" });
  }),
);

it.effect("refuses a different unmanaged server without updating it", () =>
  Effect.gen(function* () {
    const error = yield* requestServiceUpdate(
      {
        config: Effect.succeed(config("0.0.42", false)),
        update: () => Effect.die("must not update"),
      },
      "0.0.43",
    ).pipe(Effect.flip);
    expect(error._tag).toBe("ServiceUpdateConnectionError");
  }),
);

it.effect("keeps downgrade protection before requesting a daemon update", () =>
  Effect.gen(function* () {
    const error = yield* requestServiceUpdate(
      { config: Effect.succeed(config("0.0.44")), update: () => Effect.die("must not update") },
      "0.0.43",
    ).pipe(Effect.flip);
    expect(error._tag).toBe("BootServiceDowngradeRefusedError");
    const result = yield* requestServiceUpdate(
      {
        config: Effect.succeed(config("0.0.44")),
        update: () => Effect.die("downgrades must use native reconciliation"),
      },
      "0.0.43",
      true,
    );
    expect(result).toBe(false);
  }),
);

it.effect("does not restart a daemon already on the requested version", () =>
  Effect.gen(function* () {
    const result = yield* requestServiceUpdate(
      { config: Effect.succeed(config()), update: () => Effect.die("must not update") },
      "0.0.42",
    );
    expect(result).toBe("current");
  }),
);

it.effect("propagates daemon update failures instead of installing a replacement", () =>
  Effect.gen(function* () {
    const error = new ServerSelfUpdateError({ reason: "candidate blocked" });
    const result = yield* requestServiceUpdate(
      { config: Effect.succeed(config()), update: () => Effect.fail(error) },
      "0.0.43",
    ).pipe(Effect.flip);
    expect(result).toBe(error);
  }),
);

it.effect("authenticates with the installed CLI before any new-version migrations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-auth-test-" });
    // Invalid SQLite proves this CLI never opens the old database.
    yield* fs.makeDirectory(path.join(baseDir, "runtime"));
    yield* fs.makeDirectory(path.join(baseDir, "userdata"));
    yield* fs.writeFileString(
      path.join(baseDir, "userdata", "state.sqlite"),
      "old schema untouched",
    );
    yield* fs.writeFileString(
      path.join(baseDir, "runtime", "service-state.json"),
      JSON.stringify({ protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: "0.0.41" }),
    );
    const calls: ProcessRunInput[] = [];
    const token = yield* issueServiceUpdateToken(baseDir).pipe(
      Effect.provideService(ProcessRunner, {
        run: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return {
              stdout: "test-credential\n",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
    );
    expect(token).toBe("test-credential");
    expect(calls[0]?.args).toEqual([
      path.join(baseDir, "runtime/versions/0.0.41/node_modules/t3/dist/bin.mjs"),
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
    ]);
    expect(yield* fs.readFileString(path.join(baseDir, "userdata", "state.sqlite"))).toBe(
      "old schema untouched",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["absent", "daemon-record", "unreadable", "lan-origin"] as const)(
  "handles %s service state without replacing a known daemon",
  (mode) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-update-fallback-" });
      yield* fs.makeDirectory(path.join(baseDir, "userdata"));
      yield* fs.makeDirectory(path.join(baseDir, "runtime"));
      const runtime = {
        version: 1,
        pid: process.pid,
        port: 1,
        origin: mode === "lan-origin" ? "http://192.0.2.1:1" : "http://127.0.0.1:1",
        startedAt: "2026-09-09T00:00:00Z",
      };
      const serverRuntimeStatePath = path.join(baseDir, "userdata", "server-runtime.json");
      yield* fs.writeFileString(serverRuntimeStatePath, JSON.stringify(runtime));
      if (mode === "daemon-record") {
        yield* fs.writeFileString(
          path.join(baseDir, "runtime", "server-runtime.json"),
          JSON.stringify({ ...runtime, launcherPid: process.pid }),
        );
      } else if (mode === "unreadable") {
        yield* fs.makeDirectory(path.join(baseDir, "runtime", "service-state.json"));
      }
      const run = updateRunningService({ baseDir, serverRuntimeStatePath }, "0.0.44");
      if (mode === "absent" || mode === "lan-origin") expect(yield* run).toBe(false);
      else {
        const error = yield* run.pipe(Effect.flip);
        expect(error._tag).toBe(
          mode === "daemon-record" ? "ServiceUpdateConnectionError" : "PlatformError",
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
