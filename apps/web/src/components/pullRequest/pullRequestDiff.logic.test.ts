import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { isFileDiffCollapsed, isLineInFileDiff } from "./pullRequestDiff.logic";

function fileWithHunks(
  hunks: ReadonlyArray<{
    deletionStart: number;
    deletionCount: number;
    additionStart: number;
    additionCount: number;
  }>,
): FileDiffMetadata {
  return { name: "src/app.ts", hunks } as unknown as FileDiffMetadata;
}

describe("isLineInFileDiff", () => {
  const file = fileWithHunks([
    { deletionStart: 10, deletionCount: 3, additionStart: 10, additionCount: 5 },
    { deletionStart: 40, deletionCount: 0, additionStart: 42, additionCount: 2 },
  ]);

  it("includes the first line of a hunk and excludes the one past its last", () => {
    expect(isLineInFileDiff(file, "right", 10)).toBe(true);
    expect(isLineInFileDiff(file, "right", 14)).toBe(true);
    expect(isLineInFileDiff(file, "right", 15)).toBe(false);
    expect(isLineInFileDiff(file, "left", 9)).toBe(false);
    expect(isLineInFileDiff(file, "left", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 13)).toBe(false);
  });

  it("keeps the two sides apart, since one line number means two lines", () => {
    expect(isLineInFileDiff(file, "right", 43)).toBe(true);
    expect(isLineInFileDiff(file, "left", 40)).toBe(false);
  });
});

describe("isFileDiffCollapsed", () => {
  // regression: #9174 diffs now expand by default; a reader's fold must survive new slices
  it("keeps a file the reader folded closed as the next slice arrives", () => {
    // The file keys grow with every slice, so the answer for one already folded must not depend
    // on how many of them there are by then.
    const choices = new Map([["b.ts", true]]);
    expect(isFileDiffCollapsed("b.ts", null, choices, false)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", null, choices, false)).toBe(false);
  });
});
