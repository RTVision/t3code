import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";
import { getDiffLineStat } from "~/lib/diffRendering";
import { resolveDiffReviewPosition } from "~/reviewCommentContext";
import { filterDiffWhitespace } from "./pullRequestWhitespace";

const file = (before: string, after: string) =>
  parseDiffFromFile(
    { name: "view.vue", contents: before },
    { name: "view.vue", contents: after },
    { context: 3 },
  );

describe("PR whitespace comparison", () => {
  it("shows the wrapper without marking its indented children as changed", () => {
    const children = Array.from({ length: 200 }, (_, i) => `  <p>Item ${i}</p>\n`);
    const original = file(
      `<template>\n${children.join("")}</template>\n`,
      `<template>\n  <div>\n${children.map((line) => `  ${line}`).join("")}  </div>\n</template>\n`,
    );
    const filtered = filterDiffWhitespace(original, "ignore-all");
    expect(getDiffLineStat([filtered])).toEqual({ additions: 2, deletions: 0 });
    expect(filtered.hunks).toHaveLength(2);
    expect(filtered.additionLines).toEqual(original.additionLines);
    expect(filtered.deletionLines).toEqual(original.deletionLines);
    expect(resolveDiffReviewPosition(filtered, 203, "additions")).toEqual({
      kind: "added",
      newLine: 203,
    });
    expect(resolveDiffReviewPosition(filtered, 3, "additions")?.kind).toBe("context");
    // Submission must use the source diff: the host still calls the reindented line an addition.
    expect(resolveDiffReviewPosition(original, 3, "additions")).toEqual({
      kind: "added",
      newLine: 3,
    });
    expect(filterDiffWhitespace(original, "all")).toBe(original);
  });

  it("keeps file coordinates and text when a partial patch starts far into a file", () => {
    const original = parsePatchFiles(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -100,3 +110,4 @@\n-  before();\n-  keep();\n-  end();\n+    before();\n+    added();\n+    keep();\n+    end();\n",
    )[0]!.files[0]!;
    const filtered = filterDiffWhitespace(original, "ignore-all");
    expect(getDiffLineStat([filtered])).toEqual({ additions: 1, deletions: 0 });
    expect(filtered.hunks[0]).toMatchObject({ additionStart: 110, deletionStart: 100 });
    expect(resolveDiffReviewPosition(filtered, 111, "additions")).toEqual({
      kind: "added",
      newLine: 111,
    });
    expect(filtered.additionLines[filtered.hunks[0]!.additionLineIndex]).toBe("    before();\n");
  });

  it("distinguishes all whitespace, whitespace amount, and trailing whitespace", () => {
    const spacing = file("const x = a + b;\n", "const  x = a  + b; \n");
    expect(getDiffLineStat([filterDiffWhitespace(spacing, "ignore-amount")])).toEqual({
      additions: 0,
      deletions: 0,
    });
    expect(getDiffLineStat([filterDiffWhitespace(spacing, "ignore-eol")])).toEqual({
      additions: 1,
      deletions: 1,
    });
    const removal = file("a + b\n", "a+b\n");
    expect(filterDiffWhitespace(removal, "ignore-all").hunks).toHaveLength(0);
    expect(filterDiffWhitespace(removal, "ignore-amount").hunks).toHaveLength(1);
    expect(filterDiffWhitespace(file("x\n", "x \t\n"), "ignore-eol").hunks).toHaveLength(0);
  });

  it("compares across old hunk boundaries using full revisions and rejects changed revisions", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
    const after = before.replace("line 1\n", " line 1\n").replace("line 28\n", "new line 28\n");
    const original = parsePatchFiles(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n line 0\n-line 1\n+ line 1\n line 2\n@@ -28,3 +28,3 @@\n line 27\n-line 28\n+new line 28\n line 29\n",
    )[0]!.files[0]!;
    const contents = {
      oldFile: { name: "a.ts", contents: before },
      newFile: { name: "a.ts", contents: after },
    };
    const filtered = filterDiffWhitespace(original, "ignore-all", contents);
    expect(getDiffLineStat([filtered])).toEqual({ additions: 1, deletions: 1 });
    expect(filtered.hunks).toHaveLength(1);
    expect(resolveDiffReviewPosition(filtered, 29, "additions")).toEqual({
      kind: "added",
      newLine: 29,
    });
    expect(() => filterDiffWhitespace(original, "ignore-all")).toThrow("Full file contents");
    expect(() =>
      filterDiffWhitespace(original, "ignore-all", {
        ...contents,
        newFile: { name: "a.ts", contents: `another line\n${after}` },
      }),
    ).toThrow("file changed");
  });

  it("preserves real edits, blank-line insertions, and missing final newlines", () => {
    expect(
      getDiffLineStat([filterDiffWhitespace(file("  old();\n", "    new();\n"), "ignore-all")]),
    ).toEqual({ additions: 1, deletions: 1 });
    expect(
      getDiffLineStat([filterDiffWhitespace(file("x\ny\n", "x\n\ny\n"), "ignore-all")]),
    ).toEqual({ additions: 1, deletions: 0 });
    expect(filterDiffWhitespace(file("x", "x\n"), "ignore-all").hunks).toHaveLength(1);
  });
});
