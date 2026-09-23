import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestDiffSide, PullRequestOmittedFileStat } from "@t3tools/contracts";

/**
 * Whether a conversation's line is really in this file's hunks.
 *
 * A thread naming a file is not the same as a thread the diff can show: its line may have moved
 * out of the change, or sit in a hunk the host withheld. Pinning it anyway would put the remark
 * against whatever code now occupies that line number, and silently dropping it would lose the
 * conversation, so the answer decides which of the two lists it belongs in.
 */
export function isLineInFileDiff(
  file: FileDiffMetadata,
  side: PullRequestDiffSide,
  line: number,
): boolean {
  return file.hunks.some((hunk) =>
    side === "left"
      ? line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
  );
}

/**
 * What the toolbar last asked of every file at once. Null is the reader asking nothing yet, which
 * opens what is left to review and keeps what has been ticked off out of the way.
 */
export type DiffFoldOverride = "expanded" | "folded" | null;

/**
 * Files the reader folded or opened by hand, and which way, since the toolbar last spoke. Keyed by
 * path, like viewed state: a file's render key carries its slice's patch hash, so a push to any
 * file in the slice would otherwise drop the choice and fold a viewed file the reader had opened.
 */
export type DiffFoldChoices = ReadonlyMap<string, boolean>;

/**
 * Whether a file is drawn folded.
 *
 * A diff arrives a slice at a time, so the reader's own choices are kept apart from what the
 * toolbar last said rather than as the set of folded files: a file that has not loaded yet has no
 * choice, and follows the toolbar when it lands. A choice records the fold itself, not a flip of
 * the default, so a viewed state that changes underneath it (a push leaving the file stale, a tick
 * on another device) cannot turn the reader's open file into a folded one.
 */
export function isFileDiffCollapsed(
  path: string,
  foldOverride: DiffFoldOverride,
  foldChoices: DiffFoldChoices,
  viewed: boolean,
): boolean {
  return foldChoices.get(path) ?? (foldOverride === "folded" || (foldOverride === null && viewed));
}

/**
 * The reader's fold choices after a file was ticked off, or put back.
 *
 * Clearing a file puts it away and un-clearing brings it back. Where the default already does that,
 * the file's choice is dropped instead of recorded, so the default keeps following the file's
 * viewed state afterwards, and a push that leaves it stale opens it again.
 */
export function foldChoicesAfterViewed(
  path: string,
  viewed: boolean,
  foldOverride: DiffFoldOverride,
  foldChoices: DiffFoldChoices,
): DiffFoldChoices {
  const followsDefault = isFileDiffCollapsed(path, foldOverride, new Map(), viewed) === viewed;
  if (followsDefault ? !foldChoices.has(path) : foldChoices.get(path) === viewed)
    return foldChoices;
  const next = new Map(foldChoices);
  if (followsDefault) next.delete(path);
  else next.set(path, viewed);
  return next;
}

/** One answer from the host: a whole number of files, and where the next one carries on. */
export interface DiffSlice {
  /** What was asked for, null being the first slice. Identifies the slice among the loaded ones. */
  readonly cursor: string | null;
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
}

/**
 * The slices on screen, the scope they belong to, and the one being read. Which pull request the
 * slices belong to travels with them, so a render taken before a reset cannot read the previous
 * one's slices — or send its cursor to the host.
 */
export interface DiffSliceState {
  readonly key: string;
  readonly cursor: string | null;
  readonly slices: ReadonlyArray<DiffSlice>;
  /**
   * The loaded slices are being read again, from the first, after the pull request reported a
   * new revision. Held until the last of them is confirmed, so a failed read along the way —
   * the last slice's included — is still owed a retry.
   */
  readonly revalidating: boolean;
}

function isSameSlice(existing: DiffSlice, next: DiffSlice): boolean {
  return (
    existing.patch === next.patch &&
    existing.truncated === next.truncated &&
    existing.nextCursor === next.nextCursor &&
    existing.omittedFileStats.length === next.omittedFileStats.length &&
    existing.omittedFileStats.every((file, index) => {
      const refreshed = next.omittedFileStats[index];
      return (
        refreshed !== undefined &&
        refreshed.path === file.path &&
        refreshed.additions === file.additions &&
        refreshed.deletions === file.deletions
      );
    })
  );
}

/**
 * Folds one answer for the slice at `slice.cursor` into what is on screen.
 *
 * A new slice is appended. One that came back different means the diff moved under the review,
 * so it replaces the old one and the slices after it go too: their cursors were positions in the
 * old diff. One that came back the same leaves the state alone — unless the loaded slices are
 * being read again, in which case a settled answer hands the cursor to the next one, and ends
 * the walk at the last. The cached answer a read shows while it is still out, or a failed read
 * still carries, confirms nothing, so it does not move the walk.
 */
export function applyDiffSlice(
  previous: DiffSliceState,
  answer: { readonly key: string; readonly slice: DiffSlice; readonly settled: boolean },
): DiffSliceState {
  const { key, slice, settled } = answer;
  const slices = previous.key === key ? previous.slices : [];
  const index = slices.findIndex((candidate) => candidate.cursor === slice.cursor);
  const existing = slices[index];
  if (existing === undefined) {
    return { key, cursor: slice.cursor, slices: [...slices, slice], revalidating: false };
  }
  if (isSameSlice(existing, slice)) {
    if (!settled || !previous.revalidating) return previous;
    const following = slices[index + 1];
    return following === undefined
      ? { ...previous, revalidating: false }
      : { ...previous, cursor: following.cursor };
  }
  return {
    key,
    cursor: slice.cursor,
    slices: [...slices.slice(0, index), slice],
    revalidating: false,
  };
}
