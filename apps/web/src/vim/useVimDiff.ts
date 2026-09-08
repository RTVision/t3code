import { useEffect, useRef, useState } from "react";
import type { FileDiffMetadata, CodeViewScrollTarget } from "@pierre/diffs";
import type { AnnotatableCodeViewHandle } from "../components/diffs/AnnotatableCodeView";
import { useVimAction, vimPane } from "./runtime";

export function useVimDiff({
  files,
  viewer,
  reveal,
}: {
  files: readonly {
    fileDiff: FileDiffMetadata;
    fileKey: string;
    filePath: string;
    collapsed: boolean;
  }[];
  viewer: AnnotatableCodeViewHandle | null;
  reveal: (path: string) => void;
}) {
  const hunkIndex = useRef(-1);
  const fileIndex = useRef(0);
  const [target, setTarget] = useState<CodeViewScrollTarget | null>(null);
  const fileVersion = files.map((file) => file.fileKey).join("\n");
  const previousVersion = useRef(fileVersion);
  const appliedTarget = useRef<CodeViewScrollTarget | null>(null);
  useEffect(() => {
    if (!target || appliedTarget.current === target || !viewer?.getInstance()) return;
    const file = "id" in target ? files.find((item) => item.fileKey === target.id) : undefined;
    if (file?.collapsed) return;
    viewer.scrollTo(target);
    appliedTarget.current = target;
  }, [files, target, viewer]);
  useVimAction(({ command, scope, count }) => {
    if (scope !== "diff") return;
    if (previousVersion.current !== fileVersion) {
      previousVersion.current = fileVersion;
      hunkIndex.current = -1;
      fileIndex.current = 0;
    }
    if (command === "hunk.next" || command === "hunk.previous") {
      const hunks = files.flatMap((file) => file.fileDiff.hunks.map((hunk) => ({ file, hunk })));
      hunkIndex.current = Math.max(
        0,
        Math.min(hunks.length - 1, hunkIndex.current + (command === "hunk.next" ? count : -count)),
      );
      const next = hunks[hunkIndex.current];
      if (next) {
        reveal(next.file.filePath);
        setTarget({
          type: "line",
          id: next.file.fileKey,
          lineNumber:
            next.hunk.additionCount > 0 ? next.hunk.additionStart : next.hunk.deletionStart,
          side: next.hunk.additionCount > 0 ? "additions" : "deletions",
          align: "start",
        });
      }
      return true;
    }
    const pane = vimPane(document.activeElement);
    const tree = document.activeElement?.closest('[role="tree"], [data-vim-diff-files]');
    if (command === "list.open" || ((command === "move.down" || command === "move.up") && tree)) {
      if (command !== "list.open")
        fileIndex.current = Math.max(
          0,
          Math.min(
            files.length - 1,
            fileIndex.current + (command === "move.down" ? count : -count),
          ),
        );
      const next = files[fileIndex.current];
      if (next) reveal(next.filePath);
      return true;
    }
    if (!command.startsWith("move.")) return;
    const instance = viewer?.getInstance();
    if (instance) {
      const height = pane?.clientHeight ?? 600;
      const position =
        command === "move.top"
          ? 0
          : command === "move.bottom"
            ? instance.getScrollHeight()
            : instance.getScrollTop() +
              (command === "move.up" || command === "move.halfUp" ? -1 : 1) *
                count *
                (command === "move.halfDown" || command === "move.halfUp" ? height / 2 : 40);
      viewer?.scrollTo({ type: "position", position: Math.max(0, position), behavior: "instant" });
    }
    return true;
  });
}
