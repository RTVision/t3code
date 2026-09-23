import {
  getSharedHighlighter,
  registerCustomLanguage,
  RegisteredCustomLanguages,
  type DiffsHighlighter,
  type HighlighterTypes,
  type LanguageRegistration,
  type SupportedLanguages,
} from "@pierre/diffs";

import { resolveDiffThemeName } from "./diffRendering";

/**
 * Always highlight with the Oniguruma WASM engine — the JS regex engine can
 * backtrack catastrophically and hang the tokenizing thread. The shared
 * highlighter is a first-caller-wins singleton, so every creation site must
 * pass this value.
 */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

type LanguageModule = Promise<{ default: LanguageRegistration[] }>;

/**
 * SFC grammars only highlight `<style lang="scss">` and `lang="less"` blocks
 * when those grammars are already loaded, so load them with the SFC grammar.
 * Diff hunk seeds in `diffGrammarContext.ts` also rely on SCSS being present.
 */
function withStyleLanguages(load: () => LanguageModule) {
  return async () => {
    const [scss, less, language] = await Promise.all([
      import("@shikijs/langs/scss"),
      import("@shikijs/langs/less"),
      load(),
    ]);
    return { default: [...scss.default, ...less.default, ...language.default] };
  };
}

const SFC_LANGUAGE_LOADERS = {
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  astro: () => import("@shikijs/langs/astro"),
} satisfies Record<string, () => LanguageModule>;

for (const [language, load] of Object.entries(SFC_LANGUAGE_LOADERS)) {
  // Pierre's registry outlives this module across HMR reloads.
  if (!RegisteredCustomLanguages.has(language)) {
    registerCustomLanguage(language, withStyleLanguages(load));
  }
}

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

export function getSyntaxHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
  }).catch((error) => {
    if (language === "text") {
      highlighterPromiseCache.delete(language);
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw error;
    }
    // Language not supported by Shiki — fall back to "text"
    return getSyntaxHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}
