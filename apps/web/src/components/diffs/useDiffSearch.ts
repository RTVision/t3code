import type { CodeViewScrollTarget, PostRenderPhase } from "@pierre/diffs";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  findOccurrences,
  searchDiffFiles,
  type DiffSearchFile,
  type DiffSearchMatch,
  type DiffSearchSide,
} from "~/lib/diffSearch";
import { focusVimNormal, vimEnabled, vimPane } from "~/vim/runtime";
import { nextMatchIndex } from "~/vim/search";

// Named in the viewer stylesheet (StyledDiffCodeView), which styles `::highlight()` inside
// each file's shadow root. The registry is global, so every search owns only its own ranges.
const MATCH_HIGHLIGHT = "t3-diff-search";
const CURRENT_HIGHLIGHT = "t3-diff-search-current";
// Per rendered file. Minified lines can hold thousands of hits; painting them all on every
// render would stall scrolling, and nobody reads past the first screenful anyway.
const MAX_PAINTED_RANGES = 500;

function highlightRegistry(): { match: Highlight; current: Highlight } | null {
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) {
    return null;
  }
  const get = (name: string) => {
    const existing = CSS.highlights.get(name);
    if (existing) return existing;
    const created = new Highlight();
    CSS.highlights.set(name, created);
    return created;
  };
  return { match: get(MATCH_HIGHLIGHT), current: get(CURRENT_HIGHLIGHT) };
}

function renderedLineSide(line: HTMLElement): DiffSearchSide {
  const type = line.dataset.lineType;
  if (type === "change-deletion") return "deletions";
  if (type === "change-addition") return "additions";
  return line.closest("[data-deletions]") ? "deletions" : "additions";
}

/**
 * Ranges over a rendered line's token text nodes for its first `limit` occurrences of the query,
 * plus occurrence `extra` wherever it falls. Keyed by occurrence index.
 */
function occurrenceRanges(
  line: HTMLElement,
  query: string,
  limit: number,
  extra = -1,
): Map<number, Range> {
  const ranges = new Map<number, Range>();
  const spans = findOccurrences(line.textContent ?? "", query, Math.max(limit, extra + 1));
  if (spans.length === 0) return ranges;
  const nodes: Text[] = [];
  const starts: number[] = [];
  const walker = line.ownerDocument.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let position = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(position);
    position += node.nodeValue?.length ?? 0;
  }
  const locate = (offset: number): [Text, number] => {
    let index = starts.length - 1;
    while (index > 0 && starts[index]! > offset) index--;
    return [nodes[index]!, offset - starts[index]!];
  };
  spans.forEach(([start, end], occurrence) => {
    if (occurrence >= limit && occurrence !== extra) return;
    const range = line.ownerDocument.createRange();
    range.setStart(...locate(start));
    range.setEnd(...locate(end));
    ranges.set(occurrence, range);
  });
  return ranges;
}

interface DiffSearchViewer {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

export interface DiffSearchInput extends DiffSearchFile {
  collapsed: boolean;
}

/**
 * Find-in-diff for a virtualized CodeView. Matches come from the diff data, so lines that are
 * not rendered are still found; highlights are painted onto whatever the viewer has rendered,
 * through its `onPostRender` callback, which must be passed into the viewer options.
 */
export function useDiffSearch({
  files,
  viewer,
  expand,
  incomplete,
}: {
  files: readonly DiffSearchInput[];
  viewer: DiffSearchViewer | null;
  /** Unfold a collapsed file so its match can be scrolled to. */
  expand: (fileKey: string) => void;
  /** Some files are not loaded yet, so they were not searched. */
  incomplete: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const { matches, truncated } = useMemo(
    () => searchDiffFiles(files, deferredQuery),
    [files, deferredQuery],
  );
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  // Typing jumps to the first match, the way browser find does. Any edit starts over there,
  // even one that returns to an earlier query.
  const searchedQuery = useRef<string | null>("");
  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    setCursor({ query: "", index: 0 });
    searchedQuery.current = null;
  }, []);
  const activeIndex =
    matches.length === 0
      ? -1
      : Math.min(cursor.query === deferredQuery ? cursor.index : 0, matches.length - 1);
  const current = matches[activeIndex] ?? null;

  // The match to scroll to once its file is unfolded and the viewer is mounted.
  const pendingTarget = useRef<DiffSearchMatch | null>(null);
  const scrollToPending = useCallback(() => {
    const target = pendingTarget.current;
    if (!target || !viewer?.getInstance()) return;
    if (files.find((file) => file.fileKey === target.fileKey)?.collapsed !== false) return;
    pendingTarget.current = null;
    viewer.scrollTo({
      type: "line",
      id: target.fileKey,
      lineNumber: target.lineNumber,
      side: target.side,
      align: "center",
    });
  }, [files, viewer]);
  // Retries once an unfold lands or the viewer mounts.
  useEffect(scrollToPending, [scrollToPending]);

  const goTo = useCallback(
    (match: DiffSearchMatch) => {
      pendingTarget.current = match;
      if (files.find((file) => file.fileKey === match.fileKey)?.collapsed) expand(match.fileKey);
      else scrollToPending();
    },
    [expand, files, scrollToPending],
  );

  useEffect(() => {
    // Only an edit jumps; stepping records its own query on the cursor.
    if (cursor.query !== "" || searchedQuery.current === deferredQuery) return;
    searchedQuery.current = deferredQuery;
    const first = matches[0];
    if (open && first) goTo(first);
  }, [cursor.query, deferredQuery, goTo, matches, open]);

  const step = useCallback(
    (delta: number) => {
      setOpen(true);
      if (matches.length === 0) return;
      const index = nextMatchIndex(
        activeIndex < 0 ? (delta > 0 ? -1 : 0) : activeIndex,
        matches.length,
        delta,
      );
      setCursor({ query: deferredQuery, index });
      const match = matches[index];
      if (match) goTo(match);
    },
    [activeIndex, deferredQuery, goTo, matches],
  );

  const returnFocus = useRef<Element | null>(null);
  const openSearch = useCallback(() => {
    const active = document.activeElement;
    if (!active?.closest("[data-diff-search]")) returnFocus.current = active;
    setOpen(true);
    setFocusRequest((request) => request + 1);
  }, []);
  /**
   * Leave the input. Vim returns to Normal mode in the pane the search started from. The target
   * is kept while search stays open, so confirming again after clicking back in still works.
   */
  const blur = useCallback(() => {
    const element = returnFocus.current;
    const pane = vimEnabled() ? (vimPane(element) ?? vimPane(document.activeElement)) : null;
    if (pane) {
      focusVimNormal(pane);
      return;
    }
    // The starting control may have been virtualized away while searching; the surface root
    // keeps focus inside the diff so the next Mod+F still lands here.
    const target =
      element instanceof HTMLElement && element.isConnected
        ? element
        : document.activeElement?.closest<HTMLElement>("[data-diff-search-root]");
    target?.focus({ preventScroll: true });
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    blur();
    returnFocus.current = null;
  }, [blur]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.defaultPrevented || files.length === 0) return;
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey)) return;
      if (event.altKey || event.shiftKey) return;
      // Other fields in the surface, such as the base-ref picker or a review comment, keep it.
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        !target.closest("[data-diff-search]") &&
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable)
      )
        return;
      // Claimed only inside the diff: the viewer virtualizes its lines, so browser find would
      // miss most of them, and the desktop shell has no find-in-page at all.
      event.preventDefault();
      openSearch();
    },
    [files.length, openSearch],
  );

  // container -> the file it currently renders; the viewer pools and reuses containers.
  const mounted = useRef(new Map<HTMLElement, string>());
  const painted = useRef(new Map<HTMLElement, Range[]>());
  // Read by `onPostRender`, which the viewer calls outside React's render.
  const paintInput = useRef({ query: "", current: null as DiffSearchMatch | null });

  const clear = useCallback((container: HTMLElement) => {
    const ranges = painted.current.get(container);
    if (!ranges) return;
    painted.current.delete(container);
    const registry = highlightRegistry();
    for (const range of ranges) {
      registry?.match.delete(range);
      registry?.current.delete(range);
    }
  }, []);

  const paint = useCallback(
    (container: HTMLElement, fileKey: string) => {
      clear(container);
      const { query: paintQuery, current: paintCurrent } = paintInput.current;
      const registry = highlightRegistry();
      const root = container.shadowRoot;
      if (!paintQuery || !registry || !root) return;
      const ranges: Range[] = [];
      for (const line of root.querySelectorAll<HTMLElement>("[data-line]")) {
        const currentLine =
          paintCurrent?.fileKey === fileKey &&
          Number(line.dataset.line) === paintCurrent.lineNumber &&
          renderedLineSide(line) === paintCurrent.side;
        // The current match is painted even once the budget is spent; nothing else is.
        const budget = Math.max(0, MAX_PAINTED_RANGES - ranges.length);
        const currentOccurrence = currentLine ? paintCurrent.occurrence : -1;
        if (budget === 0 && currentOccurrence < 0) continue;
        for (const [occurrence, range] of occurrenceRanges(
          line,
          paintQuery,
          budget,
          currentOccurrence,
        )) {
          (occurrence === currentOccurrence ? registry.current : registry.match).add(range);
          ranges.push(range);
        }
      }
      painted.current.set(container, ranges);
    },
    [clear],
  );

  const onPostRender = useCallback(
    (
      node: HTMLElement,
      _instance: unknown,
      phase: PostRenderPhase,
      context?: { item: { id: string } },
    ) => {
      if (phase === "unmount" || !context) {
        clear(node);
        mounted.current.delete(node);
        return;
      }
      mounted.current.set(node, context.item.id);
      paint(node, context.item.id);
    },
    [clear, paint],
  );

  const paintedQuery = open ? deferredQuery : "";
  useLayoutEffect(() => {
    paintInput.current = { query: paintedQuery, current };
    for (const [container, fileKey] of mounted.current) {
      if (container.isConnected) paint(container, fileKey);
      else {
        clear(container);
        mounted.current.delete(container);
      }
    }
  }, [clear, current, paint, paintedQuery]);

  useEffect(
    () => () => {
      for (const container of painted.current.keys()) clear(container);
    },
    [clear],
  );

  return {
    open,
    query,
    setQuery,
    focusRequest,
    activeIndex,
    matchCount: matches.length,
    truncated,
    incomplete,
    openSearch,
    close,
    blur,
    next: useCallback(() => step(1), [step]),
    previous: useCallback(() => step(-1), [step]),
    step,
    onKeyDown,
    onPostRender,
  };
}

export type DiffSearch = ReturnType<typeof useDiffSearch>;
