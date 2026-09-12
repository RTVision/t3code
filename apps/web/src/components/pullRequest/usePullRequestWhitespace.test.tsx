import { act, useLayoutEffect, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { parsePatchFiles, type FileDiffLoadedFiles, type FileDiffMetadata } from "@pierre/diffs";
import { buildFileDiffRenderKey } from "~/lib/diffRendering";
import { usePullRequestWhitespace } from "./usePullRequestWhitespace";
import type { WhitespaceMode } from "./pullRequestWhitespace";

const files = parsePatchFiles(
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -20 +20 @@\n-old\n+new\n",
)[0]!.files;
const workers: TestWorker[] = [];
class TestWorker {
  listeners = new Map<string, (event: unknown) => void>();
  postMessage =
    vi.fn<(input: { files: { file: FileDiffMetadata }[]; mode: WhitespaceMode }) => void>();
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
  addEventListener(name: string, listener: (event: unknown) => void) {
    this.listeners.set(name, listener);
  }
  reply(failures: string[] = []) {
    const input = this.postMessage.mock.lastCall![0];
    this.listeners.get("message")?.({
      data: {
        files: input.files.map(({ file }) =>
          failures.includes(file.name)
            ? file
            : { ...file, cacheKey: `${file.name}:whitespace:${input.mode}` },
        ),
        failures,
      },
    });
  }
}
let renderer: ReactTestRenderer;
let state: ReturnType<typeof usePullRequestWhitespace>;
const rendered: (typeof state)[] = [];
function Reply() {
  const [text, setText] = useState("");
  return <textarea value={text} onChange={(event) => setText(event.target.value)} />;
}
function Harness({
  mode,
  load,
  inputFiles = files,
}: {
  mode: WhitespaceMode;
  load: (file: FileDiffMetadata) => Promise<FileDiffLoadedFiles>;
  inputFiles?: FileDiffMetadata[];
}) {
  const result = usePullRequestWhitespace(inputFiles, mode, load);
  useLayoutEffect(() => {
    state = result;
    rendered.push(result);
  }, [result]);
  return result.files.map((file) => <Reply key={buildFileDiffRenderKey(file)} />);
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  workers.length = 0;
  rendered.length = 0;
  vi.unstubAllGlobals();
});

it("does not send a late file load to a worker after showing all changes again", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", TestWorker);
  let resolve!: (value: FileDiffLoadedFiles) => void;
  const promise = new Promise<FileDiffLoadedFiles>((complete) => {
    resolve = complete;
  });
  const loading = { promise, resolve };
  const load = vi.fn(() => loading.promise);
  await act(async () => {
    renderer = create(<Harness mode="ignore-all" load={load} />);
  });
  expect(state.pending).toBe(true);
  expect(load).toHaveBeenCalledOnce();
  await act(async () => renderer.update(<Harness mode="all" load={load} />));
  await act(async () =>
    loading.resolve({
      oldFile: { name: "a.ts", contents: "old" },
      newFile: { name: "a.ts", contents: "new" },
    }),
  );
  expect(workers[0]!.postMessage).not.toHaveBeenCalled();
  expect(workers[0]!.terminate).toHaveBeenCalled();
  expect(state).toEqual({ files, pending: false, error: null });
});

it("reuses loaded revisions and filtered results when switching whitespace modes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", TestWorker);
  const load = vi.fn(async () => ({
    oldFile: { name: "a.ts", contents: "old" },
    newFile: { name: "a.ts", contents: "new" },
  }));
  await act(async () => {
    renderer = create(<Harness mode="ignore-all" load={load} />);
  });
  await act(async () => workers[0]!.reply());
  const ignoreAll = state.files[0];
  expect(state.pending).toBe(false);
  await act(async () => renderer.update(<Harness mode="ignore-eol" load={load} />));
  await act(async () => workers[1]!.reply());
  const ignoreEol = state.files[0];
  expect(load).toHaveBeenCalledOnce();
  rendered.length = 0;
  await act(async () => renderer.update(<Harness mode="ignore-amount" load={load} />));
  expect(state.pending).toBe(true);
  expect(rendered.every((result) => result.files[0] === ignoreEol)).toBe(true);
  rendered.length = 0;
  await act(async () => renderer.update(<Harness mode="ignore-all" load={load} />));
  expect(workers).toHaveLength(3);
  expect(state.pending).toBe(false);
  expect(rendered.every((result) => result.files[0] === ignoreAll)).toBe(true);
});

it("keeps existing filtered items and their reply text when another page arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", TestWorker);
  const load = vi.fn(async () => ({
    oldFile: { name: "a.ts", contents: "old" },
    newFile: { name: "a.ts", contents: "new" },
  }));
  await act(async () => {
    renderer = create(<Harness mode="ignore-all" load={load} />);
  });
  await act(async () => workers[0]!.reply());
  const firstFile = state.files[0];
  await act(async () =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "Keep this reply" } }),
  );
  const nextPage = [...files, { ...files[0]!, name: "b.ts" }];
  rendered.length = 0;
  await act(async () =>
    renderer.update(<Harness mode="ignore-all" load={load} inputFiles={nextPage} />),
  );
  expect(state.pending).toBe(true);
  expect(state.files[0]).toBe(firstFile);
  await act(async () => workers[1]!.reply());
  expect(rendered.every((result) => result.files[0] === firstFile)).toBe(true);
  expect(renderer.root.findAllByType("textarea")[0]!.props.value).toBe("Keep this reply");
});

it("retains failed reads and their notice across pagination and whitespace modes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Worker", TestWorker);
  const load = vi.fn(async (file: FileDiffMetadata) => {
    if (file.name === "a.ts") throw new Error("Full revision unavailable");
    return {
      oldFile: { name: file.name, contents: "old" },
      newFile: { name: file.name, contents: "new" },
    };
  });
  await act(async () => {
    renderer = create(<Harness mode="ignore-all" load={load} />);
  });
  await act(async () => workers[0]!.reply(["a.ts"]));
  const nextPage = [...files, { ...files[0]!, name: "b.ts" }];
  await act(async () =>
    renderer.update(<Harness mode="ignore-all" load={load} inputFiles={nextPage} />),
  );
  await act(async () => workers[1]!.reply());
  expect(state.error).toContain("a.ts");
  await act(async () =>
    renderer.update(<Harness mode="ignore-eol" load={load} inputFiles={nextPage} />),
  );
  await act(async () => workers[2]!.reply(["a.ts"]));
  expect(load.mock.calls.map(([file]) => file.name)).toEqual(["a.ts", "b.ts"]);
  expect(state.error).toContain("a.ts");
});
