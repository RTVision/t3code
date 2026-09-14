// @effect-diagnostics nodeBuiltinImport:off - Executes generated shell scripts against real runtime installations on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { describe, expect, it } from "vite-plus/test";

import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";

import { buildRemoteT3RunnerScript } from "./tunnel.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const version = "1.2.3";
const packageName = "@rtvision/t3";

/** Runs the generated runner against isolated installed-runtime and npm-fallback fixtures. */
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
    await NodeFSP.writeFile(NodePath.join(bin, "curl"), "#!/bin/sh\nexit 22\n", { mode: 0o700 });
    await NodeFSP.writeFile(
      NodePath.join(bin, "npm"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const dir = path.join(args[args.indexOf("--prefix") + 1], "node_modules/t3");
const version = args.at(-1).split("@").at(-1);
if (args.at(-1) !== "t3@npm:@rtvision/t3@" + version) process.exit(3);
if (args[args.indexOf("--registry") + 1] !== "https://npm-registry.rtvision.com/") process.exit(4);
fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@rtvision/t3", version }));
fs.writeFileSync(path.join(dir, "dist/bin.mjs"), 'process.stdout.write(process.argv.includes("--version") ? "' + version + '" : "npm fallback");');
`,
      { mode: 0o700 },
    );
    await NodeFSP.writeFile(
      NodePath.join(packageDir, "package.json"),
      JSON.stringify({ name: packageName, version }),
    );
    await NodeFSP.writeFile(NodePath.join(runtime, ".install-complete"), `${version}\n`);
    await NodeFSP.writeFile(
      NodePath.join(packageDir, "dist", "bin.mjs"),
      'process.stdout.write(JSON.stringify({ source: "installed", args: process.argv.slice(2) }));',
    );
    await run({
      root,
      runtime,
      packageDir,
      execute: async (options) => {
        const script = NodePath.join(root, "runner.sh");
        await NodeFSP.writeFile(
          script,
          buildRemoteT3RunnerScript({ archiveVersion: version, ...options }),
        );
        const result = await execFile(
          "/bin/sh",
          [script, "auth", "pairing", "create", "--base-dir", root, "--json"],
          { env: { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` } },
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

  it("falls back when an archive cannot run and reuses the resulting Node install", () =>
    fixture(async ({ root, runtime, execute }) => {
      await NodeFSP.rm(runtime, { recursive: true });
      const stage = NodePath.join(root, "archive-stage");
      await NodeFSP.mkdir(stage);
      await NodeFSP.writeFile(NodePath.join(stage, "t3"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      const platform = HostProcessPlatform.defaultValue() === "darwin" ? "darwin" : "linux";
      const name = `t3-${version}-${platform}-${HostProcessArchitecture.defaultValue()}.tar.gz`;
      const archive = NodePath.join(root, name);
      await execFile("tar", ["-czf", archive, "-C", root, "archive-stage"]);
      const checksum = NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(archive))
        .digest("hex");
      await NodeFSP.writeFile(NodePath.join(root, "SHA256SUMS"), `${checksum}  ${name}\n`);
      await NodeFSP.writeFile(
        NodePath.join(root, "bin/curl"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const output = args.indexOf("-o");
fs.copyFileSync(path.join(process.env.HOME, args[output - 1].split("/").at(-1)), args[output + 1]);
`,
        { mode: 0o700 },
      );
      expect(await execute()).toBe("npm fallback");
      expect(await NodeFSP.readFile(NodePath.join(runtime, ".install-complete"), "utf8")).toBe(
        `${version}\n`,
      );
      await expect(NodeFSP.stat(NodePath.join(runtime, "t3"))).rejects.toThrow();
      await NodeFSP.writeFile(NodePath.join(root, "bin/npm"), "#!/bin/sh\nexit 99\n", {
        mode: 0o700,
      });
      expect(await execute()).toBe("npm fallback");
    }));

  it("does not reuse an older installation after a desktop update", () =>
    fixture(async ({ execute }) => {
      expect(await execute({ archiveVersion: "1.2.4" })).toBe("npm fallback");
    }));

  it("keeps explicit script overrides ahead of installed runtimes", () =>
    fixture(async ({ root, execute }) => {
      const override = NodePath.join(root, "override.mjs");
      await NodeFSP.writeFile(override, 'process.stdout.write("explicit override");');
      expect(await execute({ nodeScriptPath: override })).toBe("explicit override");
    }));

  it("rejects dist-tags before constructing a runtime path", () => {
    expect(() => buildRemoteT3RunnerScript({ archiveVersion: "latest" })).toThrow();
  });
});
