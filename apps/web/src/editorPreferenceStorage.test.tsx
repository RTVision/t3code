import { act } from "../test/act";
import { useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { useEditorPreference } from "./editorPreferenceStorage";

let root: ReactTestRenderer;
let current: string;
let setValue: (value: string) => void;
const backing = new Map<string, string>();
const read = vi.fn((key: string) => backing.get(key) ?? null);
let windowEvents: EventTarget;
let listenerNames: () => string[];
function Consumer() {
  const [value, set] = useEditorPreference("t3code:test-editor", "default", Schema.String);
  useLayoutEffect(() => {
    current = value;
    setValue = set;
  });
  return null;
}
async function renderConsumers(count: number) {
  await act(() =>
    root.update(
      <>
        {Array.from({ length: count }, (_, key) => (
          <Consumer key={key} />
        ))}
      </>,
    ),
  );
}
beforeEach(async () => {
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  windowEvents = new EventTarget();
  const added = vi.spyOn(windowEvents, "addEventListener");
  listenerNames = () => added.mock.calls.map(([name]) => name);
  vi.stubGlobal("document", document);
  vi.stubGlobal(
    "window",
    Object.assign(windowEvents, {
      document,
      HTMLIFrameElement: EventTarget,
      localStorage: {
        getItem: read,
        setItem: (key: string, value: string) => backing.set(key, value),
        removeItem: (key: string) => backing.delete(key),
      },
    }),
  );

  backing.clear();
  read.mockClear();
  await act(() => {
    root = create(<></>);
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("shares browser listeners and cached reads across many editor consumers", async () => {
  await renderConsumers(40);
  expect(listenerNames().filter((name) => name === "storage")).toHaveLength(1);
  expect(listenerNames().filter((name) => name === "t3code:local_storage_change")).toHaveLength(1);
  expect(read.mock.calls.length).toBeLessThanOrEqual(2);
  read.mockClear();
  await renderConsumers(50);
  expect(read).not.toHaveBeenCalled();
  await act(() => setValue("neovim"));
  expect(current).toBe("neovim");
  backing.set("t3code:test-editor", JSON.stringify("vscode"));
  const event = new Event("storage");
  Object.assign(event, { key: "t3code:test-editor" });
  await act(() => windowEvents.dispatchEvent(event));
  expect(current).toBe("vscode");
});

it("writes and notifies only once when many consumers migrate the same preference", async () => {
  await renderConsumers(40);
  const write = vi.spyOn(window.localStorage, "setItem");
  const dispatch = vi.spyOn(windowEvents, "dispatchEvent");
  await act(() => {
    for (let index = 0; index < 40; index++) setValue("vscode");
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(current).toBe("vscode");
});
