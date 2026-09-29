import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { findOccurrences, searchDiffFiles, type DiffSearchFile } from "./diffSearch";

function file(fileKey: string, patch: string[]): DiffSearchFile {
  const fileDiff = parsePatchFiles(patch.join("\n"), `diff-search-${fileKey}`)[0]!.files[0]!;
  return { fileKey, filePath: fileDiff.name, fileDiff };
}

const app = file("app", [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,4 @@",
  " const value = 1;",
  "-const label = 'old';",
  "+const label = 'new';",
  " export { value };",
  " export { label };",
  "@@ -20,3 +20,4 @@",
  " function render() {",
  "+  log(value, value);",
  "   return value;",
  " }",
]);

const readme = file("readme", [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -3,2 +3,2 @@",
  "-Old Value",
  "+New Value",
  " end",
]);

describe("findOccurrences", () => {
  it("is case-insensitive for lowercase queries and does not overlap", () => {
    expect(findOccurrences("Value value VALUE", "value")).toEqual([
      [0, 5],
      [6, 11],
      [12, 17],
    ]);
    expect(findOccurrences("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it("becomes case-sensitive once the query has a capital letter", () => {
    expect(findOccurrences("Value value VALUE", "Value")).toEqual([[0, 5]]);
  });

  it("stops scanning at the limit", () => {
    expect(findOccurrences("a".repeat(200_000), "a", 3)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("treats the query literally", () => {
    expect(findOccurrences("a.b axb (c)", "a.b")).toEqual([[0, 3]]);
    expect(findOccurrences("call(x) (c)", "(c)")).toEqual([[8, 11]]);
  });

  it("keeps spans inside the original text when case folding changes length", () => {
    for (const [text, query] of [
      ["İi", "i\u0307"],
      ["İ", "i"],
      ["STRASSE straße", "straße"],
    ] as const) {
      for (const [start, end] of findOccurrences(text, query)) {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(text.length);
        expect(text.slice(start, end).toLowerCase()).toBe(query.toLowerCase());
      }
    }
  });
});

describe("searchDiffFiles", () => {
  it("returns matches in reading order with each side's own line numbers", () => {
    const { matches, truncated } = searchDiffFiles([app, readme], "value");
    expect(truncated).toBe(false);
    expect(
      matches.map(({ fileKey, side, lineNumber, occurrence }) => ({
        fileKey,
        side,
        lineNumber,
        occurrence,
      })),
    ).toEqual([
      { fileKey: "app", side: "additions", lineNumber: 1, occurrence: 0 },
      { fileKey: "app", side: "additions", lineNumber: 3, occurrence: 0 },
      { fileKey: "app", side: "additions", lineNumber: 21, occurrence: 0 },
      { fileKey: "app", side: "additions", lineNumber: 21, occurrence: 1 },
      { fileKey: "app", side: "additions", lineNumber: 22, occurrence: 0 },
      { fileKey: "readme", side: "deletions", lineNumber: 3, occurrence: 0 },
      { fileKey: "readme", side: "additions", lineNumber: 3, occurrence: 0 },
    ]);
  });

  it("finds removed lines on the deletions side", () => {
    expect(searchDiffFiles([app], "old").matches).toEqual([
      {
        fileKey: "app",
        filePath: "src/app.ts",
        side: "deletions",
        lineNumber: 2,
        occurrence: 0,
      },
    ]);
  });

  it("stops at the limit and reports that more exist", () => {
    const result = searchDiffFiles([app], "value", 2);
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("caps a single long line without reporting a full result as truncated", () => {
    const minified = file("min", [
      "diff --git a/min.js b/min.js",
      "--- a/min.js",
      "+++ b/min.js",
      "@@ -1 +1 @@",
      "-x",
      `+${"a".repeat(200_000)}`,
    ]);
    expect(searchDiffFiles([minified], "a", 5)).toMatchObject({ truncated: true });
    expect(searchDiffFiles([minified], "a", 5).matches).toHaveLength(5);
    expect(searchDiffFiles([app], "value", 5).truncated).toBe(false);
  });

  it("matches nothing for an empty query", () => {
    expect(searchDiffFiles([app], "")).toEqual({ matches: [], truncated: false });
  });
});
