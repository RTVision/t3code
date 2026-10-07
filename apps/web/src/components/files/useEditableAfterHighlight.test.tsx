import type { FileContents } from "@pierre/diffs";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const worker = vi.hoisted(() => ({
  isWorkingPool: () => true,
  primeFileHighlightCache: vi.fn(),
  getFileResultCache: vi.fn(),
}));
vi.mock("@pierre/diffs/react", () => ({ useWorkerPool: () => worker }));
import { useEditableAfterHighlight } from "./useEditableAfterHighlight";
let view: ReturnType<typeof useEditableAfterHighlight>;
let renderer: ReactTestRenderer | undefined;
function Probe({ file }: { file: FileContents }) {
  const current = useEditableAfterHighlight(file);
  useLayoutEffect(() => {
    view = current;
  });
  return null;
}
const file = (name: string, contents: string, cacheKey = name): FileContents => ({
  name,
  contents,
  cacheKey,
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  worker.primeFileHighlightCache.mockReset().mockResolvedValue(undefined);
  worker.getFileResultCache.mockReset().mockReturnValue(undefined);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
it("allows editing an empty syntax file without waiting for a worker render that Pierre never emits", async () => {
  await act(async () => {
    renderer = create(<Probe file={file("new.ts", "")} />);
  });
  expect(view.ready).toBe(true);
  expect(worker.primeFileHighlightCache).not.toHaveBeenCalled();
});
it("waits for a cached nonempty syntax render and ignores previous file renders", async () => {
  const first = file("a.ts", "const a = 1", "a:1");
  await act(async () => {
    renderer = create(<Probe file={first} />);
  });
  expect(view.ready).toBe(false);
  expect(worker.primeFileHighlightCache).toHaveBeenCalledExactlyOnceWith(first);
  worker.getFileResultCache.mockReturnValue({});
  await act(async () => view.onPostRender(first, "mount"));
  expect(view.ready).toBe(true);
  const second = file("a.ts", "const a = 2", "a:2");
  await act(async () => renderer!.update(<Probe file={second} />));
  expect(view.ready).toBe(false);
  await act(async () => view.onPostRender(first, "update"));
  expect(view.ready).toBe(false);
  await act(async () => view.onPostRender(second, "unmount"));
  expect(view.ready).toBe(false);
  await act(async () => view.onPostRender(second, "update"));
  expect(view.ready).toBe(true);
});
it("permits plain text immediately and falls back on highlight failure", async () => {
  await act(async () => {
    renderer = create(<Probe file={file("readme.txt", "hello")} />);
  });
  expect(view.ready).toBe(true);
  worker.primeFileHighlightCache.mockRejectedValue(new Error("Worker failed"));
  await act(async () => renderer!.update(<Probe file={file("new.ts", "let x = 1")} />));
  expect(view.ready).toBe(true);
});
