import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_VIM_SETTINGS } from "@t3tools/contracts/settings";
import {
  advanceSequence,
  EMPTY_SEQUENCE,
  resolveVimBindings,
  strokeFromEvent,
  bindingWarnings,
} from "./bindings";
const defaults = resolveVimBindings(DEFAULT_VIM_SETTINGS);

describe("Vim sequences", () => {
  it("opens the thread picker only after its complete leader sequence", () => {
    const prefix = advanceSequence(EMPTY_SEQUENCE, "space", defaults, "normal", "chat");
    expect(prefix.consumed).toBe(true);
    expect(prefix.command).toBeUndefined();
    const group = advanceSequence(prefix.state, "p", defaults, "normal", "chat");
    expect(advanceSequence(group.state, "t", defaults, "normal", "chat").command).toBe(
      "threadPicker.open",
    );
  });
  it("never reinterprets a mistyped sequence suffix as a command", () => {
    const prefix = advanceSequence(EMPTY_SEQUENCE, "space", defaults, "normal", "chat");
    const result = advanceSequence(prefix.state, "i", defaults, "normal", "chat");
    expect(result).toEqual({ consumed: true, state: EMPTY_SEQUENCE });
  });
  it("keeps shell keys untouched except explicitly reserved terminal bindings", () => {
    for (const key of ["j", "escape", "ctrl+c", "ctrl+w", "space"])
      expect(advanceSequence(EMPTY_SEQUENCE, key, defaults, "terminal", "terminal").consumed).toBe(
        false,
      );
    const prefix = advanceSequence(EMPTY_SEQUENCE, "ctrl+\\", defaults, "terminal", "terminal");
    expect(advanceSequence(prefix.state, "ctrl+n", defaults, "terminal", "terminal").command).toBe(
      "terminal.escape",
    );
  });
  it("applies counts to navigation, not destructive or input actions", () => {
    const count = advanceSequence(EMPTY_SEQUENCE, "5", defaults, "normal", "chat").state;
    expect(advanceSequence(count, "j", defaults, "normal", "chat").count).toBe(5);
    expect(advanceSequence(count, "i", defaults, "normal", "chat").count).toBe(1);
  });
  it("preserves case for G and N while normalizing modified strokes", () => {
    expect(
      strokeFromEvent({ key: "G", shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }),
    ).toBe("G");
    expect(advanceSequence(EMPTY_SEQUENCE, "G", defaults, "normal", "chat").command).toBe(
      "move.bottom",
    );
  });
  it("can replace, disable and change the modes of bindings", () => {
    const bindings = resolveVimBindings({
      ...DEFAULT_VIM_SETTINGS,
      bindings: [
        { command: "terminal.toggle", keys: ["alt+t"], modes: ["normal"] },
        { command: "input.enter", keys: [], modes: ["normal"] },
      ],
    });
    expect(advanceSequence(EMPTY_SEQUENCE, "ctrl+.", bindings, "normal", "chat").consumed).toBe(
      false,
    );
    expect(advanceSequence(EMPTY_SEQUENCE, "alt+t", bindings, "normal", "chat").command).toBe(
      "terminal.toggle",
    );
    expect(
      advanceSequence(EMPTY_SEQUENCE, "alt+t", bindings, "terminal", "terminal").consumed,
    ).toBe(false);
    expect(advanceSequence(EMPTY_SEQUENCE, "i", bindings, "normal", "chat").consumed).toBe(false);
  });
  it("does not offer hunk or message navigation in unrelated panes", () => {
    expect(advanceSequence(EMPTY_SEQUENCE, "]", defaults, "normal", "sidebar").consumed).toBe(
      false,
    );
  });
  it("flags reserved browser keys and ambiguous prefixes", () => {
    const binding = { ...defaults[0]!, keys: ["ctrl+w", "space p"] };
    const warnings = bindingWarnings(binding, defaults);
    expect(warnings.some((warning) => warning.includes("reserve"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("Find files"))).toBe(true);
  });
});
