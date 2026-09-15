// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { buildRemoteLaunchScript, buildRemoteT3RunnerScript } from "./tunnel.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const version = "1.2.3";

describe.skipIf(HostProcessPlatform.defaultValue() === "win32").each(["node", "archive"] as const)(
  "%s daemon discovery",
  (mode) => {
    const runner =
      mode === "node"
        ? { nodeScriptPath: "/unused/t3-discovery-test.mjs", nodeEngineRange: null }
        : { archiveVersion: version };

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
        if (mode === "archive") {
          const runtime = NodePath.join(home, ".t3/runtime/versions", version);
          const packageDir = NodePath.join(runtime, "node_modules/t3");
          await NodeFSP.mkdir(NodePath.join(packageDir, "dist"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(runtime, ".install-complete"), `${version}\n`);
          await NodeFSP.writeFile(
            NodePath.join(packageDir, "package.json"),
            JSON.stringify({ name: "@rtvision/t3", version }),
          );
          // Exercise archive-mode dispatch through the real CLI helper, using a
          // complete Node installation so this also runs on Alpine.
          await NodeFSP.writeFile(
            NodePath.join(packageDir, "dist/bin.mjs"),
            `
        import * as NodeServices from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeServices"))};
        import * as NodeRuntime from ${JSON.stringify(import.meta.resolve("@effect/platform-node/NodeRuntime"))};
        import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
        import { Command } from ${JSON.stringify(import.meta.resolve("effect/unstable/cli"))};
        import { sshHelperCommand } from ${JSON.stringify(new URL("../../../apps/server/src/cli/sshHelper.ts", import.meta.url).href)};
        const cli = Command.make("t3").pipe(Command.withSubcommands([sshHelperCommand]));
        Command.run(cli, { version: ${JSON.stringify(version)} }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
      `,
          );
        }
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
      await NodeFSP.writeFile(script, buildRemoteLaunchScript(runner));
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
        expect(
          await NodeFSP.readFile(NodePath.join(home, ".t3/ssh-launch/test/managed"), "utf8"),
        ).toBe("external\n");
      });
    });

    it("does not launch an SSH replacement while the daemon child is restarting", async () => {
      await fixture(async (home, pid) => {
        await NodeFSP.writeFile(
          NodePath.join(home, ".t3/runtime/server-runtime.json"),
          JSON.stringify({ pid, launcherPid: pid, port: 1, origin: "http://127.0.0.1:1" }),
        );
        await expect(launch(home)).rejects.toMatchObject({
          stderr: expect.stringContaining("daemon is unavailable on 127.0.0.1:1"),
        });
        await expect(
          NodeFSP.stat(NodePath.join(home, ".t3/ssh-launch/test/pid")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    });

    it("reuses the daemon port when the recorded child has exited", async () => {
      await fixture(async (home, pid, port) => {
        await NodeFSP.writeFile(
          NodePath.join(home, ".t3/runtime/server-runtime.json"),
          JSON.stringify({
            pid: 2147483647,
            launcherPid: pid,
            port,
            origin: `http://127.0.0.1:${port}`,
          }),
        );
        const result = await launch(home);
        expect(JSON.parse(result.stdout)).toEqual({ remotePort: port, serverKind: "external" });
      });
    });

    it.each(["missing", "stale", "corrupt"])(
      "refuses a standalone even with a live foreground server when the daemon record is %s",
      async (state) => {
        await fixture(async (home, pid, port) => {
          await NodeFSP.writeFile(
            NodePath.join(home, ".t3/runtime/service-state.json"),
            JSON.stringify({ protocol: 2, activeVersion: version }),
          );
          if (state !== "missing") {
            await NodeFSP.writeFile(
              NodePath.join(home, ".t3/runtime/server-runtime.json"),
              state === "corrupt"
                ? "{"
                : JSON.stringify({
                    pid,
                    launcherPid: 2147483647,
                    port,
                    origin: `http://127.0.0.1:${port}`,
                  }),
            );
          }
          await NodeFSP.writeFile(
            NodePath.join(home, ".t3/userdata/server-runtime.json"),
            JSON.stringify({ pid, port, origin: `http://127.0.0.1:${port}` }),
          );
          await expect(launch(home)).rejects.toMatchObject({
            stderr: expect.stringContaining("Start or repair the service"),
          });
          await expect(
            NodeFSP.stat(NodePath.join(home, ".t3/ssh-launch/test/pid")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          // Removing service ownership restores foreground discovery.
          await NodeFSP.rm(NodePath.join(home, ".t3/runtime/service-state.json"));
          await NodeFSP.rm(NodePath.join(home, ".t3/runtime/server-runtime.json"), { force: true });
          const result = await launch(home);
          expect(JSON.parse(result.stdout)).toEqual({ remotePort: port, serverKind: "external" });
        });
      },
    );

    it("classifies the daemon as external even if stale SSH ownership names the same PID", async () => {
      await fixture(async (home, pid, port) => {
        const dir = NodePath.join(home, ".t3/ssh-launch/test");
        await NodeFSP.writeFile(
          NodePath.join(home, ".t3/runtime/server-runtime.json"),
          JSON.stringify({ pid, launcherPid: pid, port, origin: `http://127.0.0.1:${port}` }),
        );
        await NodeFSP.writeFile(NodePath.join(dir, "pid"), `${pid}\n`);
        await NodeFSP.writeFile(NodePath.join(dir, "port"), `${port}\n`);
        await NodeFSP.writeFile(NodePath.join(dir, "managed"), "managed\n");
        const result = await launch(home);
        expect(JSON.parse(result.stdout)).toEqual({ remotePort: port, serverKind: "external" });
        expect(await NodeFSP.readFile(NodePath.join(dir, "managed"), "utf8")).toBe("external\n");
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
          `${buildRemoteT3RunnerScript(runner).trimEnd()}\n`,
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
          stderr: expect.stringContaining("bind it to loopback or a wildcard host"),
        });
        await expect(
          NodeFSP.stat(NodePath.join(home, ".t3/ssh-launch/test/pid")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      });
    });
  },
);
