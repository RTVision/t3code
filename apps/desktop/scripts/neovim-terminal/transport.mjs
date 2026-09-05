import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MAX_PAYLOAD_BYTES = 16_384;
const MAX_POSITION = 2_147_483_647;

function text(value, name) {
  if (typeof value !== "string" || !value.length || value.includes("\0")) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function absolute(value, name, windows = false) {
  text(value, name);
  if (!(windows ? NodePath.win32 : NodePath.posix).isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return value;
}

function account(value, name) {
  text(value, name);
  if (value.startsWith("-") || /[\r\n]/u.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

/** Validate desktop-resolved routes at the standalone helper boundary. */
export function validateRequest(input) {
  if (!input || typeof input !== "object" || input.version !== 1) {
    throw new Error("Unsupported terminal-editor payload version.");
  }
  if (!/^[a-f0-9-]{36}$/u.test(input.id)) throw new Error("Invalid request ID.");
  const route = input.route;
  if (!route || !["native", "wsl", "ssh", "wsl-ssh"].includes(route.kind)) {
    throw new Error("Unsupported terminal-editor route.");
  }
  if (route.kind === "wsl" || route.kind === "wsl-ssh") {
    account(route.distro, "WSL distro");
    account(route.user, "WSL user");
    if (route.node !== undefined) absolute(route.node, "WSL Node executable");
  }
  if (route.kind === "ssh" || route.kind === "wsl-ssh") {
    account(route.host, "SSH host or alias");
    if (route.sshUser !== undefined) account(route.sshUser, "SSH user");
    if (
      route.port !== undefined &&
      (!Number.isInteger(route.port) || route.port < 1 || route.port > 65535)
    ) {
      throw new Error("Invalid SSH port.");
    }
    if (route.remoteNode !== undefined) absolute(route.remoteNode, "remote Node executable");
  }
  const windows = route.kind === "native" && input.platform === "win32";
  absolute(input.workspace, "workspace", windows);
  if (!input.target || !["file", "directory"].includes(input.target.kind)) {
    throw new Error("Invalid editor target.");
  }
  absolute(input.target.path, "target path", windows);
  for (const key of ["line", "column"]) {
    const value = input.target[key];
    if (
      value !== undefined &&
      (input.target.kind !== "file" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_POSITION)
    ) {
      throw new Error(`Invalid ${key}.`);
    }
  }
  if (
    input.target.columnEncoding !== undefined &&
    !["utf-8", "utf-16"].includes(input.target.columnEncoding)
  ) {
    throw new Error("Unsupported column encoding.");
  }
  if (input.executable !== undefined) absolute(input.executable, "Neovim executable", windows);
  if (input.expectedAccount !== undefined) account(input.expectedAccount, "expected account");
  return input;
}

export function encodeRequest(input) {
  const bytes = Buffer.from(JSON.stringify(validateRequest(input)));
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error("Terminal-editor payload is too large.");
  return bytes.toString("base64url");
}

export function decodeRequest(token) {
  if (
    typeof token !== "string" ||
    token.length > Math.ceil((MAX_PAYLOAD_BYTES * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(token)
  ) {
    throw new Error("Invalid terminal-editor token.");
  }
  const bytes = Buffer.from(token, "base64url");
  if (bytes.toString("base64url") !== token) throw new Error("Noncanonical terminal-editor token.");
  return validateRequest(JSON.parse(bytes.toString("utf8")));
}

export function quotePosix(value) {
  return `'${text(value, "shell argument").replaceAll("'", "'\\''")}'`;
}

/** Only installation paths and an encoded token cross Windows Terminal's command grammar. */
export function windowsTerminalArgs({ powershell, bootstrap, runtime, token }) {
  decodeRequest(token);
  for (const value of [powershell, bootstrap, runtime]) {
    absolute(value, "Windows helper path", true);
    if (/[;"\r\n]/u.test(value)) {
      throw new Error(
        "This Windows Terminal adapter cannot represent the helper installation path.",
      );
    }
  }
  return [
    "-w",
    "new",
    "new-tab",
    powershell,
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    bootstrap,
    "-Runtime",
    runtime,
    "-Token",
    token,
  ];
}

export function sshArgs(route, tty) {
  const args = tty ? ["-t"] : [];
  if (route.sshUser !== undefined) args.push("-l", route.sshUser);
  if (route.port !== undefined) args.push("-p", String(route.port));
  // A saved alias retains its normal ProxyJump, agent and known-hosts configuration.
  args.push("--", route.host);
  return args;
}

export function wslArgs(route) {
  return ["--distribution", route.distro, "--user", route.user, "--exec"];
}

/** Staging owns a separate stdin pipe; the editor process always inherits the terminal. */
export function run(command, args, { input, timeout, cwd, capture = false, env } = {}) {
  return new Promise((resolve, reject) => {
    // Packaged Electron can inherit a pipe as fd 0 from PowerShell even in a
    // terminal window. Open the console explicitly for the interactive child.
    const consoleInput =
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packaged helper owns its platform-specific console handles.
      input === undefined && process.platform === "win32"
        ? NodeFS.openSync("\\\\.\\CONIN$", "r")
        : undefined;
    let child;
    try {
      child = NodeChildProcess.spawn(command, args, {
        shell: false,
        cwd,
        env,
        stdio: [
          input === undefined ? (consoleInput ?? "inherit") : "pipe",
          capture ? "pipe" : "inherit",
          capture ? "pipe" : "inherit",
        ],
      });
    } finally {
      if (consoleInput !== undefined) NodeFS.closeSync(consoleInput);
    }
    let output = "";
    let timer;
    let killTimer;
    let failure;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimer.unref();
    };
    if (timeout) timer = setTimeout(() => stop(new Error(`${command} timed out.`)), timeout);
    if (capture) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => {
          if (failure) return;
          output += chunk.toString();
          if (output.length > 65_536) stop(new Error("Probe output exceeded its limit."));
        });
      }
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(`${command} exited with ${signal ?? code}.${output ? `\n${output}` : ""}`),
        );
      else resolve(output);
    });
    if (input !== undefined) {
      child.stdin.on("error", (error) => {
        if (input.length > 0) failure ??= error;
      });
      child.stdin.end(input);
    }
  });
}

export async function findNeovim(override, environment = process.env) {
  const candidates = override
    ? [override]
    : (environment.PATH ?? "")
        .split(NodePath.delimiter)
        .filter(Boolean)
        // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packaged helper has no Effect runtime.
        .map((dir) => NodePath.resolve(dir, process.platform === "win32" ? "nvim.exe" : "nvim"));
  for (const candidate of candidates) {
    try {
      await NodeFSP.access(candidate, NodeFS.constants.X_OK);
    } catch {
      if (override)
        throw new Error(`The configured Neovim executable is not runnable: ${override}`);
      continue;
    }
    const version = await run(candidate, ["--version"], {
      input: "",
      timeout: 10_000,
      capture: true,
    });
    if (!version.startsWith("NVIM v")) throw new Error("The executable is not Neovim.");
    return candidate;
  }
  throw new Error("Neovim was not found in the selected account's login PATH.");
}

export async function neovimArgs(target) {
  const args = [];
  if (target.kind === "file" && (target.line !== undefined || target.column !== undefined)) {
    const line = target.line ?? 1;
    let column = target.column ?? 1;
    if (target.columnEncoding === "utf-16" && column > 1) {
      const content = await NodeFSP.readFile(target.path, "utf8");
      const sourceLine = content.split("\n", line)[line - 1] ?? "";
      const prefix = sourceLine.slice(0, column - 1);
      if (/[\uD800-\uDBFF]$/u.test(prefix))
        throw new Error("Column splits a UTF-16 surrogate pair.");
      column = Buffer.byteLength(prefix, "utf8") + 1;
    }
    args.push(`+call cursor(${line},${column})`);
  }
  return [...args, "--", target.path];
}
