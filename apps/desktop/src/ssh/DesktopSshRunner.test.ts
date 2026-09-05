import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { assert, describe, it } from "@effect/vitest";
import { matchesSshRunner, selectSshRunner, preflightWslSsh } from "./DesktopSshRunner.ts";

describe("desktop SSH runner selection", () => {
  it.effect(
    "allows key files without an agent and reports missing SSH in the selected distro",
    () => {
      const makeSpawner = (exitCode: number) =>
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              stdout: Stream.make(new TextEncoder().encode("agent-unavailable")),
              stderr: Stream.make(
                new TextEncoder().encode(
                  exitCode === 0 ? "OpenSSH_test" : "ssh: command not found",
                ),
              ),
              all: Stream.empty,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          ),
        );
      return Effect.gen(function* () {
        yield* preflightWslSsh("Debian").pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeSpawner(0)),
        );
        const failure = yield* Effect.result(
          preflightWslSsh("Debian").pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, makeSpawner(127)),
          ),
        );
        assert.isTrue(Result.isFailure(failure));
        if (Result.isFailure(failure))
          assert.include(failure.failure.message, "OpenSSH is unavailable via WSL (Debian)");
      });
    },
  );

  it("follows the Windows settings matrix and preserves other platforms", () => {
    for (const wslBackendEnabled of [false, true]) {
      for (const wslOnly of [false, true]) {
        for (const sshRunner of ["windows", "wsl"] as const) {
          const settings = { wslBackendEnabled, wslOnly, sshRunner };
          assert.equal(
            selectSshRunner("win32", settings),
            wslBackendEnabled && (wslOnly || sshRunner === "wsl") ? "wsl" : "native",
          );
          assert.equal(selectSshRunner("linux", settings), "native");
          assert.equal(selectSshRunner("darwin", settings), "native");
        }
      }
    }
  });
  it("rejects saved environments when credentials would move to another runner or distro", () => {
    const wsl = { kind: "wsl", distro: "Debian" } as const;
    assert.isTrue(matchesSshRunner(wsl, { ...wsl }));
    assert.isFalse(matchesSshRunner(wsl, { kind: "windows" }));
    assert.isFalse(matchesSshRunner(wsl, { kind: "wsl", distro: "Ubuntu" }));
    assert.isTrue(matchesSshRunner(undefined, { kind: "windows" }));
    assert.isFalse(matchesSshRunner(undefined, wsl));
  });
});
