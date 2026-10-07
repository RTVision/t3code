import {
  DEFAULT_TOKENIZE_MAX_LENGTH,
  getFiletypeFromFileName,
  type FileContents,
  type PostRenderPhase,
} from "@pierre/diffs";
import { useWorkerPool } from "@pierre/diffs/react";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { useCallback, useEffect, useMemo, useState } from "react";

function needsWorkerHighlight(workerPool: WorkerPoolManager | undefined, file: FileContents) {
  // Pierre forces empty files to plain text and never emits a worker highlight render.
  if (file.contents.length === 0 || workerPool?.isWorkingPool() !== true) return false;
  if ((file.lang ?? getFiletypeFromFileName(file.name)) === "text") return false;
  let lines = 1;
  for (
    let index = file.contents.indexOf("\n");
    index !== -1;
    index = file.contents.indexOf("\n", index + 1)
  ) {
    lines += 1;
  }
  return lines <= DEFAULT_TOKENIZE_MAX_LENGTH;
}

/**
 * Pierre highlights an active edit session on the main thread, so each version
 * of the file becomes editable only once it has rendered the worker's
 * highlight. A failed worker highlight falls back to main-thread highlighting.
 */
export function useEditableAfterHighlight(file: FileContents) {
  const workerPool = useWorkerPool();
  const [highlightedFile, setHighlightedFile] = useState<FileContents | null>(null);
  const needsHighlight = useMemo(() => needsWorkerHighlight(workerPool, file), [file, workerPool]);
  const ready = !needsHighlight || highlightedFile === file;

  useEffect(() => {
    if (ready || workerPool === undefined) return;
    workerPool.primeFileHighlightCache(file).catch(() => setHighlightedFile(file));
  }, [file, ready, workerPool]);

  const onPostRender = useCallback(
    (renderedFile: FileContents | undefined, phase: PostRenderPhase) => {
      if (ready || phase === "unmount" || renderedFile?.cacheKey !== file.cacheKey) return;
      // The pool caches a result just before the instance renders it, so a
      // render that sees the cache has painted highlighted rows.
      if (workerPool?.getFileResultCache(file) !== undefined) setHighlightedFile(file);
    },
    [file, ready, workerPool],
  );
  return { ready, onPostRender };
}
