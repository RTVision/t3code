// @effect-diagnostics nodeBuiltinImport:off - Exercises the CLI's Node process boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { buildRemoteLaunchScript } from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { vi } from "vite-plus/test";

import { sshHelperCommand } from "./sshHelper.ts";

const cli = Command.make("t3").pipe(Command.withSubcommands([sshHelperCommand]));
const launchScript = buildRemoteLaunchScript({ nodeScriptPath: "/unused/t3.mjs" });
const inlineScript = launchScript.match(
  /node - "\$\{1:-\$DEFAULT_RUNTIME_FILE\}" <<'NODE'\n([\s\S]*?)\nNODE/,
)?.[1];
if (!inlineScript) throw new Error("SSH runtime discovery script was not found");

const childPid = 12345;
const launcherPid = 23456;
const runtime = { pid: childPid, port: 3773, origin: "http://127.0.0.1:3773" };
const cases = [
  { name: "reuses a foreground server", runtime, live: [childPid], found: true },
  { name: "rejects a stopped foreground server", runtime, live: [], found: false },
  {
    name: "reserves the daemon port while its child is replaced",
    runtime: { ...runtime, launcherPid },
    live: [launcherPid],
    found: true,
  },
  {
    name: "rejects a dead launcher even if the child PID is alive",
    runtime: { ...runtime, launcherPid },
    live: [childPid],
    found: false,
  },
  {
    name: "discovers a daemon with a wildcard origin",
    runtime: { ...runtime, launcherPid, origin: "http://0.0.0.0:3773" },
    live: [launcherPid],
    found: true,
  },
  {
    name: "requires loopback for foreground discovery",
    runtime: { ...runtime, origin: "http://192.0.2.1:3773" },
    live: [childPid],
    found: false,
  },
  ...[0, -1, null, "invalid", 1.5].map((pid) => ({
    name: `rejects invalid launcher PID ${String(pid)}`,
    runtime: { ...runtime, launcherPid: pid },
    live: [childPid],
    found: false,
  })),
];

for (const mode of ["packaged", "inline"] as const) {
  describe(`${mode} SSH runtime discovery`, () => {
    for (const testCase of cases) {
      it.effect(testCase.name, () =>
        Effect.gen(function* () {
          const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ssh-helper-"));
          const runtimeFile = NodePath.join(dir, "server-runtime.json");
          NodeFS.writeFileSync(runtimeFile, JSON.stringify(testCase.runtime));
          const previousExitCode = process.exitCode;
          const probes: number[] = [];
          let output = "";
          let exitCode = 0;
          const kill = (pid: number, signal?: string | number) => {
            assert.equal(signal, 0);
            probes.push(pid);
            if (!testCase.live.includes(pid)) throw new Error("ESRCH");
            return true as const;
          };
          try {
            if (mode === "packaged") {
              process.exitCode = 0;
              vi.spyOn(process, "kill").mockImplementation(kill);
              vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
                output += String(chunk);
                return true;
              });
              yield* Command.runWith(cli, { version: "0.0.0" })([
                "__ssh-helper",
                "runtime-port",
                runtimeFile,
              ]).pipe(Effect.provide(NodeServices.layer));
              exitCode = Number(process.exitCode);
            } else {
              const exited = new Error("process.exit");
              try {
                NodeVM.runInNewContext(inlineScript, {
                  require: () => NodeFS,
                  URL,
                  process: {
                    argv: ["node", "-", runtimeFile],
                    kill,
                    stdout: {
                      write: (chunk: string) => {
                        output += chunk;
                      },
                    },
                    exit: (code: number) => {
                      exitCode = code;
                      throw exited;
                    },
                  },
                });
              } catch (error) {
                if (error !== exited) throw error;
              }
            }
            assert.equal(exitCode, testCase.found ? 0 : 1);
            assert.equal(output, testCase.found ? `${childPid} 3773` : "");
            assert.isTrue(probes.every((pid) => Number.isInteger(pid) && pid > 0));
          } finally {
            vi.restoreAllMocks();
            process.exitCode = previousExitCode;
            NodeFS.rmSync(dir, { recursive: true, force: true });
          }
        }),
      );
    }
  });
}
