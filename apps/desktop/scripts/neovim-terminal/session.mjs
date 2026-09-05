import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
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

/** Prepare a private, single-use launcher; no source program crosses the final WSL argv boundary. */
export async function stagingProgram(request, node, directory) {
  const files = {};
  for (const name of ["session.mjs", "transport.mjs"]) {
    files[name] = await NodeFSP.readFile(NodePath.join(sourceDirectory, name), "utf8");
  }
  files["request"] = encodeRequest(request);
  files["launch.sh"] =
    `#!/bin/bash\nexec ${quotePosix(node)} ${quotePosix(`${directory}/session.mjs`)} --staged ${quotePosix(directory)}\n`;
  // JSON is parsed by Node, never by a shell. mkdir without recursive prevents consuming an existing directory.
  return `import * as NodeFSP from 'node:fs/promises';
const directory = ${JSON.stringify(directory)};
const files = ${JSON.stringify(files)};
await NodeFSP.mkdir(directory, { mode: 0o700 });
try {
  for (const [name, data] of Object.entries(files)) {
    await NodeFSP.writeFile(directory + '/' + name, data, { mode: 0o600, flag: 'wx' });
  }
} catch (error) {
  await NodeFSP.rm(directory, { recursive: true, force: true });
  throw error;
}
`;
}

export async function launchSession(request) {
  const route = request.route;
  if (route.kind === "native") {
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
    // A verified absolute Node path is an explicit spike input, never an assumed remote runtime.
    await run("wsl.exe", [...prefix, route.node, "--version"], {
      input: "",
      timeout: 15_000,
      capture: true,
    });
    await run("wsl.exe", [...prefix, route.node, "--input-type=module"], {
      input: await stagingProgram(next, route.node, directory),
      timeout: 30_000,
    });
    await run("wsl.exe", [...prefix, "/bin/bash", "-l", `${directory}/launch.sh`]);
    return;
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packaged helper has no Effect runtime.
  const ssh = process.platform === "win32" ? "ssh.exe" : "ssh";
  const next = { ...request, platform: "linux", route: { kind: "native" } };
  const node = quotePosix(route.remoteNode);
  // Preparation is a separate SSH process: authentication uses the terminal, source uses its own pipe.
  await run(ssh, [...sshArgs(route, false), `${node} --version`], { input: "" });
  await run(ssh, [...sshArgs(route, false), `${node} --input-type=module`], {
    input: await stagingProgram(next, route.remoteNode, directory),
  });
  await run(ssh, [...sshArgs(route, true), `/bin/bash -l ${quotePosix(`${directory}/launch.sh`)}`]);
}

async function main() {
  let token;
  let directory;
  if (process.argv[2] === "--staged") {
    directory = process.argv[3];
    if (!/^\/tmp\/t3code-neovim-[a-f0-9-]{36}$/u.test(directory))
      throw new Error("Invalid staging directory.");
    token = await NodeFSP.readFile(`${directory}/request`, "utf8");
  } else {
    token = process.argv[2];
  }
  const request = decodeRequest(token);
  try {
    await launchSession(request);
  } finally {
    if (directory) {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }
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
