import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PullRequestCiRun,
  PullRequestCiRerunTarget,
  PullRequestCiRunInput,
  PullRequestRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";
import { PullRequestCheckStatusIcon, pullRequestCheckStatusLabel } from "./pullRequestPresentation";

function CiJobs({
  environmentId,
  input,
  disabled,
  onRerun,
  openLink,
}: {
  environmentId: EnvironmentId;
  input: PullRequestCiRunInput;
  disabled: boolean;
  onRerun: (target: PullRequestCiRerunTarget) => void;
  openLink: (url: string) => void;
}) {
  const query = useEnvironmentQuery(pullRequestEnvironment.ciJobs({ environmentId, input }));
  if (query.error)
    return (
      <p role="alert" className="text-xs text-destructive">
        {query.error}
      </p>
    );
  if (!query.data) return <p className="text-xs text-muted-foreground">Loading jobs…</p>;
  return (
    <div className="space-y-1 pl-3">
      {query.data.jobs.map((job) => (
        <div key={job.id} className="flex items-center gap-2 text-xs">
          <PullRequestCheckStatusIcon status={job.status} />
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left hover:underline"
            disabled={!job.url}
            onClick={() => job.url && openLink(job.url)}
          >
            {job.name}
          </button>
          <span className="text-muted-foreground">{pullRequestCheckStatusLabel(job)}</span>
          {job.canRerun && (
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled || query.isPending}
              title="Rerun this job and dependent jobs"
              onClick={() => onRerun({ kind: "job", jobId: job.id })}
            >
              Rerun
            </Button>
          )}
        </div>
      ))}
      {query.data.jobs.length === 0 && (
        <p className="text-xs text-muted-foreground">No jobs reported.</p>
      )}
      {query.data.truncated && (
        <p className="text-xs text-muted-foreground">More jobs are available on the host.</p>
      )}
    </div>
  );
}

function CiRunRow({
  environmentId,
  reference,
  headSha,
  run,
  openLink,
  disabled,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  headSha: string;
  run: PullRequestCiRun;
  openLink: (url: string) => void;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const rerun = useAtomCommand(pullRequestEnvironment.rerunCi, { reportFailure: false });
  const input = { ...reference, runId: run.id, headSha, attempt: run.attempt };
  const submission = useAtomValue(pullRequestEnvironment.ciRerunState({ environmentId, input }));
  const pending = submission === "pending";
  const requested = submission === "requested";
  const submit = async (target: PullRequestCiRerunTarget) => {
    if (pending || requested || disabled) return;
    const result = await rerun({ environmentId, input: { ...input, target } });
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title: "Unable to rerun CI",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused the rerun.",
        ),
      });
  };
  return (
    <div className="space-y-2 rounded border p-2">
      <div className="flex items-center gap-2 text-xs">
        <PullRequestCheckStatusIcon status={run.status} />
        <button
          type="button"
          aria-expanded={expanded}
          className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
          onClick={() => setExpanded(!expanded)}
        >
          {run.name}
        </button>
        {run.url && (
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => openLink(run.url!)}
          >
            Open
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span role="status" className="mr-auto text-muted-foreground">
          {pending
            ? "Requesting rerun…"
            : requested
              ? "Rerun requested"
              : pullRequestCheckStatusLabel(run)}
        </span>
        {run.rerunModes.map((kind) => (
          <Button
            key={kind}
            size="xs"
            variant="ghost"
            disabled={disabled || pending || requested}
            onClick={() => void submit({ kind })}
          >
            {kind === "failed" ? "Rerun failed" : "Rerun all"}
          </Button>
        ))}
      </div>
      {expanded && (
        <CiJobs
          environmentId={environmentId}
          input={input}
          disabled={disabled || pending || requested}
          onRerun={(target) => void submit(target)}
          openLink={openLink}
        />
      )}
    </div>
  );
}

/** Mounted only in an open checks popup or PR summary. */
export function PullRequestCiRuns({
  environmentId,
  reference,
  threadRef = null,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  threadRef?: ScopedThreadRef | null;
}) {
  const query = useEnvironmentQuery(
    pullRequestEnvironment.ciRuns({ environmentId, input: reference }),
  );
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate);
  const open = useOpenLink(threadRef);
  const openLink = (url: string) => {
    void open(url).catch(() =>
      toastManager.add({ type: "error", title: "Unable to open CI details" }),
    );
  };
  return (
    <section className="mt-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium">CI runs</h3>
        <Button
          size="xs"
          variant="ghost"
          disabled={query.isPending}
          onClick={() => {
            void invalidate({ environmentId, input: { reference } });
          }}
        >
          Refresh CI
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="text-xs text-destructive">
          {query.error}
        </p>
      ) : null}
      {query.data ? (
        <>
          {query.data.runs.map((run) => (
            <CiRunRow
              key={`${query.data!.headSha}:${run.id}:${run.attempt}`}
              environmentId={environmentId}
              reference={reference}
              headSha={query.data!.headSha}
              run={run}
              openLink={openLink}
              disabled={query.isPending || query.error !== null}
            />
          ))}
          {query.data.runs.length === 0 && (
            <p className="text-xs text-muted-foreground">No CI runs for this revision.</p>
          )}
          {query.data.truncated && (
            <p className="text-xs text-muted-foreground">
              Showing the most recent runs. More are available on the host.
            </p>
          )}
        </>
      ) : query.isPending ? (
        <p className="text-xs text-muted-foreground">Loading CI runs…</p>
      ) : null}
    </section>
  );
}
