import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import type { TurnId } from "@t3tools/contracts";
import type { TimelineEntry } from "../session-logic";
import type { MessagesTimelineRow } from "../components/chat/MessagesTimeline.logic";
import type { CitationHistoryPage } from "../components/chat/useAssistantCitationTarget";
import { focusVimNormal, useVimAction, vimEnabled } from "./runtime";
import { nextMatchIndex, searchConversation } from "./search";

export function VimTimeline({
  entries,
  rows,
  listRef,
  loadEarlier,
  expandTurn,
  onManualNavigation,
  onBottom,
  historyError,
}: {
  entries: readonly TimelineEntry[];
  rows: readonly MessagesTimelineRow[];
  listRef: RefObject<LegendListRef | null>;
  loadEarlier: CitationHistoryPage | null;
  expandTurn: (turnId: TurnId) => void;
  onManualNavigation: () => void;
  onBottom: () => void;
  historyError: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [searchingHistory, setSearchingHistory] = useState(false);

  const [selected, setSelected] = useState<{ messageId: string; offset: number } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [goToTop, setGoToTop] = useState(false);
  const requestedPages = useRef(new Set<string>());
  const input = useRef<HTMLInputElement>(null);
  const messages = useMemo(
    () => entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    [entries],
  );
  const matches = useMemo(() => searchConversation(messages, query), [messages, query]);
  const selectedIndex = matches.findIndex(
    (match) => match.messageId === selected?.messageId && match.offset === selected.offset,
  );
  const match = matches[selectedIndex];

  useEffect(() => {
    if ((!searchingHistory && !goToTop) || historyError || !vimEnabled()) return;
    if (!loadEarlier) {
      setSearchingHistory(false);
      setGoToTop(false);
      if (goToTop) void listRef.current?.scrollToOffset({ offset: 0, animated: false });
      return;
    }
    if (loadEarlier.loading) return;
    const cursor = loadEarlier.cursor ?? entries[0]?.id ?? "first";
    if (requestedPages.current.has(cursor)) return;
    requestedPages.current.add(cursor);
    loadEarlier.onLoadEarlier();
  }, [entries, goToTop, historyError, listRef, loadEarlier, searchingHistory]);

  useEffect(() => {
    if (query && selected === null && matches[0]) {
      const first = matches[0];
      setSelected({ messageId: first.messageId, offset: first.offset });
      setTarget(first.messageId);
    }
  }, [matches, query, selected]);

  useEffect(() => {
    if (!target) return;
    const message = messages.find((item) => item.id === target);
    const index = rows.findIndex((row) => row.kind === "message" && row.message.id === target);
    if (index < 0) {
      if (message?.turnId) expandTurn(message.turnId);
      return;
    }
    onManualNavigation();
    void listRef.current?.scrollToIndex({ index, animated: false, viewOffset: 24 });
    setTarget(null);
  }, [expandTurn, listRef, messages, onManualNavigation, rows, target]);

  function choose(index: number) {
    const next = matches[index];
    if (!next) return;
    setSelected({ messageId: next.messageId, offset: next.offset });
    setTarget(next.messageId);
  }
  useVimAction(({ command, scope, count }) => {
    if (scope !== "chat") return;
    if (command !== "move.top") setGoToTop(false);
    if (command === "search.open") {
      setOpen(true);
      queueMicrotask(() => input.current?.focus());
      return true;
    }
    if (command === "search.next" || command === "search.previous") {
      choose(
        nextMatchIndex(
          selectedIndex < 0 ? (command === "search.next" ? -1 : 0) : selectedIndex,
          matches.length,
          command === "search.next" ? count : -count,
        ),
      );
      return true;
    }
    if (command === "message.next" || command === "message.previous") {
      const state = listRef.current?.getState();
      const scroll = state?.scroll ?? 0;
      const positions = rows.flatMap((row, index) =>
        row.kind === "message"
          ? [{ index, id: row.message.id, top: state?.positionAtIndex(index) ?? 0 }]
          : [],
      );
      const direction = command === "message.next" ? 1 : -1;
      const anchor = positions.filter((item) => item.top <= scroll + 25).at(-1) ?? positions[0];
      const current = messages.findIndex((message) => message.id === anchor?.id);
      const next = current + count * direction;
      if (next < 0 && loadEarlier && !loadEarlier.loading) loadEarlier.onLoadEarlier();
      else {
        const message = messages[Math.max(0, Math.min(messages.length - 1, next))];
        if (message) setTarget(message.id);
      }
      return true;
    }
    if (!command.startsWith("move.")) return;
    if (command === "move.bottom") {
      onBottom();
      return true;
    }
    onManualNavigation();
    const state = listRef.current?.getState();
    if (command === "move.top") {
      requestedPages.current.clear();
      setGoToTop(true);
      void listRef.current?.scrollToOffset({ offset: 0, animated: false });
      return true;
    }
    const distance =
      command === "move.halfDown" || command === "move.halfUp"
        ? (state?.scrollLength ?? 600) / 2
        : 40;
    const direction = command === "move.up" || command === "move.halfUp" ? -1 : 1;
    void listRef.current?.scrollToOffset({
      offset: Math.max(0, (state?.scroll ?? 0) + distance * count * direction),
      animated: false,
    });
    return true;
  });

  if (!vimEnabled() || (!open && !query && !goToTop)) return null;
  return (
    <div
      className="absolute top-2 right-3 left-3 z-30 rounded border bg-popover p-2 text-xs shadow"
      data-vim-search
    >
      {open && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(draft);
            setSelected(null);
            requestedPages.current.clear();

            setSearchingHistory(Boolean(draft));
            setOpen(false);
            focusVimNormal();
          }}
        >
          <input
            ref={input}
            autoFocus
            aria-label="Search conversation"
            placeholder="Search conversation; Enter to search, Esc to cancel"
            className="w-full bg-transparent p-1 outline-none"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                focusVimNormal();
              }
            }}
          />
        </form>
      )}
      {!open && (
        <div className="flex items-center justify-between gap-2">
          <span role="status">
            {goToTop
              ? "Loading the start of the conversation…"
              : `${query}: ${selectedIndex + 1}/${matches.length} matches${searchingHistory && loadEarlier && !historyError ? " · searching earlier messages…" : ""}${historyError ? " · history unavailable; results are incomplete" : ""}`}
          </span>
          <button
            aria-label="Close conversation search"
            onClick={() => {
              setQuery("");
              setSearchingHistory(false);
              setGoToTop(false);
              focusVimNormal();
            }}
          >
            Close
          </button>
        </div>
      )}
      {match && (
        <p className="mt-1 truncate">
          {match.text.slice(Math.max(0, match.offset - 45), match.offset)}
          <mark>{match.text.slice(match.offset, match.offset + query.length)}</mark>
          {match.text.slice(match.offset + query.length, match.offset + query.length + 80)}
        </p>
      )}
    </div>
  );
}
