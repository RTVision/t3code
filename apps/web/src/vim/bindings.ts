import type { VimSettings } from "@t3tools/contracts/settings";

export type VimMode = "normal" | "insert" | "terminal";
export type VimScope = "chat" | "terminal" | "sidebar" | "diff" | "other";

export const VIM_COMMANDS = [
  ["input.enter", "Enter input", ["i"], ["normal"]],
  [
    "mode.normal",
    "Return to navigation / cancel sequence",
    ["escape", "ctrl+c"],
    ["normal", "insert"],
  ],
  ["terminal.escape", "Leave terminal input", ["ctrl+\\ ctrl+n"], ["terminal"]],
  ["terminal.toggle", "Show / hide terminal", ["ctrl+."], ["normal", "insert", "terminal"]],
  ["terminal.new", "New terminal", ["space t n"], ["normal"]],
  ["terminal.split", "Split terminal vertically", ["space w v"], ["normal"]],
  ["terminal.splitVertical", "Split terminal horizontally", ["space w s"], ["normal"]],
  ["pane.close", "Close terminal or panel", ["space w c"], ["normal"]],
  ["pane.left", "Focus pane to the left", ["space w h"], ["normal"]],
  ["pane.down", "Focus pane below", ["space w j"], ["normal"]],
  ["pane.up", "Focus pane above", ["space w k"], ["normal"]],
  ["pane.right", "Focus pane to the right", ["space w l"], ["normal"]],
  ["filePicker.toggle", "Find files", ["space p f"], ["normal"]],
  ["projectSearch.toggle", "Search project files", ["space p g"], ["normal"]],
  ["threadPicker.open", "Find project or thread", ["space p t"], ["normal"]],
  ["chat.new", "New thread", ["space p n"], ["normal"]],
  ["thread.previous", "Previous thread", ["space h"], ["normal"]],
  ["thread.next", "Next thread", ["space l"], ["normal"]],
  ["sidebar.toggle", "Show / hide sidebar", ["space b"], ["normal"]],
  ["commandPalette.toggle", "Command palette", ["space :"], ["normal"]],
  ["diff.toggle", "Open diff", ["space g d"], ["normal"]],
  ["help", "Shortcut help", ["space ?"], ["normal"]],
  ["move.down", "Scroll down / next list item", ["j"], ["normal"]],
  ["move.up", "Scroll up / previous list item", ["k"], ["normal"]],
  ["move.halfDown", "Scroll half a page down", ["ctrl+d"], ["normal"]],
  ["move.halfUp", "Scroll half a page up", ["ctrl+u"], ["normal"]],
  ["move.top", "Go to top", ["g g"], ["normal"]],
  ["move.bottom", "Go to bottom", ["G"], ["normal"]],
  ["message.next", "Next message", ["] m"], ["normal"]],
  ["message.previous", "Previous message", ["[ m"], ["normal"]],
  ["hunk.next", "Next diff hunk", ["] c"], ["normal"]],
  ["hunk.previous", "Previous diff hunk", ["[ c"], ["normal"]],
  ["search.open", "Search conversation", ["/"], ["normal"]],
  ["search.next", "Next search match", ["n"], ["normal"]],
  ["search.previous", "Previous search match", ["N"], ["normal"]],
  ["list.collapse", "Collapse project", ["h"], ["normal"]],
  ["list.expand", "Expand project", ["l"], ["normal"]],
  ["list.open", "Open selected item", ["enter"], ["normal"]],
] as const;
export type VimCommand = (typeof VIM_COMMANDS)[number][0];
export interface VimBinding {
  command: VimCommand;
  label: string;
  keys: readonly string[];
  modes: readonly VimMode[];
}

/** Tokens describe sequential strokes; letter case is significant, as in Vim. */
export function normalizeStroke(stroke: string): string {
  const parts = stroke.split("+");
  let key = parts.pop() ?? "";
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  const known = ["ctrl", "alt", "meta", "shift"];
  if ([...modifiers].some((modifier) => !known.includes(modifier))) return stroke;
  if (key.length > 1) key = key.toLowerCase();
  if (key === "esc") key = "escape";
  if (key === "comma") key = ",";
  if (key === "plus") key = "+";
  const modified = modifiers.has("ctrl") || modifiers.has("alt") || modifiers.has("meta");
  if (/^[A-Z]$/.test(key) && modified) {
    modifiers.add("shift");
    key = key.toLowerCase();
  }
  if (/^[a-z]$/.test(key) && modifiers.has("shift") && !modified) {
    modifiers.delete("shift");
    key = key.toUpperCase();
  }
  return [...known.filter((mod) => modifiers.has(mod)), key === " " ? "space" : key].join("+");
}
export function parseSequence(sequence: string): string[] {
  return sequence.trim().split(/\s+/).filter(Boolean).map(normalizeStroke);
}
export function strokeFromEvent(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey"> &
    Partial<Pick<KeyboardEvent, "code">>,
): string {
  let key =
    event.key === " " ? "space" : event.key.length === 1 ? event.key : event.key.toLowerCase();
  if (event.altKey && event.code?.startsWith("Key")) key = event.code.slice(3).toLowerCase();
  const modified = event.ctrlKey || event.altKey || event.metaKey;
  if (modified) key = key.toLowerCase();
  return [
    event.ctrlKey && "ctrl",
    event.altKey && "alt",
    event.metaKey && "meta",
    modified && event.shiftKey && "shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
export function resolveVimBindings(settings: VimSettings): VimBinding[] {
  return VIM_COMMANDS.map(([command, label, keys, modes]) => {
    const override = settings.bindings.findLast((binding) => binding.command === command);
    return { command, label, keys: override?.keys ?? keys, modes: override?.modes ?? modes };
  });
}
export function commandAvailable(command: VimCommand, scope: VimScope): boolean {
  if (command.startsWith("message.") || command.startsWith("search.")) return scope === "chat";
  if (command.startsWith("hunk.")) return scope === "diff";
  if (command === "pane.close") return scope === "terminal" || scope === "diff";
  if (command.startsWith("list.")) return scope === "sidebar" || scope === "diff";
  if (command === "terminal.split" || command === "terminal.splitVertical")
    return scope === "terminal";
  return true;
}
export interface SequenceState {
  strokes: readonly string[];
  count: string;
}
export const EMPTY_SEQUENCE: SequenceState = { strokes: [], count: "" };
export interface SequenceResult {
  state: SequenceState;
  consumed: boolean;
  command?: VimCommand;
  count?: number;
  candidates?: readonly VimBinding[];
}
const counted = /^(move\.|message\.|hunk\.|search\.(next|previous)$)/;
/** A mismatching suffix is consumed, never reinterpreted as an unrelated command. */
export function advanceSequence(
  state: SequenceState,
  stroke: string,
  bindings: readonly VimBinding[],
  mode: VimMode,
  scope: VimScope,
): SequenceResult {
  if (
    mode === "normal" &&
    state.strokes.length === 0 &&
    /^[0-9]$/.test(stroke) &&
    (stroke !== "0" || state.count !== "")
  ) {
    return { consumed: true, state: { strokes: [], count: (state.count + stroke).slice(0, 4) } };
  }
  const strokes = [...state.strokes, stroke];
  const candidates = bindings.filter(
    (binding) =>
      binding.modes.includes(mode) &&
      commandAvailable(binding.command, scope) &&
      binding.keys.some((key) => {
        const sequence = parseSequence(key);
        return strokes.every((part, index) => sequence[index] === part);
      }),
  );
  const exact = candidates.findLast((binding) =>
    binding.keys.some((key) => parseSequence(key).length === strokes.length),
  );
  if (exact)
    return {
      consumed: true,
      state: EMPTY_SEQUENCE,
      command: exact.command,
      count: counted.test(exact.command) ? Math.max(1, Number(state.count)) : 1,
    };
  if (candidates.length > 0) return { consumed: true, state: { ...state, strokes }, candidates };
  return { consumed: state.strokes.length > 0 || state.count !== "", state: EMPTY_SEQUENCE };
}

export function bindingWarnings(binding: VimBinding, bindings: readonly VimBinding[]): string[] {
  const warnings: string[] = [];
  for (const key of binding.keys) {
    const sequence = parseSequence(key);
    if (
      sequence.length === 0 ||
      sequence.some(
        (stroke) =>
          !/^(?:(?:ctrl|alt|meta|shift)\+)*(?:[^\s]|space|escape|enter|tab|backspace|arrow(?:up|down|left|right)|f\d{1,2})$/.test(
            stroke,
          ),
      )
    ) {
      warnings.push(`Invalid sequence: ${key}`);
    }
    if (/^(ctrl|meta)\+(w|t|n|l|r|q)$/.test(sequence[0] ?? ""))
      warnings.push(`${key}: the browser or desktop may reserve the first key.`);
    for (const other of bindings) {
      if (
        other.command === binding.command ||
        !other.modes.some((mode) => binding.modes.includes(mode))
      )
        continue;
      if (
        other.keys.some((otherKey) => {
          const parts = parseSequence(otherKey);
          return sequence
            .slice(0, Math.min(sequence.length, parts.length))
            .every((part, index) => part === parts[index]);
        })
      )
        warnings.push(
          `Overlaps ${other.label}. Exact matches run before longer sequences; the last matching command wins.`,
        );
    }
  }
  return [...new Set(warnings)];
}

/** Let editable widgets cancel first, without trapping Insert mode after they unmount. */
export function normalModePhase({
  mode,
  editable,
  composer,
  help,
}: {
  mode: VimMode;
  editable: boolean;
  composer: boolean;
  help: boolean;
}): "capture" | "bubble" | "pass" {
  if (mode === "insert" && editable && !composer) return "bubble";
  if (mode === "normal" && !help) return "pass";
  return "capture";
}
