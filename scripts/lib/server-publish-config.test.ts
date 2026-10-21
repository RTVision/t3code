// @effect-diagnostics nodeBuiltinImport:off - Packs and executes a real pnpm archive in a disposable filesystem fixture.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "vite-plus/test";

import { createServerPublishConfig } from "./server-publish-config.ts";

it("packs bundled POSIX resource monitors with executable archive modes", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-monitor-pack-"));
  try {
    const source = NodePath.join(root, "source");
    const packed = NodePath.join(root, "packed");
    const extracted = NodePath.join(root, "extracted");
    for (const dir of [source, packed, extracted]) NodeFS.mkdirSync(dir);
    const monitors = [
      "linux-x64/t3-resource-monitor",
      "linux-arm64/t3-resource-monitor",
      "darwin-x64/t3-resource-monitor",
      "darwin-arm64/t3-resource-monitor",
      "t3-resource-monitor",
    ];
    const files = [
      ...monitors.map((file) => `dist/resource-monitor/${file}`),
      "dist/resource-monitor/win32-x64/t3-resource-monitor.exe",
      "dist/resource-monitor/linux-x64/README.txt",
      "dist/extra-helper",
      "dist/bin.mjs",
    ];
    for (const file of files) {
      const target = NodePath.join(source, file);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, "#!/bin/sh\nprintf 'monitor-ok\\n'\n");
      NodeFS.chmodSync(target, 0o755);
    }
    const existingConfig = {
      registry: "https://registry.npmjs.org/",
      access: "public",
      executableFiles: ["dist/extra-helper"],
    };
    const publishConfig = createServerPublishConfig(
      "https://npm-registry.rtvision.com/",
      NodeFS.readdirSync(NodePath.join(source, "dist/resource-monitor"), {
        recursive: true,
        encoding: "utf8",
      }),
      existingConfig,
    );
    NodeFS.writeFileSync(
      NodePath.join(source, "package.json"),
      JSON.stringify({
        name: "t3-monitor-pack-fixture",
        version: "1.0.0",
        files: ["dist"],
        bin: { t3: "dist/bin.mjs" },
        publishConfig,
      }),
    );
    NodeChildProcess.execFileSync("pnpm", ["pack", "--pack-destination", packed], { cwd: source });
    const archive = NodePath.join(packed, "t3-monitor-pack-fixture-1.0.0.tgz");
    const listing = NodeChildProcess.execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" });
    NodeChildProcess.execFileSync("tar", ["-xzf", archive, "-C", extracted]);
    for (const file of [
      ...monitors.map((file) => `dist/resource-monitor/${file}`),
      "dist/extra-helper",
      "dist/bin.mjs",
    ]) {
      const target = NodePath.join(extracted, "package", file);
      NodeAssert.equal(NodeFS.statSync(target).mode & 0o777, 0o755, `${file}\n${listing}`);
      if (HostProcess.Platform.defaultValue() !== "win32") {
        NodeFS.accessSync(target, NodeFS.constants.X_OK);
        NodeAssert.equal(
          NodeChildProcess.execFileSync(target, { encoding: "utf8" }),
          "monitor-ok\n",
        );
      }
    }
    for (const file of [
      "dist/resource-monitor/win32-x64/t3-resource-monitor.exe",
      "dist/resource-monitor/linux-x64/README.txt",
    ]) {
      NodeAssert.equal(
        NodeFS.statSync(NodePath.join(extracted, "package", file)).mode & 0o777,
        0o644,
      );
    }
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(extracted, "package/package.json"), "utf8"),
    );
    NodeAssert.deepEqual(manifest.publishConfig, publishConfig);
    NodeAssert.equal(manifest.publishConfig.registry, "https://npm-registry.rtvision.com/");
    NodeAssert.equal(manifest.publishConfig.access, "public");
    NodeAssert.deepEqual(existingConfig.executableFiles, ["dist/extra-helper"]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves executable declarations without bundled monitors", () => {
  NodeAssert.deepEqual(createServerPublishConfig("https://example.test/", []), {
    registry: "https://example.test/",
    executableFiles: [],
  });
  NodeAssert.deepEqual(
    createServerPublishConfig("https://example.test/", [], { executableFiles: ["dist/helper"] }),
    { registry: "https://example.test/", executableFiles: ["dist/helper"] },
  );
});

it("normalizes Windows paths and does not duplicate existing executable declarations", () => {
  const monitor = "dist/resource-monitor/linux-x64/t3-resource-monitor";
  NodeAssert.deepEqual(
    createServerPublishConfig(
      "https://example.test/",
      [
        "linux-x64\\t3-resource-monitor",
        "darwin-arm64\\t3-resource-monitor",
        "win32-x64\\t3-resource-monitor.exe",
        "linux-x64\\README.txt",
      ],
      { executableFiles: [monitor, "dist/helper"] },
    ),
    {
      registry: "https://example.test/",
      executableFiles: [
        monitor,
        "dist/helper",
        "dist/resource-monitor/darwin-arm64/t3-resource-monitor",
      ],
    },
  );
});
