import { hydratePartialDiff, type FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import {
  EnvironmentId,
  ProjectId,
  PullRequestDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createGitDiffFileContentsLoader,
  createPullRequestDiffFileContentsLoader,
} from "./diffFileContents";

const decodePullRequestInput = Schema.decodeUnknownSync(PullRequestDiffFileContentsInput);

const SOURCE = {
  environmentId: EnvironmentId.make("environment-1"),
  cwd: "/workspace",
  sourceKind: "branch-range" as const,
  baseRef: "main",
  headRef: "feature",
  cacheKey: "comparison-1",
};

function fileDiff(type: FileDiffMetadata["type"] = "rename-changed"): FileDiffMetadata {
  return {
    type,
    prevName: "src/old-name.ts",
    name: "src/new-name.ts",
    prevObjectId: "aaaaaaa",
    newObjectId: "bbbbbbb",
  } as FileDiffMetadata;
}

describe("createGitDiffFileContentsLoader", () => {
  it("loads both sides with normalized paths and comparison-scoped cache keys", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "before\n", newContents: "after\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).resolves.toEqual({
      oldFile: {
        name: "src/old-name.ts",
        contents: "before\n",
        cacheKey: "comparison-1:old:src/old-name.ts:aaaaaaa",
      },
      newFile: {
        name: "src/new-name.ts",
        contents: "after\n",
        cacheKey: "comparison-1:new:src/new-name.ts:bbbbbbb",
      },
    });
    expect(getDiffFileContents).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: {
        cwd: "/workspace",
        sourceKind: "branch-range",
        changeType: "rename-changed",
        baseRef: "main",
        headRef: "feature",
        oldPath: "src/old-name.ts",
        newPath: "src/new-name.ts",
      },
    });
  });

  it("loads a pure rename from its one shared file", async () => {
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.success({ oldContents: "same\n", newContents: "same\n" }),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff("rename-pure"))).resolves.toMatchObject({
      oldFile: null,
      newFile: { name: "src/new-name.ts", contents: "same\n" },
    });
  });

  it("passes command failures through to Pierre's expansion handling", async () => {
    const failure = new Error("revision is not available locally");
    const getDiffFileContents = vi.fn(async () =>
      AsyncResult.failure<ReviewDiffFileContentsResult, Error>(Cause.fail(failure)),
    );
    const load = createGitDiffFileContentsLoader(getDiffFileContents, SOURCE);

    await expect(load(fileDiff())).rejects.toBe(failure);
  });
});

describe("createPullRequestDiffFileContentsLoader", () => {
  it("hydrates and caches each rendered patch from its own blobs after the PR moves", async () => {
    const blobs = new Map([
      ["aaaaaaa", "heading\nbefore\nfooter\n"],
      ["bbbbbbb", "heading\nafter\nfooter\n"],
      ["ccccccc", "fresh heading\nbefore base\nfresh footer\n"],
      ["ddddddd", "fresh heading\nafter head\nfresh footer\n"],
    ]);
    const load = createPullRequestDiffFileContentsLoader(
      async ({ input }) => {
        const request = decodePullRequestInput(input);
        return AsyncResult.success({
          oldContents: blobs.get(request.oldObjectId ?? "ccccccc")!,
          newContents: blobs.get(request.newObjectId ?? "ddddddd")!,
        });
      },
      {
        environmentId: SOURCE.environmentId,
        reference: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
        },
        commit: null,
        cacheKey: "pull-request-1",
      },
    );
    const patches = [
      ["aaaaaaa", "bbbbbbb", "before", "after"],
      ["ccccccc", "ddddddd", "before base", "after head"],
    ].map(
      ([oldId, newId, before, after]) =>
        parsePatchFiles(
          [
            "diff --git a/src/app.ts b/src/app.ts",
            `index ${oldId}..${newId} 100644`,
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -2 +2 @@",
            `-${before}`,
            `+${after}`,
            "",
          ].join("\n"),
        )[0]!.files[0]!,
    );
    const first = hydratePartialDiff("clone", patches[0]!, await load(patches[0]!));
    const second = hydratePartialDiff("clone", patches[1]!, await load(patches[1]!));
    const cached = new Map([
      [first.cacheKey, first],
      [second.cacheKey, second],
    ]);

    expect(first.isPartial).toBe(false);
    expect(first.deletionLines.join("")).toBe(blobs.get("aaaaaaa"));
    expect(first.additionLines.join("")).toBe(blobs.get("bbbbbbb"));
    expect(second.deletionLines.join("")).toBe(blobs.get("ccccccc"));
    expect(second.additionLines.join("")).toBe(blobs.get("ddddddd"));
    expect(cached.size).toBe(2);
    expect(cached.get(first.cacheKey)?.additionLines.join("")).toBe(blobs.get("bbbbbbb"));
    expect(cached.get(second.cacheKey)?.additionLines.join("")).toBe(blobs.get("ddddddd"));
  });
});
