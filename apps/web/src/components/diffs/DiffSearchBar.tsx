import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { vimEnabled, vimScope } from "~/vim/runtime";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DiffSearch } from "./useDiffSearch";

/** Toolbar control that opens and closes the diff search. */
export function DiffSearchToggle({ search }: { search: DiffSearch }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={search.open ? "Close diff search" : "Search diff"}
            variant="ghost"
            size="sm"
            pressed={search.open}
            onPressedChange={(pressed) => (pressed ? search.openSearch() : search.close())}
          />
        }
      >
        <SearchIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{search.open ? "Close search" : "Search diff"}</TooltipPopup>
    </Tooltip>
  );
}

export function DiffSearchBar({ search }: { search: DiffSearch }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (search.focusRequest === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [search.focusRequest]);

  if (!search.open) return null;
  const status =
    search.query.length === 0
      ? ""
      : search.matchCount === 0
        ? "No results"
        : `${search.activeIndex + 1}/${search.matchCount}${search.truncated ? "+" : ""}`;
  return (
    // `data-vim-search` hands keys to the input instead of Vim's Normal mode.
    <div
      data-diff-search
      data-vim-search
      className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 py-1"
      // Escape from any control in the bar closes the search and nothing else, such as a sheet.
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        search.close();
      }}
    >
      <div className="min-w-0 flex-1">
        <Input
          ref={input}
          nativeInput
          size="compact"
          type="search"
          aria-label="Search diff"
          placeholder="Search diff"
          value={search.query}
          onChange={(event) => search.setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Enter also commits an IME composition; that one belongs to the input. Safari sends
            // it after compositionend, flagged only by keyCode 229.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) search.previous();
              // In a Vim diff pane, Enter confirms and returns to Normal mode, where n and N step.
              else if (vimEnabled() && vimScope(event.currentTarget) === "diff") search.blur();
              else search.next();
            }
          }}
        />
      </div>
      <span
        role="status"
        aria-live="polite"
        className="shrink-0 px-1 text-2xs tabular-nums text-muted-foreground"
      >
        {status}
        {status && search.incomplete ? " · loaded files only" : ""}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        disabled={search.matchCount === 0}
        onClick={search.previous}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        disabled={search.matchCount === 0}
        onClick={search.next}
      >
        <ChevronDownIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Close search"
        onClick={search.close}
      >
        <XIcon />
      </Button>
    </div>
  );
}
