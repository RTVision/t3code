import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { MentionSuggestionsContext } from "../ui/mention-textarea";

export function PullRequestMentionProvider({
  environmentId,
  reference,
  detail,
  children,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView | null;
  children: ReactNode;
}) {
  const [requested, setRequested] = useState(false);
  // These hosts accept @login. Other hosts require identities their actor records do not carry.
  const supported = detail && ["github", "gitea", "gitlab"].includes(detail.provider);
  const loadCandidates =
    supported &&
    requested &&
    detail.capabilities.reviewers.listCandidates &&
    detail.viewerPermissions.requestReviewers;
  const query = useEnvironmentQuery(
    loadCandidates
      ? pullRequestEnvironment.reviewerCandidates({ environmentId, input: reference })
      : null,
  );
  const candidates = useMemo(() => {
    if (!detail) return [];
    return [
      ...(detail.author ? [detail.author] : []),
      ...detail.reviewers,
      ...detail.comments.flatMap((comment) => (comment.author ? [comment.author] : [])),
      ...detail.reviewThreads.flatMap((thread) =>
        thread.comments.flatMap((comment) => (comment.author ? [comment.author] : [])),
      ),
      ...(query.data?.candidates.filter((candidate) => candidate.kind === "user") ?? []),
    ];
  }, [detail, query.data]);
  return (
    <MentionSuggestionsContext
      value={
        supported
          ? {
              candidates,
              onRequest: () => setRequested(true),
              pending: !!loadCandidates && query.isPending,
            }
          : null
      }
    >
      {children}
    </MentionSuggestionsContext>
  );
}
