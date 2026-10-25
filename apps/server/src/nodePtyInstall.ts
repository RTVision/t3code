// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - npm lifecycle script runs outside the Effect server.
import * as NodeChildProcess from "node:child_process";

export function shouldBuildNodePtyFromSource(
  platform: NodeJS.Platform,
  glibcVersionRuntime: unknown,
): boolean {
  return platform === "linux" && typeof glibcVersionRuntime !== "string";
}

export function npmRebuildPrefix(env: NodeJS.ProcessEnv, cwd: string): string {
  const prefix =
    env.npm_config_global === "true"
      ? (env.npm_config_prefix ?? env.npm_config_global_prefix)
      : env.npm_config_local_prefix;
  return prefix?.trim() || cwd;
}

function glibcVersionRuntime(): unknown {
  try {
    const report = process.report?.getReport() as
      | { readonly header?: { readonly glibcVersionRuntime?: unknown } }
      | undefined;
    return report?.header?.glibcVersionRuntime;
  } catch {
    return undefined;
  }
}

function rebuildNodePty(): void {
  const npmExecPath = process.env.npm_execpath?.trim();
  const prefix = npmRebuildPrefix(process.env, process.cwd());
  const command = npmExecPath === undefined ? "npm" : process.execPath;
  const args =
    npmExecPath === undefined
      ? ["rebuild", "--prefix", prefix, "node-pty"]
      : [npmExecPath, "rebuild", "--prefix", prefix, "node-pty"];
  const result = NodeChildProcess.spawnSync(command, args, {
    env: { ...process.env, npm_config_build_from_source: "true" },
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    console.error(`Failed to rebuild node-pty from source: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone npm hook must inspect the actual host platform.
if (import.meta.main && shouldBuildNodePtyFromSource(process.platform, glibcVersionRuntime())) {
  rebuildNodePty();
}
