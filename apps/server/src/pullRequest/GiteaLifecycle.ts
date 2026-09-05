import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

import type { PullRequestAction } from "@t3tools/contracts";

const DEFAULT_DRAFT_PREFIXES = ["WIP:", "[WIP]"] as const;

export const RawGiteaLifecycleEvent = Schema.Struct({
  id: Schema.Int,
  type: Schema.String,
});
export type RawGiteaLifecycleEvent = typeof RawGiteaLifecycleEvent.Type;

export const draftPrefixesConfig = Config.string("T3CODE_GITEA_DRAFT_PREFIXES").pipe(
  Config.withDefault(DEFAULT_DRAFT_PREFIXES.join(",")),
  Config.map((value) => {
    const prefixes = value
      .split(",")
      .map((prefix) => prefix.trim())
      .filter((prefix) => prefix !== "");
    return prefixes.length === 0 ? DEFAULT_DRAFT_PREFIXES : prefixes;
  }),
);

function asciiEqualFold(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    const foldedLeft = leftCode >= 65 && leftCode <= 90 ? leftCode + 32 : leftCode;
    const foldedRight = rightCode >= 65 && rightCode <= 90 ? rightCode + 32 : rightCode;
    if (foldedLeft !== foldedRight) return false;
  }
  return true;
}

function matchingDraftPrefix(title: string, prefixes: ReadonlyArray<string>): string | undefined {
  return prefixes.find(
    (prefix) =>
      prefix.length <= title.length && asciiEqualFold(title.slice(0, prefix.length), prefix),
  );
}

/**
 * Gitea derives draft state from a configurable title prefix. T3 must be configured with the same
 * comma-separated prefix list when the server changes Gitea's defaults.
 */
export function titleForDraft(title: string, prefixes: ReadonlyArray<string>): string {
  if (matchingDraftPrefix(title, prefixes) !== undefined) return title;
  const prefix = prefixes[0] ?? DEFAULT_DRAFT_PREFIXES[0];
  return `${prefix.trimEnd()} ${title}`;
}

/** Returns null when the configured list cannot identify Gitea's effective prefix safely. */
export function titleForReady(title: string, prefixes: ReadonlyArray<string>): string | null {
  const prefix = matchingDraftPrefix(title, prefixes);
  if (prefix === undefined) return null;
  const readyTitle = title.slice(prefix.length).trim();
  return readyTitle === "" ? null : readyTitle;
}

/**
 * Scheduling and cancellation are committed in the same database transaction as these timeline
 * events in Gitea 1.27. A merge also removes the scheduled row, so the newest relevant event is a
 * durable cross-client answer even though Gitea omits auto-merge from its pull response.
 */
export function autoMergeEnabled(events: ReadonlyArray<RawGiteaLifecycleEvent>): boolean {
  let latest: RawGiteaLifecycleEvent | undefined;
  for (const event of events) {
    if (
      event.type !== "pull_scheduled_merge" &&
      event.type !== "pull_cancel_scheduled_merge" &&
      event.type !== "merge_pull"
    ) {
      continue;
    }
    if (latest === undefined || event.id > latest.id) latest = event;
  }
  return latest?.type === "pull_scheduled_merge";
}

export function titleForDraftAction(input: {
  readonly action: Extract<PullRequestAction, "draft" | "ready">;
  readonly title: string;
  readonly isDraft: boolean;
  readonly prefixes: ReadonlyArray<string>;
}): string | null {
  if (input.action === "draft") {
    return input.isDraft ? input.title : titleForDraft(input.title, input.prefixes);
  }
  return input.isDraft ? titleForReady(input.title, input.prefixes) : input.title;
}
