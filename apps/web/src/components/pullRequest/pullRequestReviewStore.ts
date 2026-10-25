import type { PullRequestRef, PullRequestReviewCommentDraft } from "@t3tools/contracts";
import { create } from "zustand";

export type PendingReviewComment = PullRequestReviewCommentDraft & { readonly id: string };

// Content-derived ids can collide across comments; use a counter.
let pendingCommentSequence = 0;

export function nextPendingReviewCommentId(): string {
  pendingCommentSequence += 1;
  return `pending-review-comment-${pendingCommentSequence}`;
}

export function pullRequestReviewKey(reference: PullRequestRef): string {
  return JSON.stringify([
    reference.projectId,
    reference.host?.toLowerCase() ?? null,
    reference.repository.toLowerCase(),
    reference.number,
  ]);
}

interface PullRequestReviewStoreState {
  readonly drafts: Readonly<Record<string, ReadonlyArray<PendingReviewComment>>>;
  readonly summaries: Readonly<Record<string, string>>;
  readonly addComment: (key: string, comment: PendingReviewComment) => void;
  readonly updateComment: (key: string, commentId: string, body: string) => void;
  readonly removeComment: (key: string, commentId: string) => void;
  /** Removes the comments a review sent, keeping any rewritten since that snapshot was taken. */
  readonly removeComments: (key: string, submitted: ReadonlyArray<PendingReviewComment>) => void;
  readonly clear: (key: string) => void;
  readonly setSummary: (key: string, body: string) => void;
  readonly clearSummary: (key: string, submittedBody: string) => void;
}

const EMPTY: ReadonlyArray<PendingReviewComment> = [];

export const usePullRequestReviewStore = create<PullRequestReviewStoreState>()((set) => ({
  drafts: {},
  summaries: {},
  addComment: (key, comment) =>
    set((state) => ({
      drafts: { ...state.drafts, [key]: [...(state.drafts[key] ?? EMPTY), comment] },
    })),
  updateComment: (key, commentId, body) =>
    set((state) => {
      const comments = state.drafts[key];
      if (!comments?.some((entry) => entry.id === commentId)) return state;
      return {
        drafts: {
          ...state.drafts,
          [key]: comments.map((entry) => (entry.id === commentId ? { ...entry, body } : entry)),
        },
      };
    }),
  removeComment: (key, commentId) =>
    set((state) => {
      const remaining = (state.drafts[key] ?? EMPTY).filter((entry) => entry.id !== commentId);
      if (remaining.length > 0) return { drafts: { ...state.drafts, [key]: remaining } };
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  removeComments: (key, submitted) =>
    set((state) => {
      const sentBodies = new Map(submitted.map((comment) => [comment.id, comment.body]));
      const remaining = (state.drafts[key] ?? EMPTY).filter(
        (entry) => sentBodies.get(entry.id) !== entry.body,
      );
      if (remaining.length > 0) return { drafts: { ...state.drafts, [key]: remaining } };
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  clear: (key) =>
    set((state) => {
      const { [key]: _removed, ...rest } = state.drafts;
      return { drafts: rest };
    }),
  setSummary: (key, body) => set((state) => ({ summaries: { ...state.summaries, [key]: body } })),
  clearSummary: (key, submittedBody) =>
    set((state) => {
      // Keep summary edits made during submission; the textarea stays editable.
      if (state.summaries[key] !== submittedBody) return state;
      const { [key]: _removed, ...rest } = state.summaries;
      return { summaries: rest };
    }),
}));

export function usePendingReviewComments(
  reference: PullRequestRef,
): ReadonlyArray<PendingReviewComment> {
  return usePullRequestReviewStore(
    (store) => store.drafts[pullRequestReviewKey(reference)] ?? EMPTY,
  );
}
