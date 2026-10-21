import type { CodeViewItem } from "@pierre/diffs";
import diffsUrl from "@pierre/diffs?url";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { stubGlobal } from "../../../test/render";

function fixture() {
  const root = document.createElement("div");
  root.tabIndex = -1;
  document.body.append(root);
  const fileDiff = parsePatchFiles(`diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-oldName
+oldName twice
`)[0]!.files[0]!;
  let items: CodeViewItem<undefined>[] = [{ id: "a", type: "diff", fileDiff, collapsed: true }];
  const revealed: Array<{ id: string; side: string; lineNumber: number }> = [];
  const frames: FrameRequestCallback[] = [];
  const frameStub = stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    frames.push(callback),
  );
  return {
    root,
    [Symbol.dispose]() {
      root.remove();
      frameStub[Symbol.dispose]();
    },
    revealed,
    frames,
    replaceItems: () => {
      items = [];
    },
    view: {
      getContainerElement: () => root,
      getStickyHeaderOffset: () => 0,
      getSearchItems: () => items,
      getFirstVisibleSearchMatchIndex: () => 0,
      getMountedSearchMatches: () => [],
      cancelSearchReveal: () => {},
      revealSearchMatch: (match: { id: string; side: string; lineNumber: number }) =>
        revealed.push(match),
    },
  };
}
// The patched search module is not exported; Vite supplies a browser-loadable sibling URL.
const searchUrl = new URL("./components/CodeViewSearch.js", new URL(diffsUrl, import.meta.url));
const { CodeViewSearch } = (await import(/* @vite-ignore */ searchUrl.href)) as {
  CodeViewSearch: new (view: ReturnType<typeof fixture>["view"]) => {
    open(): void;
    close(): void;
    navigate(delta: number): void;
    cleanUp(): void;
  };
};

function searchFixture() {
  const result = fixture();
  const search = new CodeViewSearch(result.view);
  search.open();
  for (const frame of result.frames.splice(0)) frame(0);
  const input = result.root
    .querySelector("[data-diffs-search]")!
    .shadowRoot!.querySelector<HTMLInputElement>('input[placeholder="Search"]')!;
  input.value = "oldName";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return {
    ...result,
    search,
    [Symbol.dispose]() {
      search.cleanUp();
      result[Symbol.dispose]();
    },
  };
}

describe("Vim repeats through upstream diff search", () => {
  it("repeats and wraps the same query after closing the panel", () => {
    using fixture = searchFixture();
    const { search, revealed, root } = fixture;
    expect(revealed.at(-1)?.side).toBe("deletions");
    search.close();
    expect(root.querySelector("[data-diffs-search]")).toBeNull();
    search.navigate(1);
    expect(revealed.at(-1)?.side).toBe("additions");
    search.navigate(1);
    expect(revealed.at(-1)?.side).toBe("deletions");
    search.navigate(-1);
    expect(revealed.at(-1)?.side).toBe("additions");
    search.cleanUp();
  });
  it("rechecks changed files and discards the query when the viewer is disposed", () => {
    using fixture = searchFixture();
    const { search, revealed, replaceItems } = fixture;
    search.close();
    const count = revealed.length;
    replaceItems();
    search.navigate(1);
    expect(revealed).toHaveLength(count);
    search.cleanUp();
    search.navigate(1);
    expect(revealed).toHaveLength(count);
  });
});
