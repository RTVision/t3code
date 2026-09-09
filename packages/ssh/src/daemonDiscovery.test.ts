// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import { buildRemoteLaunchScript, buildRemoteT3RunnerScript } from "./tunnel.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

async function fixture(run: (home: string, pid: number, port: number) => Promise<void>) {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-daemon-discovery-"));
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "-e",
      `
    require('node:http').createServer((_, res) => res.end('ready')).listen(0, '127.0.0.1', function () {
      process.send(this.address().port);
    });
  `,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  try {
    const port = await new Promise<unknown>((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
    });
    if (typeof port !== "number" || child.pid === undefined)
      throw new Error("fixture did not start");
    await NodeFSP.mkdir(NodePath.join(home, ".t3", "runtime"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(home, ".t3", "userdata"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(home, ".t3", "ssh-launch", "test"), { recursive: true });
    await run(home, child.pid, port);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
}

async function launch(home: string) {
  const script = NodePath.join(home, "launch.sh");
  await NodeFSP.writeFile(script, buildRemoteLaunchScript({ nodeEngineRange: null }));
  return exec("sh", [script, "test"], { env: { ...process.env, HOME: home }, timeout: 15_000 });
}

it("prefers the daemon when another server overwrites the shared runtime record", async () => {
  await fixture(async (home, pid, port) => {
    await NodeFSP.writeFile(
      NodePath.join(home, ".t3/runtime/server-runtime.json"),
      JSON.stringify({ pid, launcherPid: pid, port, origin: `http://127.0.0.1:${port}` }),
    );
    await NodeFSP.writeFile(
      NodePath.join(home, ".t3/userdata/server-runtime.json"),
      JSON.stringify({ pid, port: 1, origin: "http://127.0.0.1:1" }),
    );
    const result = await launch(home);
    expect(JSON.parse(result.stdout)).toEqual({ remotePort: port, serverKind: "external" });
    expect(await NodeFSP.readFile(NodePath.join(home, ".t3/ssh-launch/test/managed"), "utf8")).toBe(
      "external\n",
    );
  });
});

it("does not launch an SSH replacement while the daemon child is restarting", async () => {
  await fixture(async (home, pid) => {
    await NodeFSP.writeFile(
      NodePath.join(home, ".t3/runtime/server-runtime.json"),
      JSON.stringify({ pid, launcherPid: pid, port: 1, origin: "http://127.0.0.1:1" }),
    );
    await expect(launch(home)).rejects.toMatchObject({
      stderr: expect.stringContaining("daemon is restarting or unavailable"),
    });
    await expect(
      NodeFSP.stat(NodePath.join(home, ".t3/ssh-launch/test/pid")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

it("keeps a previously selected external server external when it is unavailable", async () => {
  await fixture(async (home) => {
    await NodeFSP.writeFile(NodePath.join(home, ".t3/ssh-launch/test/managed"), "external\n");
    await NodeFSP.writeFile(NodePath.join(home, ".t3/ssh-launch/test/port"), "1\n");
    await expect(launch(home)).rejects.toMatchObject({
      stderr: expect.stringContaining("external T3 server is unavailable"),
    });
    await expect(
      NodeFSP.stat(NodePath.join(home, ".t3/ssh-launch/test/pid")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

it("reuses its own SSH-managed server without killing or reclassifying it", async () => {
  await fixture(async (home, pid, port) => {
    const dir = NodePath.join(home, ".t3/ssh-launch/test");
    await NodeFSP.writeFile(
      NodePath.join(home, ".t3/userdata/server-runtime.json"),
      JSON.stringify({ pid, port, origin: `http://127.0.0.1:${port}` }),
    );
    await NodeFSP.writeFile(NodePath.join(dir, "pid"), `${pid}\n`);
    await NodeFSP.writeFile(NodePath.join(dir, "port"), `${port}\n`);
    await NodeFSP.writeFile(NodePath.join(dir, "managed"), "managed\n");
    await NodeFSP.writeFile(
      NodePath.join(dir, "run-t3.sh"),
      `${buildRemoteT3RunnerScript({ nodeEngineRange: null }).trimEnd()}\n`,
    );
    const result = await launch(home);
    expect(JSON.parse(result.stdout)).toEqual({ remotePort: port, serverKind: "managed" });
    expect(await NodeFSP.readFile(NodePath.join(dir, "pid"), "utf8")).toBe(`${pid}\n`);
  });
});

it("does not replace a daemon that is bound to a non-loopback host", async () => {
  await fixture(async (home, pid) => {
    await NodeFSP.writeFile(
      NodePath.join(home, ".t3/runtime/server-runtime.json"),
      JSON.stringify({ pid, launcherPid: pid, port: 1, origin: "http://192.0.2.1:1" }),
    );
    await expect(launch(home)).rejects.toMatchObject({
      stderr: expect.stringContaining("daemon is restarting or unavailable"),
    });
    await expect(
      NodeFSP.stat(NodePath.join(home, ".t3/ssh-launch/test/pid")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
