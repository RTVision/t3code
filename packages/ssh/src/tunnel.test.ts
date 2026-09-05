import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshPasswordPrompt } from "./auth.ts";
import { SshReadinessError } from "./errors.ts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteT3RunnerScript,
  describeReadinessCause,
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  REMOTE_PICK_PORT_SCRIPT,
  SshEnvironmentManager,
  waitForHttpReady,
} from "./tunnel.ts";

const TEST_NODE_ENGINE_RANGE = "^22.16 || ^23.11 || >=24.10";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeDelayedSuccessfulProcess = (stdout: string, delayMs: number) => {
  const process = makeSuccessfulProcess(stdout);
  return {
    ...process,
    exitCode: Effect.sleep(Duration.millis(delayMs)).pipe(
      Effect.as(ChildProcessSpawner.ExitCode(0)),
    ),
  };
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const reconnectTarget = {
  alias: "devbox",
  hostname: "devbox.example.com",
  username: "julius",
  port: 2222,
} as const;

const makeReconnectHarness = Effect.fn("makeReconnectHarness")(function* () {
  const spawned = yield* Queue.unbounded<{
    readonly exited: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
    readonly at: number;
    readonly args: ReadonlyArray<string>;
  }>();
  const readinessRequested = yield* Queue.unbounded<void>();
  let readiness: Deferred.Deferred<void> | null = null;
  let spawnCount = 0;
  let killCount = 0;
  let stopCount = 0;
  let remotePort = 3773;
  let failNextLaunch = false;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = commandArgs(command);
      if (args.includes("-N")) {
        spawnCount += 1;
        const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        yield* Queue.offer(spawned, { exited, at: yield* Clock.currentTimeMillis, args });
        return ChildProcessSpawner.makeHandle({
          ...makeSuccessfulProcess(""),
          exitCode: Deferred.await(exited),
          isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
          kill: () =>
            Effect.sync(() => {
              killCount += 1;
            }).pipe(
              Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(143))),
              Effect.asVoid,
            ),
        });
      }
      if (args.includes("sh") && args.includes("--")) {
        if (failNextLaunch) {
          failNextLaunch = false;
          return ChildProcessSpawner.makeHandle({
            ...makeSuccessfulProcess(""),
            stderr: Stream.make(new TextEncoder().encode("Permission denied (publickey).")),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
          });
        }
        return makeSuccessfulProcess(`{"remotePort":${remotePort}}\n`);
      }
      if (args.includes("sh")) stopCount += 1;
      return makeSuccessfulProcess("\n");
    }),
  );
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Queue.offer(readinessRequested, undefined);
      if (readiness !== null) yield* Deferred.await(readiness);
      return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
    }),
  );
  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HttpClient.HttpClient, httpClient),
    Layer.succeed(NetService.NetService, testNetService),
    SshPasswordPrompt.disabledLayer,
    SshEnvironmentManager.layer(),
  );
  return {
    spawned,
    readinessRequested,
    layer,
    blockReadiness: (deferred: Deferred.Deferred<void>) => {
      readiness = deferred;
    },
    counts: () => ({ spawnCount, killCount, stopCount }),
    setRemotePort: (port: number) => {
      remotePort = port;
    },
    failAuthentication: () => {
      failNextLaunch = true;
    },
  };
});

describe("SSH tunnel reconnect", () => {
  it.effect(
    "keeps the forwarded port and waits for HTTP readiness before reusing a reconnect",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeReconnectHarness();
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          const first = yield* manager.ensureEnvironment(reconnectTarget);
          const original = yield* Queue.take(harness.spawned);
          yield* Queue.take(harness.readinessRequested);
          const ready = yield* Deferred.make<void>();
          harness.blockReadiness(ready);
          yield* Deferred.succeed(original.exited, ChildProcessSpawner.ExitCode(255));
          yield* TestClock.adjust(2_000);
          const restarted = yield* Queue.take(harness.spawned);
          yield* Queue.take(harness.readinessRequested);
          const ensure = yield* Effect.forkChild(manager.ensureEnvironment(reconnectTarget));
          yield* Effect.yieldNow;
          assert.isUndefined(ensure.pollUnsafe());
          assert.deepEqual(restarted.args.slice(2), original.args.slice(2));
          assert.include(restarted.args, "BatchMode=yes");
          yield* Deferred.succeed(ready, undefined);
          assert.equal((yield* Fiber.join(ensure)).httpBaseUrl, first.httpBaseUrl);
          yield* manager.disconnectEnvironment(reconnectTarget);
          yield* TestClock.adjust(60_000);
          assert.deepEqual(harness.counts(), { spawnCount: 2, killCount: 2, stopCount: 1 });
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );

  it.effect("backs off repeated exits, caps retries, and resets after a stable connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeReconnectHarness();
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        yield* manager.ensureEnvironment(reconnectTarget);
        let process = yield* Queue.take(harness.spawned);
        for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
          const before = yield* Clock.currentTimeMillis;
          yield* Deferred.succeed(process.exited, ChildProcessSpawner.ExitCode(255));
          yield* TestClock.adjust(delay);
          process = yield* Queue.take(harness.spawned);
          assert.equal(process.at - before, delay);
        }
        yield* TestClock.adjust(60_001);
        const before = yield* Clock.currentTimeMillis;
        yield* Deferred.succeed(process.exited, ChildProcessSpawner.ExitCode(255));
        yield* TestClock.adjust(2_000);
        process = yield* Queue.take(harness.spawned);
        assert.equal(process.at - before, 2_000);
        yield* manager.disconnectEnvironment(reconnectTarget);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("relaunches a lost remote server while keeping the local port", () =>
    Effect.gen(function* () {
      const harness = yield* makeReconnectHarness();
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        const first = yield* manager.ensureEnvironment(reconnectTarget);
        const original = yield* Queue.take(harness.spawned);
        harness.setRemotePort(3775);
        yield* Deferred.succeed(original.exited, ChildProcessSpawner.ExitCode(255));
        yield* TestClock.adjust(2_000);
        const restarted = yield* Queue.take(harness.spawned);
        const next = yield* manager.ensureEnvironment(reconnectTarget);
        assert.include(restarted.args, "41773:127.0.0.1:3775");
        assert.equal(next.remotePort, 3775);
        assert.equal(next.httpBaseUrl, first.httpBaseUrl);
        assert.equal(harness.counts().stopCount, 0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("leaves authentication failures to a new ensure without background prompts", () =>
    Effect.gen(function* () {
      const harness = yield* makeReconnectHarness();
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        yield* manager.ensureEnvironment(reconnectTarget);
        const original = yield* Queue.take(harness.spawned);
        harness.failAuthentication();
        yield* Deferred.succeed(original.exited, ChildProcessSpawner.ExitCode(255));
        yield* TestClock.adjust(1_000);
        const waiting = yield* Effect.forkChild(
          Effect.result(manager.ensureEnvironment(reconnectTarget)),
        );
        yield* TestClock.adjust(1_000);
        const result = yield* Fiber.join(waiting);
        assert.isTrue(Result.isFailure(result));
        yield* TestClock.adjust(60_000);
        assert.equal(harness.counts().spawnCount, 1);
        assert.equal(harness.counts().stopCount, 0);
        yield* manager.ensureEnvironment(reconnectTarget);
        assert.equal(harness.counts().spawnCount, 2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("disconnect during readiness kills the new child and cancels the reconnect", () =>
    Effect.gen(function* () {
      const harness = yield* makeReconnectHarness();
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        yield* manager.ensureEnvironment(reconnectTarget);
        const original = yield* Queue.take(harness.spawned);
        yield* Queue.take(harness.readinessRequested);
        harness.blockReadiness(yield* Deferred.make<void>());
        yield* Deferred.succeed(original.exited, ChildProcessSpawner.ExitCode(255));
        yield* TestClock.adjust(2_000);
        yield* Queue.take(harness.spawned);
        yield* Queue.take(harness.readinessRequested);
        yield* manager.disconnectEnvironment(reconnectTarget);
        yield* TestClock.adjust(60_000);
        assert.deepEqual(harness.counts(), { spawnCount: 2, killCount: 2, stopCount: 1 });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("disconnect during backoff cancels pending ensures and prevents respawning", () =>
    Effect.gen(function* () {
      const harness = yield* makeReconnectHarness();
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        yield* manager.ensureEnvironment(reconnectTarget);
        const original = yield* Queue.take(harness.spawned);
        yield* Deferred.succeed(original.exited, ChildProcessSpawner.ExitCode(255));
        yield* TestClock.adjust(1_000);
        const ensure = yield* Effect.forkChild(
          Effect.result(manager.ensureEnvironment(reconnectTarget)),
        );
        yield* Effect.yieldNow;
        yield* manager.disconnectEnvironment(reconnectTarget);
        const result = yield* Fiber.join(ensure);
        assert.isTrue(Result.isFailure(result));
        yield* TestClock.adjust(60_000);
        assert.deepEqual(harness.counts(), { spawnCount: 1, killCount: 1, stopCount: 1 });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("bounds foreground waits for a reconnect and closes the stale tunnel", () =>
    Effect.gen(function* () {
      const harness = yield* makeReconnectHarness();
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        yield* manager.ensureEnvironment(reconnectTarget);
        const original = yield* Queue.take(harness.spawned);
        harness.blockReadiness(yield* Deferred.make<void>());
        yield* Deferred.succeed(original.exited, ChildProcessSpawner.ExitCode(255));
        yield* TestClock.adjust(2_000);
        yield* Queue.take(harness.spawned);
        yield* Queue.take(harness.readinessRequested);

        const waiting = yield* Effect.forkChild(
          Effect.result(manager.ensureEnvironment(reconnectTarget)),
        );
        yield* TestClock.adjust(20_000);
        const result = yield* Fiber.join(waiting);

        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.instanceOf(result.failure, SshReadinessError);
        // The harness counts the failure log-tail command alongside the remote stop command.
        assert.deepEqual(harness.counts(), { spawnCount: 2, killCount: 2, stopCount: 2 });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});

describe("ssh tunnel scripts", () => {
  it("builds the remote t3 runner with npx and npm fallbacks", () => {
    const script = buildRemoteT3RunnerScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE });

    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(script, 'exec t3 "$@"');
    assert.include(script, 'exec "$T3_CLI_PATH" "$@"');
    assert.include(script, "could not install 't3@latest'");
    assert.include(script, "require_installed_t3_cli npx --yes --package 't3@latest'");
    assert.include(script, "require_installed_t3_cli npm exec --yes --package 't3@latest'");
    assert.include(script, "npm produced no t3 executable");
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/bin"');
    assert.include(script, `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`);
    assert.include(script, "remote_node_satisfies_engine()");
    assert.include(script, "function satisfiesSemverRange");
    assert.include(script, "satisfiesSemverRange(rawVersion, range)");
    assert.include(script, 'prepend_path_if_dir "$VOLTA_HOME/bin"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.asdf/shims"');
    assert.include(script, 'prepend_path_if_dir "$HOME/.local/share/mise/shims"');
    assert.include(script, 'eval "$(fnm env --shell bash)"');
    assert.include(script, "fnm use --silent-if-unchanged");
    assert.include(script, "fnm use default");
    assert.include(script, 'prepend_path_if_dir "$HOME/.nodenv/shims"');
    assert.include(script, 'NVM_DIR="$HOME/.nvm"');
    assert.include(script, "nvm use --silent default");
    assert.include(script, 'for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin');
    assert.notInclude(script, "ensure $NVM_DIR/nvm.sh is available");
  });

  it("does not hard-code a remote node engine range", () => {
    const script = buildRemoteT3RunnerScript();

    assert.include(script, "T3_NODE_ENGINE_RANGE=''");
    assert.notInclude(script, TEST_NODE_ENGINE_RANGE);
  });

  it("shell-quotes package specs in the remote t3 runner", () => {
    const script = buildRemoteT3RunnerScript({
      packageSpec: "t3@nightly; touch /tmp/t3-owned",
    });

    assert.include(
      script,
      "require_installed_t3_cli npx --yes --package 't3@nightly; touch /tmp/t3-owned'",
    );
    assert.notInclude(script, "exec npx --yes t3@nightly; touch /tmp/t3-owned");
  });

  it("builds the remote t3 runner with a node script override", () => {
    const script = buildRemoteT3RunnerScript({
      nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
    });

    assert.include(
      script,
      "T3_NODE_SCRIPT_PATH='/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs'",
    );
    assert.include(script, 'exec node "$T3_NODE_SCRIPT_PATH" "$@"');
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null',
    );
    assert.include(buildRemoteLaunchScript(), "RUNNER_CHANGED=1");
    assert.include(buildRemoteLaunchScript(), "ensure_remote_node_path()");
    assert.include(buildRemoteLaunchScript(), "if ! ensure_remote_node_path; then");
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      `T3_NODE_ENGINE_RANGE='${TEST_NODE_ENGINE_RANGE}'`,
    );
    assert.include(
      buildRemoteLaunchScript({ nodeEngineRange: TEST_NODE_ENGINE_RANGE }),
      "does not satisfy required range ",
    );
    assert.include(buildRemoteLaunchScript(), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteLaunchScript(), "wait_ready");
    assert.include(buildRemoteLaunchScript(), '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(buildRemoteLaunchScript(), '--base-dir "$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemoteLaunchScript(), "server-home");
    assert.include(buildRemoteLaunchScript(), "Remote T3 server did not become ready");
    assert.include(buildRemoteLaunchScript(), 'wait_ready "60000"');
    assert.include(buildRemoteLaunchScript(), 'if [ -s "$LOG_FILE" ]; then');
    assert.include(buildRemoteLaunchScript(), "It wrote nothing to %s");
    assert.include(buildRemoteLaunchScript({ packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemotePairingScript(target),
      '"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json',
    );
    assert.include(buildRemotePairingScript(target), 'PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"');
    assert.notInclude(buildRemotePairingScript(target), "server-home");
    assert.include(buildRemotePairingScript(target, { packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemoteStopScript(target),
      'if [ "$REMOTE_MANAGED" != "external" ] && [ -n "$REMOTE_PID" ]',
    );
    assert.include(buildRemoteStopScript(target), 'kill "$REMOTE_PID" 2>/dev/null || true');
    assert.include(buildRemoteStopScript(target), 'rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"');
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"',
    );
    assert.include(buildRemoteLaunchScript(), "resolve_default_runtime_port()");
    assert.include(
      buildRemoteLaunchScript(),
      'DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port',
    );
    assert.include(
      buildRemoteLaunchScript(),
      "if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port))",
    );
    assert.include(buildRemoteLaunchScript(), 'PID_TO_STOP="${REMOTE_PID:-$DEFAULT_RUNTIME_PID}"');
    assert.include(buildRemoteLaunchScript(), 'REMOTE_PORT="$DEFAULT_REMOTE_PORT"');
    assert.include(buildRemoteLaunchScript(), 'rm -f "$PID_FILE"');
    assert.include(buildRemoteLaunchScript(), "printf 'external\\n' >\"$MANAGED_FILE\"");
    assert.include(buildRemoteLaunchScript(), 'if [ -z "$REMOTE_PORT" ]; then');
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('if [ "$REMOTE_MANAGED" = "managed" ]'),
      buildRemoteLaunchScript().indexOf("printf 'external\\n' >\"$MANAGED_FILE\""),
    );
    assert.isBelow(
      buildRemoteLaunchScript().indexOf('DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port'),
      buildRemoteLaunchScript().indexOf('elif [ -n "$REMOTE_PID" ]'),
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);

    return Effect.gen(function* () {
      const result = yield* launchOrReuseRemoteServer(target);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("allows cold remote launches to exceed the default SSH command timeout", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeDelayedSuccessfulProcess('{"remotePort":3774}\n', 75_000)),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.mergeAll(NodeServices.layer, spawnerLayer, TestClock.layer());

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(launchOrReuseRemoteServer(target));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(75));

      const result = yield* Fiber.join(fiber);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(processLayer));
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("bounds each HTTP readiness probe so retries cannot hang on one request", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(
          waitForHttpReady({
            baseUrl: "http://127.0.0.1:41773/",
            timeoutMs: 1_000,
            intervalMs: 100,
            probeTimeoutMs: 250,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(1_000));

      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Timed out waiting 1000ms");
      }
    }).pipe(
      Effect.provide(
        Layer.merge(TestClock.layer(), Layer.succeed(HttpClient.HttpClient, hangingHttpClient)),
      ),
    ),
  );

  it("preserves primitive readiness reason values in diagnostic output", () => {
    assert.deepEqual(
      describeReadinessCause({
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      }),
      {
        _tag: "HttpClientError",
        message: "Backend readiness probe failed.",
        reason: "authentication failed",
        cause: "upstream closed",
      },
    );
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const result = yield* issueRemotePairingToken(target);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });

  it.effect("closes the tunnel scope and starts fresh after disconnect", () => {
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    let tunnelKillCount = 0;
    let stopCommandCount = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const args = commandArgs(command);
        spawnedCommands.push(args);
        if (args.includes("-N")) {
          return makeRunningProcess(() => {
            tunnelKillCount += 1;
          });
        }
        if (args.includes("sh") && args.includes("--")) {
          return makeSuccessfulProcess('{"remotePort":3773}\n');
        }
        if (args.includes("sh")) {
          stopCommandCount += 1;
          return makeSuccessfulProcess('{"stopped":true}\n');
        }
        return makeSuccessfulProcess("\n");
      }),
    );
    const layer = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(HttpClient.HttpClient, testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshPasswordPrompt.disabledLayer,
      SshEnvironmentManager.layer(),
    );
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    return Effect.gen(function* () {
      const manager = yield* SshEnvironmentManager;

      const first = yield* manager.ensureEnvironment(target);
      assert.equal(first.httpBaseUrl, "http://127.0.0.1:41773/");
      const firstTunnelArgs = spawnedCommands.find((args) => args.includes("-N"));
      assert.isDefined(firstTunnelArgs);
      assert.include(firstTunnelArgs, "ControlMaster=no");
      assert.include(firstTunnelArgs, "ControlPath=none");
      assert.include(firstTunnelArgs, "ControlPersist=no");

      yield* manager.disconnectEnvironment(target);
      assert.equal(tunnelKillCount, 1);
      assert.equal(stopCommandCount, 1);

      yield* manager.ensureEnvironment(target);

      assert.equal(spawnedCommands.filter((args) => args.includes("-N")).length, 2);
      assert.equal(tunnelKillCount, 1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });
});
