import { assert, it } from "@effect/vitest";

import { shouldBuildNodePtyFromSource } from "./nodePtyInstall.ts";

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
