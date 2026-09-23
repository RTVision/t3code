import { getFiletypeFromFileName, type FileDiffMetadata, type Hunk } from "@pierre/diffs";

type HunkStart = "script" | "frontmatter" | "style" | "tag" | "markup";
type HunkBlock = "script" | "style" | "template";

/**
 * Code that puts each single-file-component grammar into the block a hunk
 * starts in. Patch-only diffs tokenize every hunk from the top of the file, so
 * without a seed Vue treats template attributes and script/style bodies as
 * plain text. Missing entries mean the grammar's top-level state is correct.
 */
const GRAMMAR_SEEDS: Partial<Record<string, Partial<Record<HunkStart, string>>>> = {
  vue: {
    script: '<script lang="ts">\n',
    style: '<style lang="scss">\n',
    tag: "<template>\n<x\n",
    markup: "<template>\n",
  },
  svelte: {
    script: '<script lang="ts">\n',
    style: '<style lang="scss">\n',
    tag: "<x\n",
  },
  astro: {
    script: "<script>\n",
    frontmatter: "---\n",
    style: '<style lang="scss">\n',
    tag: "<x\n",
  },
};

// `<template>` blocks are only recognized at column 0, which keeps nested
// `<template v-if>` tags from reading as the end of the SFC template. Script
// and style tags never nest, and Astro allows them anywhere in the markup.
const BLOCK_TAG = /^(?:<(\/?)(template)\b|\s*<(\/?)(script|style)\b)/;
const ASTRO_FENCE = /^---\s*$/;
const MARKUP = /^(?:<\/?[A-Za-z]|\{\{|\{[#:/@])/;
// Directives must end in `=` or the tag so `#app {` and `@media … {` stay CSS.
const ATTRIBUTE =
  /^(?:(?:[:@#]|v-)[\w.:[\]-]+(?:=|\s*\/?>?$)|[A-Za-z_][\w.:-]*=["'{]|[a-z]\w*(?:-\w+)+\s*\/?>?$|\/?>$)/;
const SCRIPT =
  /^(?:import|export|const|let|var|function|async|await|return|if|else|for|while|switch|case|try|catch|throw|interface|type|enum|class|define\w+|withDefaults)\b|=>/;
const STYLE_AT_RULE =
  /^(?:@(?:media|include|mixin|use|import|supports|keyframes|font-face|extend)\b|\$[\w-]+\s*:)/;
const STYLE_DECLARATION = /^-{0,2}[a-z][a-z-]*\s*:\s*[^'"`=;{}]+;$/;
const STYLE_SELECTOR = /^[.#&:*[\w][^=;(){}'"]*\{$/;
const WEAK_SCRIPT = /\w\(|\s=\s|\+\+|\.value\b/;

function classifyLine(line: string): "tag" | "markup" | "script" | "style" | null {
  if (line.length === 0) return null;
  if (MARKUP.test(line)) return "markup";
  if (ATTRIBUTE.test(line)) return "tag";
  if (SCRIPT.test(line)) return "script";
  if (
    STYLE_AT_RULE.test(line) ||
    STYLE_DECLARATION.test(line) ||
    // `key: {` is an object literal; selectors like `a:hover {` have no space after the colon.
    (STYLE_SELECTOR.test(line) && !/:\s/.test(line))
  ) {
    return "style";
  }
  return WEAK_SCRIPT.test(line) ? "script" : null;
}

function* hunkLines(file: FileDiffMetadata, hunk: Hunk): Generator<string> {
  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      for (let index = 0; index < content.lines; index += 1) {
        yield file.additionLines[content.additionLineIndex + index] ?? "";
      }
      continue;
    }
    for (let index = 0; index < content.deletions; index += 1) {
      yield file.deletionLines[content.deletionLineIndex + index] ?? "";
    }
    for (let index = 0; index < content.additions; index += 1) {
      yield file.additionLines[content.additionLineIndex + index] ?? "";
    }
  }
}

/** Guesses which SFC block a hunk starts in, or null when the top-level state already fits. */
export function detectHunkStart(lines: Iterable<string>, language: string): HunkStart | null {
  const votes: Record<HunkBlock, number> = { script: 0, style: 0, template: 0 };
  const firstSeen: HunkBlock[] = [];
  let templateStart: "tag" | "markup" | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const blockTag = BLOCK_TAG.exec(line);
    if (blockTag) {
      const [, closesTemplate, template, closesBlock, block] = blockTag;
      // An opening block tag means the hunk started between blocks.
      if (template ? !closesTemplate : !closesBlock) break;
      if (template) return templateStart ?? "markup";
      return block === "script" ? "script" : "style";
    }
    // Callers skip hunks that start on line 1, so a fence here closes the frontmatter.
    if (language === "astro" && ASTRO_FENCE.test(line)) return "frontmatter";

    const kind = classifyLine(line.trim());
    if (kind === null) continue;
    // A hunk that leads with markup or attributes starts in the template;
    // script-like lines after it are event handlers or expressions.
    if ((kind === "markup" || kind === "tag") && firstSeen.length === 0) return kind;
    const block = kind === "tag" || kind === "markup" ? "template" : kind;
    if (block === "template") templateStart ??= kind === "tag" ? "tag" : "markup";
    if (votes[block] === 0) firstSeen.push(block);
    votes[block] += 1;
  }

  let winner: HunkBlock | undefined;
  for (const block of firstSeen) {
    if (winner === undefined || votes[block] > votes[winner]) winner = block;
  }
  if (winner === "template") return templateStart ?? "markup";
  // Astro code without a `</script>` in view is most often frontmatter.
  if (winner === "script" && language === "astro") return "frontmatter";
  return winner ?? null;
}

/**
 * Attaches a grammar seed to each hunk of a patch-only Vue, Svelte, or Astro
 * diff. The seed is read by our `@pierre/diffs` patch and passed to Shiki as
 * `grammarContextCode`.
 */
export function withHunkGrammarContext(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) return file;
  const language = getFiletypeFromFileName(file.name);
  const seeds = GRAMMAR_SEEDS[language];
  if (!seeds) return file;

  let changed = false;
  const hunks = file.hunks.map((hunk) => {
    if (hunk.additionStart <= 1 && hunk.deletionStart <= 1) return hunk;
    const start = detectHunkStart(hunkLines(file, hunk), language);
    const code = start ? seeds[start] : undefined;
    if (!code) return hunk;
    changed = true;
    return { ...hunk, grammarContext: { lang: language, code } };
  });
  return changed ? { ...file, hunks } : file;
}
