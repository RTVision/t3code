import { assert, it } from "@effect/vitest";

import { npmRebuildPrefix, shouldBuildNodePtyFromSource } from "./nodePtyInstall.ts";

it("builds node-pty from source on Linux without glibc", () => {
  assert.isTrue(shouldBuildNodePtyFromSource("linux", undefined));
  assert.isTrue(shouldBuildNodePtyFromSource("linux", null));
});

it("uses the prebuild on glibc Linux", () => {
  assert.isFalse(shouldBuildNodePtyFromSource("linux", "2.39"));
});

it("does not rebuild node-pty on non-Linux hosts", () => {
  assert.isFalse(shouldBuildNodePtyFromSource("darwin", undefined));
  assert.isFalse(shouldBuildNodePtyFromSource("win32", undefined));
});

it("rebuilds from npm's local install prefix", () => {
  assert.equal(
    npmRebuildPrefix(
      { npm_config_local_prefix: "/tmp/project", npm_config_prefix: "/usr/local" },
      "/tmp/project/node_modules/t3",
    ),
    "/tmp/project",
  );
});

it("uses the global npm prefix for global installs", () => {
  assert.equal(
    npmRebuildPrefix(
      {
        npm_config_global: "true",
        npm_config_prefix: "/opt/node",
        npm_config_local_prefix: "/tmp",
      },
      "/opt/node/lib/node_modules/t3",
    ),
    "/opt/node",
  );
});
