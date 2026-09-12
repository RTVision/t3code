import type { FileDiffContentsLoader, FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WhitespaceMode } from "./pullRequestWhitespace";

interface FilteredFile {
  file: FileDiffMetadata;
  error: string | null;
}

export function usePullRequestWhitespace(
  files: FileDiffMetadata[],
  mode: WhitespaceMode,
  loadDiffFiles: FileDiffContentsLoader,
) {
  const [cache, setCache] = useState(
    () => new Map<FileDiffMetadata, Map<WhitespaceMode, FilteredFile>>(),
  );
  const [displayedMode, setDisplayedMode] = useState<WhitespaceMode>(mode);
  const ready = mode === "all" || files.every((file) => cache.get(file)?.has(mode));
  if (ready && displayedMode !== mode) setDisplayedMode(mode);
  const contents = useRef(new WeakMap<FileDiffMetadata, Promise<FileDiffLoadedFiles>>());
  useEffect(() => {
    if (mode === "all" || files.length === 0) return;
    let cancelled = false;
    const missing = files.filter((file) => !cache.get(file)?.has(mode));
    if (missing.length === 0) return;
    const complete = (filtered: FileDiffMetadata[], failures: string[]) => {
      setCache((previous) => {
        // Keep only this diff's files, including results for its other whitespace modes.
        const next = new Map(files.map((file) => [file, previous.get(file) ?? new Map()]));
        missing.forEach((source, index) => {
          const modes = new Map(next.get(source));
          modes.set(mode, {
            file: filtered[index]!,
            error: failures.includes(source.name) ? source.name : null,
          });
          next.set(source, modes);
        });
        return next;
      });
    };
    const fail = () =>
      complete(
        missing,
        missing.map((file) => file.name),
      );
    let worker: Worker;
    try {
      worker = new Worker(new URL("./pullRequestWhitespace.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      fail();
      return;
    }
    worker.addEventListener(
      "message",
      (event: MessageEvent<{ files: FileDiffMetadata[]; failures: string[] }>) => {
        if (cancelled) return;
        if (event.data.files) {
          complete(event.data.files, event.data.failures);
        } else fail();
        worker.terminate();
      },
    );
    worker.addEventListener("error", () => {
      if (!cancelled) fail();
      worker.terminate();
    });
    // Only patches with separate hunks need the host's full revisions. Bound concurrent reads.
    const prepared: { file: FileDiffMetadata; contents?: FileDiffLoadedFiles }[] = [];
    let next = 0;
    const prepare = async () => {
      while (next < missing.length) {
        if (cancelled) return;
        const index = next++;
        const file = missing[index]!;
        prepared[index] = { file };
        if (
          !file.isPartial ||
          file.hunks.length < 2 ||
          !["change", "rename-changed"].includes(file.type)
        )
          continue;
        let loading = contents.current.get(file);
        if (!loading) {
          loading = Promise.resolve().then(() => loadDiffFiles(file));
          contents.current.set(file, loading);
        }
        try {
          prepared[index] = { file, contents: await loading };
        } catch {
          // Retain failed reads too, so another page or mode cannot retry every unavailable file.
        }
      }
    };
    void Promise.all([prepare(), prepare(), prepare(), prepare()])
      .then(() => {
        if (!cancelled) worker.postMessage({ files: prepared, mode }, { transfer: [] });
      })
      .catch(() => {
        if (!cancelled) {
          fail();
          worker.terminate();
        }
      });
    return () => {
      cancelled = true;
      worker.terminate();
    };
  }, [cache, files, mode, loadDiffFiles]);
  return useMemo(() => {
    if (mode === "all" || files.length === 0) return { files, pending: false, error: null };
    let pending = false;
    const failures: string[] = [];
    const filtered = files.map((file) => {
      const modes = cache.get(file);
      const result = modes?.get(mode);
      if (!result) pending = true;
      if (result?.error) failures.push(result.error);
      // Keep existing items mounted while a page or a new comparison is being prepared.
      return result?.file ?? modes?.get(displayedMode)?.file ?? file;
    });
    return {
      files: filtered,
      pending,
      error: failures.length
        ? `Showing all changes for files that could not be filtered: ${failures.join(", ")}`
        : null,
    };
  }, [cache, displayedMode, files, mode]);
}
