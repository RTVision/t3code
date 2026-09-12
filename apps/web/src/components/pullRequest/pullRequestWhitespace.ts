import { hydratePartialDiff, parseDiffFromFile } from "@pierre/diffs";
import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";

export const WHITESPACE_MODES = [
  { value: "all", label: "Show all changes" },
  { value: "ignore-all", label: "Ignore whitespace when comparing lines" },
  { value: "ignore-amount", label: "Ignore changes in amount of whitespace" },
  { value: "ignore-eol", label: "Ignore changes in whitespace at EOL" },
] as const;
export type WhitespaceMode = (typeof WHITESPACE_MODES)[number]["value"];

function normalize(contents: string, mode: WhitespaceMode) {
  switch (mode) {
    case "ignore-all":
      return contents.replace(/[^\S\n]+/g, "");
    case "ignore-amount":
      return contents.replace(/[^\S\n]+(?=\n|$)/g, "").replace(/[^\S\n]+/g, " ");
    case "ignore-eol":
      return contents.replace(/[^\S\n]+(?=\n|$)/g, "");
    case "all":
      return contents;
  }
}

/** Recompare only supplied hunks, keeping the real text and both source line coordinates. */
export function filterDiffWhitespace(
  file: FileDiffMetadata,
  mode: WhitespaceMode,
  contents?: FileDiffLoadedFiles,
): FileDiffMetadata {
  if (mode === "all" || file.type === "new" || file.type === "deleted" || file.hunks.length === 0)
    return file;
  if (contents) {
    const hydrated = hydratePartialDiff("clone", file, contents);
    for (const hunk of file.hunks) {
      for (const side of ["addition", "deletion"] as const) {
        const actual = hydrated[`${side}Lines`].slice(
          Math.max(0, hunk[`${side}Start`] - 1),
          Math.max(0, hunk[`${side}Start`] - 1) + hunk[`${side}Count`],
        );
        const expected = file[`${side}Lines`].slice(
          hunk[`${side}LineIndex`],
          hunk[`${side}LineIndex`] + hunk[`${side}Count`],
        );
        if (actual.join("") !== expected.join(""))
          throw new Error("The file changed since this diff was loaded");
      }
    }
    return filterDiffWhitespace(hydrated, mode);
  }
  if (!file.isPartial) {
    const compared = parseDiffFromFile(
      { name: file.prevName ?? file.name, contents: normalize(file.deletionLines.join(""), mode) },
      { name: file.name, contents: normalize(file.additionLines.join(""), mode) },
      { context: 3 },
    );
    return {
      ...file,
      hunks: compared.hunks,
      splitLineCount: compared.splitLineCount,
      unifiedLineCount: compared.unifiedLineCount,
      cacheKey: `${file.cacheKey}:whitespace:${mode}`,
    };
  }
  // Separate hunks can hide lines that should match across the old boundaries after filtering.
  if (file.hunks.length > 1)
    throw new Error("Full file contents are required to compare separate hunks");
  const hunks: FileDiffMetadata["hunks"] = [];
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  let previousAdditionEnd = 0;
  for (const original of file.hunks) {
    const oldContents = file.deletionLines
      .slice(original.deletionLineIndex, original.deletionLineIndex + original.deletionCount)
      .join("");
    const newContents = file.additionLines
      .slice(original.additionLineIndex, original.additionLineIndex + original.additionCount)
      .join("");
    const compared = parseDiffFromFile(
      { name: file.prevName ?? file.name, contents: normalize(oldContents, mode) },
      { name: file.name, contents: normalize(newContents, mode) },
      { context: 3 },
    );
    for (const hunk of compared.hunks) {
      const additionStart = hunk.additionStart + Math.max(0, original.additionStart - 1);
      const deletionStart = hunk.deletionStart + Math.max(0, original.deletionStart - 1);
      hunks.push({
        ...hunk,
        additionStart,
        deletionStart,
        additionLineIndex: hunk.additionLineIndex + original.additionLineIndex,
        deletionLineIndex: hunk.deletionLineIndex + original.deletionLineIndex,
        collapsedBefore: Math.max(0, additionStart - 1 - previousAdditionEnd),
        splitLineStart: splitLineCount,
        unifiedLineStart: unifiedLineCount,
        hunkContent: hunk.hunkContent.map((content) => ({
          ...content,
          additionLineIndex: content.additionLineIndex + original.additionLineIndex,
          deletionLineIndex: content.deletionLineIndex + original.deletionLineIndex,
        })),
      });
      splitLineCount += hunk.splitLineCount;
      unifiedLineCount += hunk.unifiedLineCount;
      previousAdditionEnd = additionStart + hunk.additionCount - 1;
    }
  }
  return {
    ...file,
    cacheKey: `${file.cacheKey}:whitespace:${mode}`,
    isPartial: true,
    hunks,
    splitLineCount,
    unifiedLineCount,
  };
}
