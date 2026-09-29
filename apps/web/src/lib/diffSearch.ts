import type { FileDiffMetadata } from "@pierre/diffs";

export type DiffSearchSide = "additions" | "deletions";

export interface DiffSearchFile {
  fileKey: string;
  filePath: string;
  fileDiff: FileDiffMetadata;
}

export interface DiffSearchMatch {
  fileKey: string;
  filePath: string;
  side: DiffSearchSide;
  lineNumber: number;
  /** Which occurrence on its line, so the viewer can find it again in rendered text. */
  occurrence: number;
}

export interface DiffSearchResult {
  matches: DiffSearchMatch[];
  /** The match cap was reached; more exist than are listed. */
  truncated: boolean;
}

const DIFF_SEARCH_MATCH_LIMIT = 5000;
const EMPTY_RESULT: DiffSearchResult = { matches: [], truncated: false };

let cachedPattern: { query: string; pattern: RegExp | null } | null = null;
/** Null once the engine has rejected the pattern, e.g. a pasted query past V8's size limit. */
function queryPattern(query: string): RegExp | null {
  if (cachedPattern?.query !== query) {
    const caseSensitive = query !== query.toLowerCase();
    const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let pattern: RegExp | null = null;
    try {
      pattern = new RegExp(literal, caseSensitive ? "gu" : "giu");
    } catch {}
    cachedPattern = { query, pattern };
  }
  return cachedPattern.pattern;
}

/**
 * Literal, case-insensitive unless the query has a capital letter (Vim's smartcase). Spans are
 * `[start, end)` in `text` itself: case folding can change a string's length, so a match's
 * length is not always the query's.
 */
export function findOccurrences(
  text: string,
  query: string,
  limit = Infinity,
): Array<[start: number, end: number]> {
  if (!query || limit <= 0) return [];
  const pattern = queryPattern(query);
  if (pattern) {
    try {
      const spans: Array<[number, number]> = [];
      pattern.lastIndex = 0;
      for (
        let match = pattern.exec(text);
        match && spans.length < limit;
        match = pattern.exec(text)
      ) {
        spans.push([match.index, match.index + match[0].length]);
      }
      return spans;
    } catch {
      // V8 compiles lazily, per one- or two-byte subject, and can throw "too large" on any
      // text. Stop using the pattern for this query.
      cachedPattern = { query, pattern: null };
    }
  }
  // Exact text only; still spans in `text` itself.
  const spans: Array<[number, number]> = [];
  for (let at = text.indexOf(query); at !== -1 && spans.length < limit;) {
    spans.push([at, at + query.length]);
    at = text.indexOf(query, at + query.length);
  }
  return spans;
}

/**
 * Searches the lines a diff shows, in reading order. Unchanged lines between hunks are not
 * part of the patch, so they are never searched. Context lines count once, on the new side,
 * which is where the unified view draws them.
 */
export function searchDiffFiles(
  files: readonly DiffSearchFile[],
  query: string,
  limit = DIFF_SEARCH_MATCH_LIMIT,
): DiffSearchResult {
  if (!query) return EMPTY_RESULT;
  const matches: DiffSearchMatch[] = [];
  const push = (file: DiffSearchFile, side: DiffSearchSide, lineNumber: number, text: string) => {
    // One past the remaining room, so a full result can tell it was cut short.
    const occurrences = findOccurrences(text, query, limit - matches.length + 1);
    for (let occurrence = 0; occurrence < occurrences.length; occurrence++) {
      if (matches.length >= limit) return false;
      matches.push({
        fileKey: file.fileKey,
        filePath: file.filePath,
        side,
        lineNumber,
        occurrence,
      });
    }
    return true;
  };
  for (const file of files) {
    const { additionLines, deletionLines, hunks } = file.fileDiff;
    for (const hunk of hunks) {
      const additionNumber = (index: number) => hunk.additionStart + index - hunk.additionLineIndex;
      const deletionNumber = (index: number) => hunk.deletionStart + index - hunk.deletionLineIndex;
      for (const content of hunk.hunkContent) {
        if (content.type === "context") {
          for (let i = 0; i < content.lines; i++) {
            const index = content.additionLineIndex + i;
            if (!push(file, "additions", additionNumber(index), additionLines[index] ?? ""))
              return { matches, truncated: true };
          }
          continue;
        }
        for (let i = 0; i < content.deletions; i++) {
          const index = content.deletionLineIndex + i;
          if (!push(file, "deletions", deletionNumber(index), deletionLines[index] ?? ""))
            return { matches, truncated: true };
        }
        for (let i = 0; i < content.additions; i++) {
          const index = content.additionLineIndex + i;
          if (!push(file, "additions", additionNumber(index), additionLines[index] ?? ""))
            return { matches, truncated: true };
        }
      }
    }
  }
  return { matches, truncated: false };
}
