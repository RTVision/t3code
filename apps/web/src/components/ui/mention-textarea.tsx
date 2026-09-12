import {
  createContext,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Textarea, type TextareaProps } from "./textarea";
import {
  insertMention,
  mentionAtCursor,
  mentionCandidates,
  type MentionCandidate,
} from "./mentionText.logic";

export const MentionSuggestionsContext = createContext<{
  candidates: ReadonlyArray<MentionCandidate>;
  onRequest: () => void;
  pending: boolean;
} | null>(null);

/** A plain text field. Selecting a suggestion inserts the host's @login syntax. */
export function MentionTextarea({
  value,
  onValueChange,
  ref,
  onKeyDown,
  onSelect,
  onBlur,
  ...props
}: Omit<TextareaProps, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const source = useContext(MentionSuggestionsContext);
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => input.current!);
  const listId = useId();
  const [range, setRange] = useState<ReturnType<typeof mentionAtCursor>>(null);
  const [active, setActive] = useState(0);
  if (range && value.slice(range.start, range.end) !== `@${range.query}`) {
    setRange(null);
  }
  const matches = source && range ? mentionCandidates(source.candidates, range.query) : [];
  const open = source !== null && range !== null && !props.disabled;
  const selected = Math.min(active, Math.max(0, matches.length - 1));
  const activeLogin = open ? matches[selected]?.login : undefined;
  const activeOption = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeLogin) activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [activeLogin]);

  const updateRange = (element: HTMLTextAreaElement) => {
    const next = mentionAtCursor(element.value, element.selectionStart, element.selectionEnd);
    setRange(next);
    setActive(0);
    if (next) source?.onRequest();
  };
  const choose = (login: string) => {
    if (!range) return;
    const next = insertMention(value, range, login);
    onValueChange(next.value);
    setRange(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  return (
    <div className="min-w-0">
      <Textarea
        {...props}
        ref={input}
        value={value}
        aria-autocomplete={source ? "list" : undefined}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && matches.length ? `${listId}-${selected}` : undefined}
        onChange={(event) => {
          onValueChange(event.target.value);
          updateRange(event.currentTarget);
        }}
        onSelect={(event) => {
          updateRange(event.currentTarget);
          onSelect?.(event);
        }}
        onBlur={(event) => {
          setRange(null);
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (open && !event.nativeEvent.isComposing) {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setRange(null);
              return;
            }
            if (matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setActive(
                (selected + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length,
              );
              return;
            }
            if (
              matches.length &&
              (event.key === "Enter" || event.key === "Tab") &&
              !event.ctrlKey &&
              !event.metaKey &&
              !event.shiftKey
            ) {
              event.preventDefault();
              choose(matches[selected]!.login);
              return;
            }
          }
          onKeyDown?.(event);
        }}
      />
      {open ? (
        <div className="mt-1 rounded-md border border-border bg-popover p-1 text-xs shadow-sm">
          <div
            id={listId}
            role="listbox"
            aria-label="Mention a person"
            className="max-h-40 overflow-y-auto"
          >
            {matches.map((candidate, index) => (
              <div
                id={`${listId}-${index}`}
                key={candidate.login}
                ref={index === selected ? activeOption : undefined}
                role="option"
                aria-selected={index === selected}
                className={`cursor-pointer rounded px-2 py-1.5 ${index === selected ? "bg-accent text-accent-foreground" : ""}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(candidate.login)}
              >
                @{candidate.login}
                {candidate.name ? (
                  <span className="ml-2 text-muted-foreground">{candidate.name}</span>
                ) : null}
              </div>
            ))}
          </div>
          {matches.length === 0 ? (
            <p role="status" className="px-2 py-1 text-muted-foreground">
              {source.pending
                ? "Loading people..."
                : "No suggestions. You can still type a username."}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
