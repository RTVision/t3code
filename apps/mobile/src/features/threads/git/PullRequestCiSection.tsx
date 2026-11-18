import { m } from "../../../i18n/messages";
import { msg, T, useGT } from "gt-react-native";
import * as Dialog from "../../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PullRequestCiRun,
  PullRequestCiRunInput,
  PullRequestCiRerunTarget,
  PullRequestRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { pullRequestCiEnvironment } from "../../../state/pull-request-ci";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";

function Action({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center px-2 disabled:opacity-40"
    >
      <Text className="text-sm text-primary">{label}</Text>
    </Pressable>
  );
}

function open(url: string) {
  void tryOpenExternalUrl(url, "pull-request").then((opened) => {
    if (!opened) Dialog.alert(m(msg("Unable to open CI details")));
  });
}

function Jobs({
  environmentId,
  input,
  disabled,
  onRerun,
}: {
  environmentId: EnvironmentId;
  input: PullRequestCiRunInput;
  disabled: boolean;
  onRerun: (target: PullRequestCiRerunTarget) => void;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(pullRequestCiEnvironment.ciJobs({ environmentId, input }));
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="text-sm text-danger">
        {query.error}
      </Text>
    );
  if (!query.data)
    return (
      <Text className="text-sm text-muted-foreground">
        <T>Loading jobs…</T>
      </Text>
    );
  return (
    <View className="gap-1 pl-2">
      {query.data.jobs.map((job) => (
        <View key={job.id} className="flex-row items-center">
          <View className="flex-1">
            <Action label={job.name} disabled={!job.url} onPress={() => job.url && open(job.url)} />
            <Text className="text-xs text-muted-foreground">{job.status}</Text>
          </View>
          {job.canRerun && (
            <Action
              label={gt("Rerun job")}
              disabled={disabled || query.isPending}
              onPress={() => onRerun({ kind: "job", jobId: job.id })}
            />
          )}
        </View>
      ))}
      {query.data.truncated && (
        <Text className="text-xs text-muted-foreground">
          <T>More jobs are available on the host.</T>
        </Text>
      )}
      <Text className="text-xs text-muted-foreground">
        <T>Rerunning a job may also rerun dependent jobs.</T>
      </Text>
    </View>
  );
}

function Run({
  environmentId,
  reference,
  headSha,
  run,
  disabled,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  headSha: string;
  run: PullRequestCiRun;
  disabled: boolean;
}) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  const rerun = useAtomCommand(pullRequestCiEnvironment.rerunCi, { reportFailure: false });
  const input = { ...reference, runId: run.id, headSha, attempt: run.attempt };
  const canRerun = useAtomValue(
    pullRequestCiEnvironment.rerunCi.permissionAtom(environmentId, input),
  );
  const submission = useAtomValue(pullRequestCiEnvironment.ciRerunState({ environmentId, input }));
  const pending = submission === "pending";
  const requested = submission === "requested";
  const submit = async (target: PullRequestCiRerunTarget) => {
    if (pending || requested || disabled || !canRerun) return;
    const result = await rerun({ environmentId, input: { ...input, target } });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        gt("Unable to rerun CI"),
        error instanceof Error ? error.message : gt("The host refused the rerun."),
      );
    }
  };
  return (
    <View className="gap-1 rounded-xl border border-border p-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-11 justify-center"
      >
        <Text className="font-t3-bold text-foreground">{run.name}</Text>
      </Pressable>
      <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
        {pending ? gt("Requesting rerun…") : requested ? gt("Rerun requested") : run.status}
      </Text>
      <View className="flex-row flex-wrap">
        {run.url && <Action label={gt("Open run")} onPress={() => open(run.url!)} />}
        {run.rerunModes.map((kind) => (
          <Action
            key={kind}
            label={kind === "all" ? gt("Rerun all") : gt("Rerun failed")}
            disabled={disabled || pending || requested || !canRerun}
            onPress={() => void submit({ kind })}
          />
        ))}
      </View>
      {expanded && (
        <Jobs
          environmentId={environmentId}
          input={input}
          disabled={disabled || pending || requested || !canRerun}
          onRerun={(target) => void submit(target)}
        />
      )}
    </View>
  );
}

function Runs({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    pullRequestCiEnvironment.ciRuns({ environmentId, input: reference }),
  );
  const invalidate = useAtomCommand(pullRequestCiEnvironment.invalidate);
  return (
    <View className="gap-2">
      <Action
        label={gt("Refresh CI")}
        disabled={query.isPending}
        onPress={() => {
          void invalidate({ environmentId, input: { reference } });
        }}
      />
      {query.error && (
        <Text accessibilityRole="alert" className="text-sm text-danger">
          {query.error}
        </Text>
      )}
      {query.data ? (
        <>
          {query.data.runs.map((run) => (
            <Run
              key={`${query.data!.headSha}:${run.id}:${run.attempt}`}
              environmentId={environmentId}
              reference={reference}
              headSha={query.data!.headSha}
              run={run}
              disabled={query.isPending || query.error !== null}
            />
          ))}
          {query.data.runs.length === 0 && (
            <Text className="text-sm text-muted-foreground">
              <T>No CI runs for this revision.</T>
            </Text>
          )}
          {query.data.truncated && (
            <Text className="text-xs text-muted-foreground">
              <T>More runs are available on the host.</T>
            </Text>
          )}
        </>
      ) : query.isPending ? (
        <Text className="text-sm text-muted-foreground">
          <T>Loading CI runs…</T>
        </Text>
      ) : null}
    </View>
  );
}

function Checks({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
}) {
  const query = useEnvironmentQuery(
    pullRequestCiEnvironment.detail({ environmentId, input: reference }),
  );
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="text-sm text-danger">
        {query.error}
      </Text>
    );
  if (!query.data)
    return (
      <Text className="text-sm text-muted-foreground">
        <T>Loading checks…</T>
      </Text>
    );
  return (
    <View className="gap-2">
      {query.data.capabilities.ciRuns ? (
        <Runs environmentId={environmentId} reference={reference} />
      ) : null}
      {query.data.checks.map((check) => (
        <View key={`${check.name}:${check.url ?? ""}`}>
          <Action
            label={check.name}
            disabled={!check.url}
            onPress={() => check.url && open(check.url)}
          />
          <Text className="text-xs text-muted-foreground">{check.status}</Text>
        </View>
      ))}
      {!query.data.capabilities.ciRuns && query.data.checks.length === 0 && (
        <Text className="text-sm text-muted-foreground">
          <T>No checks reported.</T>
        </Text>
      )}
    </View>
  );
}

export function PullRequestCiSection({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="rounded-2xl border border-border bg-card p-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-11 justify-center"
      >
        <Text className="font-t3-bold text-foreground">
          <T>CI runs and checks</T>
        </Text>
      </Pressable>
      {expanded && <Checks environmentId={environmentId} reference={reference} />}
    </View>
  );
}
