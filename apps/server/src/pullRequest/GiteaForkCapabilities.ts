import type { PullRequestCapabilities } from "@t3tools/contracts";

/** Capabilities added by the companion Gitea API extension, discovered lazily per server. */
export function giteaForkCapabilities(
  base: PullRequestCapabilities,
  features: ReadonlyArray<string>,
): PullRequestCapabilities {
  return features.includes("pull-review-reactions")
    ? { ...base, reactionSubjects: { ...base.reactionSubjects!, review: true } }
    : base;
}

export function giteaHasFeature(features: ReadonlyArray<string>, feature: string): boolean {
  return features.includes(feature);
}
