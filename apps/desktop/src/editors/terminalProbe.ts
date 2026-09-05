import * as NodeBuffer from "node:buffer";
import * as Schema from "effect/Schema";
import {
  quotePosix,
  run,
  sshArgs,
  wslArgs,
  type TerminalRoute,
} from "../../scripts/neovim-terminal/transport.mjs";

export const ProbeResult = Schema.Struct({
  account: Schema.String,
  node: Schema.String,
  executable: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  missing: Schema.optionalKey(Schema.Boolean),
});
export type ProbeResult = typeof ProbeResult.Type;
const decodeProbeResult = Schema.decodeUnknownSync(ProbeResult);

// A fixed program decodes the override as data and probes without loading Neovim config.
export function neovimProbeScript(override: string | null) {
  const token = NodeBuffer.Buffer.from(JSON.stringify(override)).toString("base64");
  return `set -eu
node_path=$(command -v node) || { echo T3NEOVIM_RUNTIME_MISSING >&2; exit 72; }
"$node_path" --input-type=module <<'T3_NEOVIM_PROBE'
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cp from 'node:child_process';
const override = JSON.parse(Buffer.from('${token}', 'base64').toString('utf8'));
const candidates = override ? [override] : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(p => path.resolve(p, 'nvim'));
const executable = candidates.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
let result = { account: os.userInfo().username, node: process.execPath, missing: true };
if (executable) {
  const probe = cp.spawnSync(executable, ['--version'], { timeout: 8000, maxBuffer: 65536, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (probe.error || probe.status !== 0) throw new Error('Neovim version probe failed: ' + (probe.error?.message || probe.stderr));
  const version = probe.stdout.split(/\\r?\\n/)[0];
  if (!version.startsWith('NVIM v')) throw new Error('The executable is not Neovim.');
  result = { account: os.userInfo().username, node: process.execPath, executable, version };
}
console.log('T3NEOVIM:' + Buffer.from(JSON.stringify(result)).toString('base64'));
T3_NEOVIM_PROBE
`;
}

export function parseNeovimProbe(output: string): ProbeResult {
  const frame = output.split(/\r?\n/u).findLast((line) => line.startsWith("T3NEOVIM:"));
  if (!frame) throw new Error("The login script did not return a Neovim probe response.");
  const value: unknown = JSON.parse(
    NodeBuffer.Buffer.from(frame.slice(9), "base64").toString("utf8"),
  );
  return decodeProbeResult(value);
}

export async function probePosixRoute(
  route: Exclude<TerminalRoute, { kind: "native" }>,
  override: string | null,
  platform: NodeJS.Platform,
) {
  const script = neovimProbeScript(override);
  if (route.kind === "wsl") {
    return parseNeovimProbe(
      await run("wsl.exe", [...wslArgs(route), "/bin/bash", "-l", "-s"], {
        input: script,
        capture: true,
        timeout: 20_000,
      }),
    );
  }
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ConnectionAttempts=1",
    ...sshArgs(route, false),
    "/bin/bash -l -s",
  ];
  if (route.kind === "ssh") {
    return parseNeovimProbe(
      await run(platform === "win32" ? "ssh.exe" : "ssh", args, {
        input: script,
        capture: true,
        timeout: 20_000,
      }),
    );
  }
  const command = `exec ssh ${args.map(quotePosix).join(" ")} <<'T3_NEOVIM_REMOTE'\n${script}\nT3_NEOVIM_REMOTE\n`;
  return parseNeovimProbe(
    await run("wsl.exe", [...wslArgs(route), "/bin/bash", "-l", "-s"], {
      input: command,
      capture: true,
      timeout: 25_000,
    }),
  );
}
