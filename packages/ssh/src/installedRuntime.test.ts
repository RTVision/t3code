// @effect-diagnostics nodeBuiltinImport:off - Executes generated shell scripts against real runtime installations on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "vite-plus/test";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { buildRemoteT3RunnerScript } from "./tunnel.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const version = "1.2.3";
const packageName = "@rtvision/t3";

async function fixture(
  run: (input: {
    root: string;
    runtime: string;
    packageDir: string;
    execute: (options?: Parameters<typeof buildRemoteT3RunnerScript>[0]) => Promise<string>;
  }) => Promise<void>,
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3 installed runtime "));
  const runtime = NodePath.join(root, ".t3", "runtime", "versions", version);
  const packageDir = NodePath.join(runtime, "node_modules", "t3");
  const bin = NodePath.join(root, "bin");
  try {
    await NodeFSP.mkdir(NodePath.join(packageDir, "dist"), { recursive: true });
    await NodeFSP.mkdir(bin);
    await NodeFSP.symlink(process.execPath, NodePath.join(bin, "node"));
    await NodeFSP.writeFile(
      NodePath.join(packageDir, "package.json"),
      JSON.stringify({ name: packageName, version }),
    );
    await NodeFSP.writeFile(NodePath.join(runtime, ".install-complete"), `${version}\n`);
    await NodeFSP.writeFile(
      NodePath.join(packageDir, "dist", "bin.mjs"),
      'process.stdout.write(JSON.stringify({ source: "installed", args: process.argv.slice(2) }));',
    );
    const fallback = NodePath.join(root, "fallback");
    await NodeFSP.writeFile(fallback, '#!/bin/sh\nprintf "npm fallback"\n', { mode: 0o700 });
    await NodeFSP.writeFile(
      NodePath.join(bin, "npx"),
      "#!/usr/bin/env node\nprocess.stdout.write(process.env.T3_TEST_FALLBACK);\n",
      { mode: 0o700 },
    );
    await run({
      root,
      runtime,
      packageDir,
      execute: async (options) => {
        const script = NodePath.join(root, "runner.sh");
        await NodeFSP.writeFile(
          script,
          buildRemoteT3RunnerScript({ packageSpec: `${packageName}@${version}`, ...options }),
        );
        const result = await execFile(
          "/bin/sh",
          [script, "auth", "pairing", "create", "--base-dir", root, "--json"],
          { env: { ...process.env, HOME: root, PATH: bin, T3_TEST_FALLBACK: fallback } },
        );
        return result.stdout;
      },
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("installed remote CLI", () => {
  it("pairs using the complete matching runtime without npm, preserving arguments and spaces", () =>
    fixture(async ({ root, execute }) => {
      expect(JSON.parse(await execute())).toEqual({
        source: "installed",
        args: ["auth", "pairing", "create", "--base-dir", root, "--json"],
      });
    }));

  it.each([
    "incomplete",
    "wrong-sentinel",
    "invalid-manifest",
    "wrong-package",
    "wrong-version",
    "missing-entry",
  ] as const)("falls back to npm for a %s installation", (state) =>
    fixture(async ({ runtime, packageDir, execute }) => {
      if (state === "incomplete") await NodeFSP.rm(NodePath.join(runtime, ".install-complete"));
      if (state === "wrong-sentinel")
        await NodeFSP.writeFile(NodePath.join(runtime, ".install-complete"), "1.2.2\n");
      if (state === "invalid-manifest")
        await NodeFSP.writeFile(NodePath.join(packageDir, "package.json"), "{");
      if (state === "wrong-package" || state === "wrong-version") {
        await NodeFSP.writeFile(
          NodePath.join(packageDir, "package.json"),
          JSON.stringify({
            name: state === "wrong-package" ? "t3" : packageName,
            version: state === "wrong-version" ? "1.2.2" : version,
          }),
        );
      }
      if (state === "missing-entry") await NodeFSP.rm(NodePath.join(packageDir, "dist", "bin.mjs"));
      expect(await execute()).toBe("npm fallback");
    }),
  );

  it("does not reuse an older installation after a desktop update", () =>
    fixture(async ({ execute }) => {
      expect(await execute({ packageSpec: `${packageName}@1.2.4` })).toBe("npm fallback");
    }));

  it("keeps explicit script overrides ahead of installed runtimes", () =>
    fixture(async ({ root, execute }) => {
      const override = NodePath.join(root, "override.mjs");
      await NodeFSP.writeFile(override, 'process.stdout.write("explicit override");');
      expect(await execute({ nodeScriptPath: override })).toBe("explicit override");
    }));

  it("resolves dist-tags through npm", () =>
    fixture(async ({ execute }) => {
      expect(await execute({ packageSpec: `${packageName}@latest` })).toBe("npm fallback");
    }));
});
