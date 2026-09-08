import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";

import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

export function PullRequestsUnavailableState({
  title = "Could not load pull requests",
  error,
  onRetry,
  browserUrl,
  refreshing = false,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
  browserUrl?: string;
  refreshing?: boolean;
}) {
  return (
    <Empty className="px-4 py-16 md:px-4">
      <EmptyMedia variant="icon">
        <GitPullRequestIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {/* The caller names the fix — update the environment, install gh, sign in — so this
            shows its message rather than trying to infer one from the failure text. */}
        <EmptyDescription>{error}</EmptyDescription>
      </EmptyHeader>
      {onRetry || browserUrl ? (
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              <RefreshIcon className="size-3.5" refreshing={refreshing} />
              Retry
            </Button>
          ) : null}
          {browserUrl ? (
            <Button
              size="sm"
              variant="outline"
              render={<a href={browserUrl} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              Open in browser
            </Button>
          ) : null}
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
