// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - npm lifecycle script runs outside the Effect server.
import { spawnSync } from "node:child_process";

export function shouldBuildNodePtyFromSource(
  platform: NodeJS.Platform,
  glibcVersionRuntime: unknown,
): boolean {
  return platform === "linux" && typeof glibcVersionRuntime !== "string";
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
  const command = npmExecPath === undefined ? "npm" : process.execPath;
  const args =
    npmExecPath === undefined ? ["rebuild", "node-pty"] : [npmExecPath, "rebuild", "node-pty"];
  const result = spawnSync(command, args, {
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

if (import.meta.main && shouldBuildNodePtyFromSource(process.platform, glibcVersionRuntime())) {
  rebuildNodePty();
}
