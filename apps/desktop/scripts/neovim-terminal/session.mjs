import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import {
  decodeRequest,
  encodeRequest,
  findNeovim,
  neovimArgs,
  quotePosix,
  run,
  sshArgs,
  wslArgs,
} from "./transport.mjs";

const sourceDirectory = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
let sources;
async function loadSources() {
  sources ??= Promise.all(
    ["session.mjs", "transport.mjs"].map(async (name) => [
      name,
      await NodeFSP.readFile(NodePath.join(sourceDirectory, name), "utf8"),
    ]),
  );
  return Object.fromEntries(await sources);
}

/** Source and payload use staging stdin; the final invocation contains only a private script path. */
export async function stagingProgram(request, _node, directory, stagingUser) {
  const files = await loadSources();
  files.request = encodeRequest(request);
  return `import * as fs from 'node:fs/promises';
import * as os from 'node:os';
const directory = ${JSON.stringify(directory)};
const files = ${JSON.stringify(files)};
const expectedUser = ${JSON.stringify(stagingUser ?? null)};
if (expectedUser && os.userInfo().username !== expectedUser) throw new Error('The WSL account changed. Reconnect before opening Neovim.');
const quote = value => "'" + value.replaceAll("'", "'\\\\''") + "'";
files['launch.sh'] = '#!/bin/bash\\nexec ' + quote(process.execPath) + ' ' + quote(directory + '/session.mjs') + ' --staged ' + quote(directory) + '\\n';
// Consumed launchers are removed before editing; only abandoned preparation remains here.
let cleaned = 0;
for (const name of await fs.readdir('/tmp')) {
  if (cleaned >= 64) break;
  if (!/^t3code-neovim-[a-f0-9-]{36}$/.test(name)) continue;
  const candidate = '/tmp/' + name;
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && Date.now() - stat.mtimeMs > 86400000) {
      await fs.rm(candidate, { recursive: true, force: true });
      cleaned++;
    }
  } catch { /* Another launcher may have consumed the directory. */ }
}
await fs.mkdir(directory, { mode: 0o700 });
try {
  for (const [name, data] of Object.entries(files)) await fs.writeFile(directory + '/' + name, data, { mode: 0o600, flag: 'wx' });
} catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
`;
}

function bootstrap(program, node) {
  return `set -eu\n${node ? `node_path=${quotePosix(node)}` : "node_path=$(command -v node) || { echo 'Node.js is missing from this account’s login PATH.' >&2; exit 72; }"}\n"$node_path" --input-type=module <<'T3_NEOVIM_STAGE'\n${program}\nT3_NEOVIM_STAGE\n`;
}

export async function launchSession(request) {
  const route = request.route;
  if (route.kind === "native") {
    if (request.expectedAccount && NodeOS.userInfo().username !== request.expectedAccount)
      throw new Error("The target account changed. Reconnect and check Neovim again.");
    const executable = await findNeovim(request.executable);
    await run(executable, await neovimArgs(request.target), { cwd: request.workspace });
    return;
  }
  const directory = `/tmp/t3code-neovim-${NodeCrypto.randomUUID()}`;
  if (route.kind === "wsl" || route.kind === "wsl-ssh") {
    const next = {
      ...request,
      platform: "linux",
      route:
        route.kind === "wsl"
          ? { kind: "native" }
          : {
              kind: "ssh",
              host: route.host,
              sshUser: route.sshUser,
              port: route.port,
              remoteNode: route.remoteNode,
            },
    };
    const prefix = wslArgs(route);
    await run("wsl.exe", [...prefix, "/bin/bash", "-l", "-s"], {
      input: bootstrap(await stagingProgram(next, route.node, directory, route.user), route.node),
      timeout: 30_000,
    });
    await run("wsl.exe", [...prefix, "/bin/bash", "-l", `${directory}/launch.sh`]);
    return;
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packaged helper has no Effect runtime.
  const ssh = process.platform === "win32" ? "ssh.exe" : "ssh";
  const next = { ...request, platform: "linux", route: { kind: "native" } };
  // SSH authenticates on the terminal; the preparation program has a separate stdin pipe.
  await run(ssh, [...sshArgs(route, false), "/bin/bash -l -s"], {
    input: bootstrap(await stagingProgram(next, route.remoteNode, directory), route.remoteNode),
  });
  await run(ssh, [...sshArgs(route, true), `/bin/bash -l ${quotePosix(`${directory}/launch.sh`)}`]);
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  let token;
  if (process.argv[2] === "--staged") {
    const directory = process.argv[3];
    if (!/^\/tmp\/t3code-neovim-[a-f0-9-]{36}$/u.test(directory))
      throw new Error("Invalid staging directory.");
    try {
      token = await NodeFSP.readFile(`${directory}/request`, "utf8");
      await loadSources();
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  } else token = process.argv[2];
  await launchSession(decodeRequest(token));
}
if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(`Neovim could not complete the session: ${error.message}`);
    process.exitCode = 1;
  });
}
