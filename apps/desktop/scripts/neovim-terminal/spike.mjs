import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { encodeRequest, windowsTerminalArgs } from "./transport.mjs";

// Invoke using the packaged Electron executable with ELECTRON_RUN_AS_NODE=1.
// This harness intentionally has no product IPC or editor-preference entry point.
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packaged helper has no Effect runtime.
if (process.platform !== "win32" || !process.versions.electron) {
  throw new Error("Run this spike with the packaged Windows Electron runtime.");
}
const request = JSON.parse(await NodeFSP.readFile(process.argv[2], "utf8"));
const powershell = NodePath.join(
  process.env.SystemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const bootstrap = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "launch.ps1",
);
const terminal = NodePath.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "wt.exe");
await Promise.all([
  NodeFSP.access(terminal),
  NodeFSP.access(powershell),
  NodeFSP.access(bootstrap),
]);
const args = windowsTerminalArgs({
  powershell,
  bootstrap,
  runtime: process.execPath,
  token: encodeRequest(request),
});
const child = NodeChildProcess.spawn(terminal, args, {
  detached: true,
  stdio: "ignore",
  shell: false,
});
await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`Windows Terminal rejected the launch (${code}).`)),
  );
});
child.unref();
console.log("Windows Terminal accepted the launch. This does not confirm SSH or Neovim readiness.");
