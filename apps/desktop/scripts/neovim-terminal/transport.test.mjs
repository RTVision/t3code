import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test } from "vite-plus/test";
import * as NodeURL from "node:url";
import { stagingProgram } from "./session.mjs";
import {
  decodeRequest,
  encodeRequest,
  neovimArgs,
  quotePosix,
  run,
  sshArgs,
  windowsTerminalArgs,
  wslArgs,
} from "./transport.mjs";

const request = (overrides = {}) => ({
  version: 1,
  id: NodeCrypto.randomUUID(),
  platform: "linux",
  route: { kind: "native" },
  workspace: "/home/test/worktree",
  target: {
    kind: "file",
    path: "/home/test/worktree/file.txt",
    line: 2,
    column: 3,
    columnEncoding: "utf-8",
  },
  ...overrides,
});

test("target bytes remain data across token and Windows Terminal grammar", () => {
  for (const name of [
    "spaces here",
    "single'quote",
    'double"quote',
    "semi;new-tab",
    "$(touch nope)",
    "`touch nope`",
    "雪😀",
    "literal\nnewline",
    "colon:12:34",
    "-leading-dash",
  ]) {
    const input = request({ target: { kind: "file", path: `/tmp/${name}` } });
    const token = encodeRequest(input);
    NodeAssert.deepEqual(decodeRequest(token), input);
    NodeAssert.match(token, /^[A-Za-z0-9_-]+$/u);
    const args = windowsTerminalArgs({
      powershell: "C:\\Windows\\powershell.exe",
      bootstrap: "C:\\Program Files\\T3\\launch.ps1",
      runtime: "C:\\Program Files\\T3\\T3.exe",
      token,
    });
    NodeAssert.deepEqual(args.slice(0, 3), ["-w", "new", "new-tab"]);
    NodeAssert.equal(args.at(-1), token);
    NodeAssert.equal(args.filter((value) => value.includes(";")).length, 0);
  }
});

test("malformed, oversized and unsupported launch payloads fail before spawning", () => {
  for (const change of [
    { version: 2 },
    { route: { kind: "command", command: "anything" } },
    { workspace: "relative" },
    { target: { kind: "file", path: "/tmp/bad\0path" } },
    { target: { kind: "file", path: "/tmp/file", line: -1 } },
    { target: { kind: "file", path: "/tmp/file", column: 1.5 } },
    { target: { kind: "file", path: "/tmp/file", column: 2 ** 32 } },
    { target: { kind: "file", path: "/tmp/file", columnEncoding: "unknown" } },
    { target: { kind: "file", path: `/tmp/${"a".repeat(20_000)}` } },
    { route: { kind: "wsl", distro: "Ubuntu", node: "/usr/bin/node" } },
    { route: { kind: "ssh", host: "-oProxyCommand=bad", remoteNode: "/usr/bin/node" } },
  ])
    NodeAssert.throws(() => encodeRequest(request(change)));
  for (const token of ["", "a;new-tab", "AA==", "a".repeat(30_000)])
    NodeAssert.throws(() => decodeRequest(token));
  NodeAssert.throws(
    () =>
      windowsTerminalArgs({
        powershell: "C:\\Windows\\powershell.exe",
        bootstrap: "C:\\bad;dir\\launch.ps1",
        runtime: "C:\\T3.exe",
        token: encodeRequest(request()),
      }),
    /installation path/u,
  );
});

test("WSL binds distro and account; SSH preserves saved alias, port and user", () => {
  const route = {
    kind: "wsl-ssh",
    distro: "Ubuntu Work",
    user: "alice",
    node: "/usr/bin/node",
    host: "work-alias",
    sshUser: "bob",
    port: 2222,
    remoteNode: "/usr/bin/node",
  };
  NodeAssert.deepEqual(wslArgs(route), [
    "--distribution",
    "Ubuntu Work",
    "--user",
    "alice",
    "--exec",
  ]);
  NodeAssert.deepEqual(sshArgs(route, true), ["-t", "-l", "bob", "-p", "2222", "--", "work-alias"]);
  NodeAssert.deepEqual(sshArgs(route, false), ["-l", "bob", "-p", "2222", "--", "work-alias"]);
});

test("UTF-16 columns become Neovim byte columns without splitting surrogate pairs", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-neovim-column-"));
  try {
    const file = NodePath.join(directory, "multibyte.txt");
    await NodeFSP.writeFile(file, "first\na雪😀z\n");
    NodeAssert.deepEqual(
      await neovimArgs({ kind: "file", path: file, line: 2, column: 5, columnEncoding: "utf-16" }),
      ["+call cursor(2,9)", "--", file],
    );
    await NodeAssert.rejects(
      neovimArgs({ kind: "file", path: file, line: 2, column: 4, columnEncoding: "utf-16" }),
      /surrogate pair/u,
    );
    NodeAssert.deepEqual(await neovimArgs({ kind: "file", path: file, line: 2, column: 9 }), [
      "+call cursor(2,9)",
      "--",
      file,
    ]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packaged helper has no Effect runtime.
test.skipIf(process.platform === "win32")(
  "staged session preserves hostile filenames, cwd, PATH and editor stdin",
  async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-neovim-session-"));
    const staged = `/tmp/t3code-neovim-${NodeCrypto.randomUUID()}`;
    try {
      const recorder = NodePath.join(directory, "nvim");
      const result = NodePath.join(directory, "received.json");
      await NodeFSP.writeFile(
        recorder,
        `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv[2] === '--version') { console.log('NVIM v0.11.0'); process.exit(0); }\nfs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH, stdin: fs.readFileSync(0, 'utf8') }));\n`,
        { mode: 0o700 },
      );
      const target = NodePath.join(directory, "-雪 '\";$(touch nope)`touch nope`\n:12:34");
      const input = request({
        workspace: directory,
        executable: recorder,
        target: { kind: "file", path: target, line: 3, column: 4 },
      });
      const source = await stagingProgram(input, process.execPath, staged);
      await run(process.execPath, ["--input-type=module"], { input: source });
      const stagedToken = await NodeFSP.readFile(`${staged}/request`, "utf8");
      NodeAssert.deepEqual(decodeRequest(stagedToken), input);
      await run("/bin/bash", ["-l", `${staged}/launch.sh`], { input: "editor keyboard input\n" });
      const received = JSON.parse(await NodeFSP.readFile(result, "utf8"));
      NodeAssert.deepEqual(received.args, ["+call cursor(3,4)", "--", target]);
      NodeAssert.equal(received.cwd, directory);
      NodeAssert.equal(received.stdin, "editor keyboard input\n");
      NodeAssert.ok(received.path.length > 0);
      await NodeAssert.rejects(NodeFSP.readFile(`${staged}/request`), { code: "ENOENT" });
      await NodeAssert.rejects(NodeFSP.readFile(NodePath.join(directory, "nope")), {
        code: "ENOENT",
      });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
      await NodeFSP.rm(staged, { recursive: true, force: true });
    }
  },
);

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packaged helper has no Effect runtime.
test.skipIf(process.platform === "win32")(
  "POSIX quoting round-trips shell metacharacters as one argument",
  async () => {
    const value = "a'b\";$(false)`false`\n雪";
    const output = await run("/bin/sh", ["-c", `printf '%s' ${quotePosix(value)}`], {
      input: "",
      capture: true,
    });
    NodeAssert.equal(output, value);
  },
);

test("spawn and child failures are returned to the terminal wrapper", async () => {
  await NodeAssert.rejects(run("t3-neovim-nonexistent-executable", [], { input: "" }), /ENOENT/u);
  await NodeAssert.rejects(run(process.execPath, ["-e", "process.exit(17)"], { input: "" }), /17/u);
  const session = NodeURL.fileURLToPath(new URL("session.mjs", import.meta.url));
  await NodeAssert.rejects(
    run(process.execPath, [session, "bad-token"], { input: "", capture: true }),
    /could not complete/u,
  );
});

test.skipIf(!process.env.T3CODE_TEST_NVIM)(
  "Neovim opens the exact file and multibyte cursor position",
  async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-neovim-real-"));
    try {
      const file = NodePath.join(directory, "-雪 ' ; $() :12:34.txt");
      const result = NodePath.join(directory, "cursor.json");
      await NodeFSP.writeFile(file, "first\na雪😀z\n");
      const args = await neovimArgs({
        kind: "file",
        path: file,
        line: 2,
        column: 5,
        columnEncoding: "utf-16",
      });
      const record = `call writefile([json_encode({'path': expand('%:p'), 'line': line('.'), 'column': col('.')})], '${result.replaceAll("'", "''")}')`;
      await run(
        process.env.T3CODE_TEST_NVIM,
        [
          "--headless",
          "-u",
          "NONE",
          "-i",
          "NONE",
          ...args.slice(0, -2),
          "-c",
          record,
          "-c",
          "qa!",
          ...args.slice(-2),
        ],
        { input: "", timeout: 10_000, capture: true },
      );
      NodeAssert.deepEqual(JSON.parse(await NodeFSP.readFile(result, "utf8")), {
        path: file,
        line: 2,
        column: 9,
      });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
