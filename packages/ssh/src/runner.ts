import * as NodeCrypto from "node:crypto";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type SshRunner =
  | { readonly kind: "native" }
  | {
      readonly kind: "wsl";
      readonly distro: string;
      readonly homeDir: string;
      readonly tunnelHost: string;
    };

export const SshRunner = Context.Reference<SshRunner>("@t3tools/ssh/runner/SshRunner", {
  defaultValue: () => ({ kind: "native" }),
});

// The PID belongs to the login shell and stays the same across exec. A cancellation
// marker covers disconnect before wsl.exe has finished starting the distro.
export const WSL_SSH_SCRIPT = `set -eu
runtime_dir="$1"
shift
umask 077
mkdir -p "$runtime_dir"
printf '%s %s\\n' "$$" "$(awk '{print $22}' /proc/$$/stat)" > "$runtime_dir/pid"
if [ -f "$runtime_dir/cancelled" ]; then
  rm -rf "$runtime_dir"
  exit 125
fi
if [ "\${SSH_ASKPASS_REQUIRE:-}" = force ]; then
  printf '%s\\n' '#!/bin/sh' 'printf "%s\\n" "$T3_SSH_AUTH_SECRET"' > "$runtime_dir/askpass"
  chmod 700 "$runtime_dir/askpass"
  export SSH_ASKPASS="$runtime_dir/askpass"
  export DISPLAY="\${DISPLAY:-t3code}"
fi
exec ssh "$@"
`;

export const WSL_SSH_CLEANUP_SCRIPT = `set -eu
runtime_dir="$1"
umask 077
mkdir -p "$runtime_dir"
: > "$runtime_dir/cancelled"
if [ -f "$runtime_dir/pid" ]; then
  read -r ssh_pid ssh_started < "$runtime_dir/pid"
  case "$ssh_pid" in ''|*[!0-9]*) exit 1;; esac
  if [ "$ssh_pid" -gt 1 ] && [ "$(awk '{print $22}' "/proc/$ssh_pid/stat" 2>/dev/null || true)" = "$ssh_started" ]; then
    kill "$ssh_pid" 2>/dev/null || true
  fi
  rm -rf "$runtime_dir"
fi
`;

export const describeSshRunner = Effect.gen(function* () {
  const runner = yield* SshRunner;
  const platform = yield* HostProcessPlatform;
  return runner.kind === "wsl"
    ? `WSL (${runner.distro})`
    : platform === "win32"
      ? "Windows OpenSSH"
      : "OpenSSH";
});

export const sshCommandForRunner = Effect.gen(function* () {
  const runner = yield* SshRunner;
  const platform = yield* HostProcessPlatform;
  return runner.kind === "wsl" ? "wsl.exe" : platform === "win32" ? "ssh.exe" : "ssh";
});

export const buildWslSshEnvironment = Effect.fn("ssh/runner.buildWslSshEnvironment")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const hostEnvironment = yield* HostProcessEnvironment;
  const forwarded = new Set(
    (environment.WSLENV ?? hostEnvironment.WSLENV ?? "").split(":").filter(Boolean),
  );
  for (const name of ["SSH_ASKPASS_REQUIRE", "T3_SSH_AUTH_SECRET"]) {
    if (environment[name] !== undefined) forwarded.add(name);
  }
  return { ...environment, WSLENV: [...forwarded].join(":") };
});

export const spawnSsh = Effect.fn("ssh/runner.spawnSsh")(function* (
  args: ReadonlyArray<string>,
  options: { readonly env: NodeJS.ProcessEnv; readonly stdin: Stream.Stream<Uint8Array> },
) {
  const runner = yield* SshRunner;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = yield* sshCommandForRunner;
  if (runner.kind === "native") {
    return yield* spawner.spawn(
      ChildProcess.make(command, args, {
        env: options.env,
        extendEnv: true,
        stdin: { stream: options.stdin, endOnDone: true },
      }),
    );
  }
  const runtimeDirectory = `/tmp/t3code-ssh-${NodeCrypto.randomUUID()}`;
  const scope = yield* Scope.Scope;
  // Killing wsl.exe does not guarantee termination of the distro-side ssh.
  yield* Scope.addFinalizer(
    scope,
    Effect.scoped(
      Effect.gen(function* () {
        const cleanup = yield* spawner.spawn(
          ChildProcess.make(
            "wsl.exe",
            [
              "-d",
              runner.distro,
              "--exec",
              "sh",
              "-c",
              WSL_SSH_CLEANUP_SCRIPT,
              "t3-ssh-cleanup",
              runtimeDirectory,
            ],
            { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
          ),
        );
        yield* cleanup.exitCode;
      }),
    ).pipe(Effect.timeoutOption(60_000), Effect.ignore),
  );
  return yield* spawner.spawn(
    ChildProcess.make(
      command,
      [
        "-d",
        runner.distro,
        "--exec",
        "bash",
        "-lc",
        WSL_SSH_SCRIPT,
        "t3-ssh",
        runtimeDirectory,
        ...args,
      ],
      {
        env: yield* buildWslSshEnvironment(options.env),
        extendEnv: true,
        stdin: { stream: options.stdin, endOnDone: true },
      },
    ),
  );
});
