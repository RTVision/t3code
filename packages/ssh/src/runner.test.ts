import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildSshChildEnvironment } from "./auth.ts";
import { collectProcessOutput, remoteStateKey, targetConnectionKey } from "./command.ts";
import {
  buildWslSshEnvironment,
  SshRunner,
  spawnSsh,
  WSL_SSH_SCRIPT,
  WSL_SSH_CLEANUP_SCRIPT,
} from "./runner.ts";

const runner = {
  kind: "wsl",
  distro: "Test Distro",
  homeDir: "/home/test",
  tunnelHost: "127.0.0.1",
} as const;

const makeShellHarness = Effect.fn("makeShellHarness")(function* (script: string) {
  const fs = yield* FileSystem.FileSystem;
  const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-test-" });
  yield* fs.writeFileString(`${directory}/ssh`, `#!/bin/sh\n${script}`);
  yield* fs.chmod(`${directory}/ssh`, 0o700);
  const commands: ChildProcess.StandardCommand[] = [];
  const linuxScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(linuxScope, Exit.void));
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") return nativeSpawner.spawn(command);
    commands.push(command);
    // Exercise the Linux payload with real processes. WSL's Windows argument
    // transport and login-shell environment need the separate Windows smoke test.
    const args = command.args
      .slice(4)
      .map((arg, index) => (index === 0 && arg === "-lc" ? "-c" : arg));
    const spawn = nativeSpawner.spawn(
      ChildProcess.make(command.args[3]!, args, {
        ...command.options,
        env: { ...command.options.env, PATH: `${directory}:/usr/bin:/bin` },
      }),
    );
    return command.args[3] === "bash"
      ? spawn.pipe(Effect.provideService(Scope.Scope, linuxScope))
      : spawn;
  });
  return { spawner, commands, fs };
});

describe("WSL SSH runner", () => {
  it.effect("preserves WSLENV and forwards the cached secret without putting it in argv", () =>
    Effect.gen(function* () {
      const environment = yield* buildWslSshEnvironment({
        SSH_ASKPASS_REQUIRE: "force",
        T3_SSH_AUTH_SECRET: "test secret",
      });
      assert.equal(environment.WSLENV, "EXISTING/u:SSH_ASKPASS_REQUIRE:T3_SSH_AUTH_SECRET");
    }).pipe(Effect.provideService(HostProcessEnvironment, { WSLENV: "EXISTING/u" })),
  );

  it.effect("preserves arguments and stdin and runs POSIX askpass inside the distro", () =>
    Effect.gen(function* () {
      const harness = yield* makeShellHarness('printf "<%s>\\n" "$@"\ncat\n"$SSH_ASKPASS"\n');
      const output = yield* Effect.scoped(
        Effect.gen(function* () {
          const env = yield* buildSshChildEnvironment({
            interactiveAuth: true,
            authSecret: "test password",
          });
          assert.isUndefined(env.SSH_ASKPASS);
          const child = yield* spawnSsh(
            ["-i", "/home/test/key with spaces", "test@host", "sh", "-s"],
            {
              env,
              stdin: Stream.make(new TextEncoder().encode("input payload\n")),
            },
          );
          const result = yield* collectProcessOutput(child.stdout);
          assert.equal(Number(yield* child.exitCode), 0);
          return result;
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, harness.spawner)),
      );
      assert.equal(
        output,
        "<-i>\n</home/test/key with spaces>\n<test@host>\n<sh>\n<-s>\ninput payload\ntest password\n",
      );
      assert.equal(harness.commands[0]?.command, "wsl.exe");
      assert.include(harness.commands[0]?.args ?? [], "-lc");
      assert.notInclude((harness.commands[0]?.args ?? []).join(" "), "test password");
      const runtimeDirectory = harness.commands[0]?.args[7];
      assert.isDefined(runtimeDirectory);
      assert.isFalse(yield* harness.fs.exists(runtimeDirectory!));
    }).pipe(
      Effect.provideService(SshRunner, runner),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  );

  it.effect("disconnect terminates the recorded Linux process and removes its helper", () =>
    Effect.gen(function* () {
      const harness = yield* makeShellHarness('printf "started\\n"\nexec sleep 600\n');
      const scope = yield* Scope.make();
      const child = yield* spawnSsh(["host"], { env: {}, stdin: Stream.empty }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, harness.spawner),
        Effect.provideService(Scope.Scope, scope),
      );
      yield* Stream.runHead(child.stdout);
      assert.isTrue(yield* child.isRunning);
      yield* Scope.close(scope, Exit.void);
      yield* Effect.exit(child.exitCode);
      assert.isFalse(yield* child.isRunning);
      assert.equal(harness.commands.length, 2);
      assert.isFalse(yield* harness.fs.exists(harness.commands[0]!.args[7]!));
    }).pipe(
      Effect.provideService(SshRunner, runner),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  );

  it.effect("honors cancellation before the distro-side SSH process starts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-cancel-test-" });
      const directory = `${parent}/runtime`;
      const cleanup = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", WSL_SSH_CLEANUP_SCRIPT, "cleanup", directory]),
      );
      assert.equal(Number(yield* cleanup.exitCode), 0);
      const child = yield* spawner.spawn(
        ChildProcess.make("bash", ["-c", WSL_SSH_SCRIPT, "t3-ssh", directory, "unused-host"]),
      );
      assert.equal(Number(yield* child.exitCode), 125);
      assert.isFalse(yield* fs.exists(directory));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it("separates runner connections without changing the remote server identity", () => {
    const target = { alias: "host", hostname: "host", username: null, port: null };
    const wsl = { ...target, runner: { kind: "wsl", distro: "Debian" } as const };
    assert.notEqual(targetConnectionKey(target), targetConnectionKey(wsl));
    assert.equal(remoteStateKey(target), remoteStateKey(wsl));
  });
});
