import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  applyDiffSlice,
  foldChoicesAfterViewed,
  isFileDiffCollapsed,
  isLineInFileDiff,
  type DiffFoldChoices,
  type DiffSlice,
  type DiffSliceState,
} from "./pullRequestDiff.logic";

/** Only the hunk ranges matter here; the viewer fills the rest in when it renders. */
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

  it("places a line inside a hunk, on the side that hunk counts", () => {
    expect(isLineInFileDiff(file, "right", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 11)).toBe(true);
  });

  it("includes the first line of a hunk and excludes the one past its last", () => {
    // The boundaries are where an off-by-one would quietly move a conversation between lists.
    expect(isLineInFileDiff(file, "right", 10)).toBe(true);
    expect(isLineInFileDiff(file, "right", 14)).toBe(true);
    expect(isLineInFileDiff(file, "right", 15)).toBe(false);
    expect(isLineInFileDiff(file, "left", 9)).toBe(false);
    expect(isLineInFileDiff(file, "left", 12)).toBe(true);
    expect(isLineInFileDiff(file, "left", 13)).toBe(false);
  });

  it("keeps the two sides apart, since one line number means two lines", () => {
    // The second hunk is a pure insertion: it deletes nothing, so nothing is on its left.
    expect(isLineInFileDiff(file, "right", 43)).toBe(true);
    expect(isLineInFileDiff(file, "left", 40)).toBe(false);
  });

  it("places nothing in a file whose hunks the host withheld", () => {
    expect(isLineInFileDiff(fileWithHunks([]), "right", 1)).toBe(false);
  });
});

describe("isFileDiffCollapsed", () => {
  const NO_CHOICES: DiffFoldChoices = new Map();

  it("opens every file before the reader has touched anything", () => {
    expect(isFileDiffCollapsed("a.ts", null, NO_CHOICES, false)).toBe(false);
    expect(isFileDiffCollapsed("b.ts", null, NO_CHOICES, false)).toBe(false);
  });

  it("keeps a file already ticked off folded by default", () => {
    // Coming back to a change should open what is left to review, not what was already read.
    expect(isFileDiffCollapsed("a.ts", null, NO_CHOICES, true)).toBe(true);
  });

  it("opens every file once the toolbar has asked for it, ticked off or not", () => {
    // Pressing the toolbar clears the reader's own choices, which is why the map is empty here.
    expect(isFileDiffCollapsed("a.ts", "expanded", NO_CHOICES, false)).toBe(false);
    expect(isFileDiffCollapsed("b.ts", "expanded", NO_CHOICES, true)).toBe(false);
  });

  it("folds every file again on the second press", () => {
    expect(isFileDiffCollapsed("a.ts", "folded", NO_CHOICES, false)).toBe(true);
    expect(isFileDiffCollapsed("b.ts", "folded", NO_CHOICES, true)).toBe(true);
  });

  it("keeps a file the reader folded closed as the next slice arrives", () => {
    // The file keys grow with every slice, so the answer for one already folded must not depend
    // on how many of them there are by then.
    const choices = new Map([["b.ts", true]]);
    expect(isFileDiffCollapsed("b.ts", null, choices, false)).toBe(true);
    expect(isFileDiffCollapsed("c.ts", null, choices, false)).toBe(false);
  });

  it("holds a file the reader opened by hand while its viewed state moves underneath", () => {
    // Ticked off, then opened by hand the way the chevron records it.
    const ticked = foldChoicesAfterViewed("a.ts", true, null, new Map());
    expect(isFileDiffCollapsed("a.ts", null, ticked, true)).toBe(true);
    const opened = new Map(ticked).set("a.ts", false);
    expect(isFileDiffCollapsed("a.ts", null, opened, true)).toBe(false);
    // A push leaves it stale, which counts as not viewed, then another device ticks it again.
    expect(isFileDiffCollapsed("a.ts", null, opened, false)).toBe(false);
    expect(isFileDiffCollapsed("a.ts", null, opened, true)).toBe(false);
  });
});

describe("foldChoicesAfterViewed", () => {
  it("lets the default put a file away when it is ticked off", () => {
    const untouched: DiffFoldChoices = new Map();
    expect(foldChoicesAfterViewed("a.ts", true, null, untouched)).toBe(untouched);
    expect(foldChoicesAfterViewed("a.ts", false, null, untouched)).toBe(untouched);
  });

  it("drops a hand choice the tick now agrees with, so the default keeps following the file", () => {
    const choices = foldChoicesAfterViewed("a.ts", true, null, new Map([["a.ts", false]]));
    expect(choices.size).toBe(0);
    expect(isFileDiffCollapsed("a.ts", null, choices, true)).toBe(true);
    // A push later leaves the file stale, which counts as not viewed, and it opens again.
    expect(isFileDiffCollapsed("a.ts", null, choices, false)).toBe(false);
  });

  it("records the fold where the toolbar's default disagrees with the tick", () => {
    // Everything is open, so ticking a file off has to fold that one against the default.
    expect([...foldChoicesAfterViewed("a.ts", true, "expanded", new Map())]).toEqual([
      ["a.ts", true],
    ]);
    expect(foldChoicesAfterViewed("a.ts", false, "expanded", new Map([["a.ts", true]])).size).toBe(
      0,
    );
    expect([...foldChoicesAfterViewed("a.ts", false, "folded", new Map())]).toEqual([
      ["a.ts", false],
    ]);
  });

  it("touches only the file that was ticked", () => {
    const choices = new Map([
      ["a.ts", false],
      ["b.ts", true],
    ]);
    expect([...foldChoicesAfterViewed("a.ts", true, null, choices)]).toEqual([["b.ts", true]]);
  });
});

describe("diff slices", () => {
  const slice = (cursor: string | null, patch: string, nextCursor: string | null): DiffSlice => ({
    cursor,
    patch,
    truncated: false,
    nextCursor,
    omittedFileStats: [],
  });
  const loaded: DiffSliceState = {
    key: "pr-1",
    cursor: "b",
    slices: [slice(null, "one", "a"), slice("a", "two", "b"), slice("b", "three", null)],
    revalidating: false,
  };

  it("appends a new slice and moves the cursor onto it", () => {
    expect(
      applyDiffSlice(
        { key: "", cursor: null, slices: [], revalidating: false },
        { key: "pr-1", slice: slice(null, "one", "a"), settled: true },
      ),
    ).toEqual({
      key: "pr-1",
      cursor: null,
      slices: [slice(null, "one", "a")],
      revalidating: false,
    });
  });

  it("keeps the same state when the last slice comes back unchanged", () => {
    expect(
      applyDiffSlice(loaded, { key: "pr-1", slice: slice("b", "three", null), settled: true }),
    ).toBe(loaded);
  });

  it("walks the loaded slices again, one settled answer at a time", () => {
    const walking = { ...loaded, cursor: null, revalidating: true };
    // The cached answer shown while the read is out, or kept by a failed one, does not advance it.
    expect(
      applyDiffSlice(walking, { key: "pr-1", slice: slice(null, "one", "a"), settled: false }),
    ).toBe(walking);
    const second = applyDiffSlice(walking, {
      key: "pr-1",
      slice: slice(null, "one", "a"),
      settled: true,
    });
    expect(second).toEqual({ ...walking, cursor: "a" });
    expect(second.slices).toBe(loaded.slices);
    const third = applyDiffSlice(second, {
      key: "pr-1",
      slice: slice("a", "two", "b"),
      settled: true,
    });
    expect(third).toEqual({ ...walking, cursor: "b" });
    // The last slice is owed a settled answer too before the walk is over.
    expect(
      applyDiffSlice(third, { key: "pr-1", slice: slice("b", "three", null), settled: false }),
    ).toBe(third);
    expect(
      applyDiffSlice(third, { key: "pr-1", slice: slice("b", "three", null), settled: true }),
    ).toEqual(loaded);
  });

  it("ends a walk over a single slice only once it is confirmed", () => {
    const single: DiffSliceState = {
      key: "pr-1",
      cursor: null,
      slices: [slice(null, "one", null)],
      revalidating: true,
    };
    expect(
      applyDiffSlice(single, { key: "pr-1", slice: slice(null, "one", null), settled: false }),
    ).toBe(single);
    expect(
      applyDiffSlice(single, { key: "pr-1", slice: slice(null, "one", null), settled: true }),
    ).toEqual({ ...single, revalidating: false });
  });

  it("replaces a slice that changed and drops the ones read after it", () => {
    expect(
      applyDiffSlice(
        { ...loaded, cursor: "a", revalidating: true },
        { key: "pr-1", slice: slice("a", "two, pushed", "c"), settled: true },
      ),
    ).toEqual({
      key: "pr-1",
      cursor: "a",
      slices: [slice(null, "one", "a"), slice("a", "two, pushed", "c")],
      revalidating: false,
    });
  });

  it("starts over when the answer belongs to another scope", () => {
    expect(
      applyDiffSlice(loaded, { key: "pr-2", slice: slice(null, "other", null), settled: true }),
    ).toEqual({
      key: "pr-2",
      cursor: null,
      slices: [slice(null, "other", null)],
      revalidating: false,
    });
  });
});
