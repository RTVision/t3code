import { act, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MentionSuggestionsContext, MentionTextarea } from "./mention-textarea";

vi.mock("./textarea", () => ({
  Textarea: (props: React.ComponentProps<"textarea">) => <textarea {...props} />,
}));

let renderer: ReactTestRenderer;
const onKeyDown = vi.fn();
const onRequest = vi.fn();
function Editor() {
  const [value, setValue] = useState("Please @a review this");
  return (
    <MentionSuggestionsContext
      value={{ candidates: [{ login: "alice" }, { login: "adam" }], pending: false, onRequest }}
    >
      <MentionTextarea value={value} onValueChange={setValue} onKeyDown={onKeyDown} />
      <button type="button" onClick={() => setValue("")}>
        Clear
      </button>
    </MentionSuggestionsContext>
  );
}
const input = () => renderer.root.findByType("textarea");
const keyboard = (key: string, ctrlKey = false) => ({
  key,
  ctrlKey,
  nativeEvent: { isComposing: false },
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 1;
  });
  onKeyDown.mockClear();
  onRequest.mockClear();
  await act(async () => {
    renderer = create(<Editor />);
  });
  await act(async () =>
    input().props.onSelect({
      currentTarget: { value: "Please @a review this", selectionStart: 9, selectionEnd: 9 },
    }),
  );
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("completes the selected person without submitting or losing the rest of the review", async () => {
  expect(onRequest).toHaveBeenCalledOnce();
  await act(async () => input().props.onKeyDown(keyboard("ArrowDown")));
  const enter = keyboard("Enter");
  await act(async () => input().props.onKeyDown(enter));
  expect(input().props.value).toBe("Please @adam review this");
  expect(enter.preventDefault).toHaveBeenCalledOnce();
  expect(onKeyDown).not.toHaveBeenCalled();
  expect(renderer.root.findAllByProps({ role: "listbox" })).toHaveLength(0);
});

it("dismisses suggestions before Escape reaches the review editor", async () => {
  await act(async () => input().props.onKeyDown(keyboard("Escape")));
  expect(onKeyDown).not.toHaveBeenCalled();
  expect(input().props.value).toBe("Please @a review this");
  await act(async () => input().props.onKeyDown(keyboard("Escape")));
  expect(onKeyDown).toHaveBeenCalledOnce();
});

it("keeps Ctrl+Enter available for submitting the review", async () => {
  const shortcut = keyboard("Enter", true);
  await act(async () => input().props.onKeyDown(shortcut));
  expect(onKeyDown).toHaveBeenCalledWith(shortcut);
  expect(input().props.value).toBe("Please @a review this");
});

it("dismisses a stale mention when the parent clears the comment without blurring", async () => {
  expect(renderer.root.findAllByProps({ role: "listbox" })).toHaveLength(1);
  await act(async () => renderer.root.findByType("button").props.onClick());
  expect(renderer.root.findAllByProps({ role: "listbox" })).toHaveLength(0);
  await act(async () => input().props.onKeyDown(keyboard("Enter")));
  expect(input().props.value).toBe("");
  expect(onKeyDown).toHaveBeenCalledOnce();
});
