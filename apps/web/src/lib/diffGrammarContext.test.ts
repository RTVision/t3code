import { getSharedHighlighter, renderDiffWithHighlighter } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { detectHunkStart } from "./diffGrammarContext";
import { getRenderablePatch } from "./diffRendering";

const lines = (text: string) => text.split("\n");

describe("detectHunkStart", () => {
  it.each([
    [
      "attributes of a tag opened above the hunk",
      "vue",
      `          :request-data="rows"\n          disable-grid-view\n          :no-inline-delete="readonly"\n        />\n        <div class="a">{{ n }}</div>`,
      "tag",
    ],
    ["template markup", "vue", `    <div class="a">\n      {{ count }}\n    </div>`, "markup"],
    [
      "setup script",
      "vue",
      `const count = ref(0)\nfunction toggle() {\n  count.value++\n}`,
      "script",
    ],
    [
      "options API object keys",
      "vue",
      `  computed: {\n    total() {\n      return 1\n    },`,
      "script",
    ],
    ["styles", "vue", `.a:hover {\n  color: $primary;\n}\n@media (min-width: 1px) {`, "style"],
    ["the end of a style block", "vue", `  }\n}\n</style>`, "style"],
    ["the end of a script block", "svelte", `  }\n</script>\n\n<main>`, "script"],
    ["astro frontmatter", "astro", `const posts = await getPosts()\n---\n<ul>`, "frontmatter"],
    [
      "astro frontmatter without a fence",
      "astro",
      `const posts = await getPosts()\nconst count = posts.length`,
      "frontmatter",
    ],
    [
      "an astro script tag body",
      "astro",
      `  const el = document.querySelector("a")\n</script>\n<style>`,
      "script",
    ],
    [
      "an indented astro script tag body",
      "astro",
      `    const a = 1\n    track(a)\n    send(a)\n  </script>\n  <p>Hello</p>`,
      "script",
    ],
    [
      "attributes whose handlers look like script",
      "svelte",
      `  on:click={() => {\n    count += 1\n    total = count * 2\n    save(total)\n  }}\n>\n</button>`,
      "tag",
    ],
    [
      "markup whose handlers look like script",
      "svelte",
      `<button on:click={() => {\n  count += 1\n  total = count * 2\n  save(total)\n}}>\n</button>`,
      "markup",
    ],
  ] as const)("detects %s", (_label, language, text, expected) => {
    expect(detectHunkStart(lines(text), language)).toBe(expected);
  });

  it("returns null for hunks that start between blocks", () => {
    expect(detectHunkStart(lines(`\n<script setup lang="ts">\nconst a = 1`), "vue")).toBeNull();
  });

  it("returns null without any recognizable lines", () => {
    expect(detectHunkStart(lines(`  Save changes\n  }`), "vue")).toBeNull();
  });
});

describe("getRenderablePatch grammar context", () => {
  const patch = [
    "diff --git a/src/Invoice.vue b/src/Invoice.vue",
    "--- a/src/Invoice.vue",
    "+++ b/src/Invoice.vue",
    "@@ -282,5 +282,5 @@",
    '           :request-data="invoiceRowsRequestData"',
    '           :filterable="false"',
    "-          :edit-link=\"readonly ? 'override' : undefined\"",
    '+          edit-link="override"',
    "           disable-grid-view",
    '           :no-inline-delete="readonly"',
  ].join("\n");

  it("highlights template attributes in a hunk that starts mid-tag", async () => {
    const renderable = getRenderablePatch(patch, "grammar-context-test");
    if (renderable?.kind !== "files") throw new Error("expected parsed files");
    const [file] = renderable.files;
    if (!file) throw new Error("expected one file");
    expect(file.hunks[0]?.grammarContext).toEqual({ lang: "vue", code: "<template>\n<x\n" });

    const highlighter = await getSharedHighlighter({
      themes: ["pierre-dark"],
      langs: ["vue"],
      preferredHighlighter: "shiki-wasm",
    });
    const render = (diff: typeof file) =>
      renderDiffWithHighlighter(diff, highlighter, {
        theme: "pierre-dark",
        lineDiffType: "none",
        maxLineDiffLength: 1_000,
        tokenizeMaxLineLength: 1_000,
      } as Parameters<typeof renderDiffWithHighlighter>[2]);
    const tokenColors = (result: ReturnType<typeof render>) =>
      new Set(JSON.stringify(result.code.additionLines[0]).match(/color:#\w+/g) ?? []).size;

    const unseededFile = structuredClone(file);
    for (const hunk of unseededFile.hunks) delete hunk.grammarContext;

    const seeded = tokenColors(render(file));
    const unseeded = tokenColors(render(unseededFile));
    expect(unseeded).toBeLessThanOrEqual(1);
    expect(seeded).toBeGreaterThan(1);
  });
});
