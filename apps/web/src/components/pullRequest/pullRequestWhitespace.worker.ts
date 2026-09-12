import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import { filterDiffWhitespace, type WhitespaceMode } from "./pullRequestWhitespace";

self.addEventListener(
  "message",
  (
    event: MessageEvent<{
      files: { file: FileDiffMetadata; contents?: FileDiffLoadedFiles }[];
      mode: WhitespaceMode;
    }>,
  ) => {
    const failures: string[] = [];
    const files = event.data.files.map(({ file, contents }) => {
      try {
        return filterDiffWhitespace(file, event.data.mode, contents);
      } catch {
        failures.push(file.name);
        return file;
      }
    });
    self.postMessage({ files, failures }, { transfer: [] });
  },
);
