import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { HostProcessAddresses, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { SshCommandError } from "@t3tools/ssh/errors";
import { collectProcessOutput } from "@t3tools/ssh/command";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { SshRunner } from "@t3tools/ssh/runner";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { DesktopSettings } from "../settings/DesktopAppSettings.ts";
import { DesktopWslEnvironment } from "../wsl/DesktopWslEnvironment.ts";

export function selectSshRunner(
  platform: NodeJS.Platform,
  settings: Pick<DesktopSettings, "wslBackendEnabled" | "wslOnly" | "sshRunner">,
) {
  return platform === "win32" &&
    settings.wslBackendEnabled &&
    (settings.wslOnly || settings.sshRunner === "wsl")
    ? "wsl"
    : "native";
}

export const preflightWslSsh = Effect.fn("desktop.ssh.preflightWsl")(function* (distro: string) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "wsl.exe",
          [
            "-d",
            distro,
            "--exec",
            "bash",
            "-lc",
            'printf "\\nT3SSH-USER:%s\\nT3SSH-HOME:%s\\n" "$(id -un)" "$HOME"; ssh -V >&2 || exit; if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "$SSH_AUTH_SOCK" ]; then printf agent-ready; else printf agent-unavailable; fi',
          ],
          { stdin: "ignore" },
        ),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collectProcessOutput(child.stdout), collectProcessOutput(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0)
        return yield* new SshCommandError({
          command: ["wsl.exe"],
          exitCode: Number(exitCode),
          stderr,
          message: `OpenSSH is unavailable via WSL (${distro}): ${stderr.trim()}`,
        });
      yield* Effect.logDebug("ssh.wsl.preflight", {
        distro,
        agentAvailable: stdout.trim().endsWith("agent-ready"),
      });
      const user = stdout
        .split(/\r?\n/u)
        .find((line) => line.startsWith("T3SSH-USER:"))
        ?.slice(11);
      const homeDir = stdout
        .split(/\r?\n/u)
        .find((line) => line.startsWith("T3SSH-HOME:"))
        ?.slice(11);
      if (!user || !homeDir)
        return yield* new SshCommandError({
          command: ["wsl.exe"],
          exitCode: null,
          stderr: "",
          message: "Could not bind the WSL SSH account. Reconnect in Settings → Connections.",
        });
      return { user, homeDir };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: 10_000,
      orElse: () =>
        Effect.fail(
          new SshCommandError({
            command: ["wsl.exe"],
            exitCode: null,
            stderr: "",
            message: `SSH preflight timed out via WSL (${distro}).`,
          }),
        ),
    }),
    Effect.mapError((cause) =>
      cause instanceof SshCommandError
        ? cause
        : new SshCommandError({
            command: ["wsl.exe"],
            exitCode: null,
            stderr: "",
            message: `Could not start SSH via WSL (${distro}).`,
            cause,
          }),
    ),
  );
});

export const resolveDesktopSshRunner = Effect.fn("desktop.ssh.resolveRunner")(function* (
  settings: DesktopSettings,
) {
  const platform = yield* HostProcessPlatform;
  if (selectSshRunner(platform, settings) === "native") return { kind: "native" } as const;
  const wsl = yield* DesktopWslEnvironment;
  const distros = yield* wsl.probeDistros.pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["wsl.exe"],
          exitCode: null,
          stderr: "",
          message: "Could not discover the selected WSL SSH distro.",
          cause,
        }),
    ),
  );
  const distro = settings.wslDistro ?? distros.find((entry) => entry.isDefault)?.name;
  if (!distro || !distros.some((entry) => entry.name === distro)) {
    return yield* new SshCommandError({
      command: ["wsl.exe"],
      exitCode: null,
      stderr: "",
      message: `The selected WSL SSH distro (${distro ?? "default"}) is unavailable. Check Settings → Connections.`,
    });
  }
  const home = yield* wsl.getUserHome(distro);
  const ip = yield* wsl.getDistroIp(distro);
  if (Option.isNone(home) || Option.isNone(ip)) {
    return yield* new SshCommandError({
      command: ["wsl.exe"],
      exitCode: null,
      stderr: "",
      message: `Could not resolve SSH home or network address via WSL (${distro}).`,
    });
  }
  const account = yield* preflightWslSsh(distro);
  const addresses = yield* yield* HostProcessAddresses;
  return {
    kind: "wsl",
    distro,
    homeDir: account.homeDir,
    user: account.user,
    tunnelHost: addresses.has(ip.value) ? "127.0.0.1" : ip.value,
  } as const;
});

export function sshRunnerIdentity(
  runner: SshRunner,
  platform: NodeJS.Platform,
): DesktopSshEnvironmentTarget["runner"] {
  return runner.kind === "wsl"
    ? { kind: "wsl", distro: runner.distro, ...(runner.user ? { user: runner.user } : {}) }
    : platform === "win32"
      ? { kind: "windows" }
      : undefined;
}

export function matchesSshRunner(
  saved: DesktopSshEnvironmentTarget["runner"],
  current: DesktopSshEnvironmentTarget["runner"],
) {
  if (!saved) return current?.kind !== "wsl";
  return (
    saved.kind === current?.kind &&
    (saved.kind !== "wsl" ||
      (current.kind === "wsl" && saved.distro === current.distro && saved.user === current.user))
  );
}
