import type { PullRequestCapabilities } from "@t3tools/contracts";

export function giteaForkCapabilities(
  base: PullRequestCapabilities,
  features: ReadonlyArray<string>,
): PullRequestCapabilities {
  return {
    ...base,
    actions: base.actions.filter((action) =>
      action === "approve-workflows"
        ? features.includes("actions-run-approve")
        : action === "revert"
          ? features.includes("pull-revert")
          : true,
    ),
    ...(features.includes("pull-review-reactions")
      ? { reactionSubjects: { ...base.reactionSubjects!, review: true } }
      : {}),
  };
}

export function giteaHasFeature(features: ReadonlyArray<string>, feature: string): boolean {
  return features.includes(feature);
}
