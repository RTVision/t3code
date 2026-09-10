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
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
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
    if (!opened) Alert.alert("Unable to open CI details");
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
  const query = useEnvironmentQuery(pullRequestCiEnvironment.ciJobs({ environmentId, input }));
  if (query.error)
    return (
      <Text accessibilityRole="alert" className="text-sm text-danger">
        {query.error}
      </Text>
    );
  if (!query.data) return <Text className="text-sm text-muted-foreground">Loading jobs…</Text>;
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
              label="Rerun job"
              disabled={disabled || query.isPending}
              onPress={() => onRerun({ kind: "job", jobId: job.id })}
            />
          )}
        </View>
      ))}
      {query.data.truncated && (
        <Text className="text-xs text-muted-foreground">More jobs are available on the host.</Text>
      )}
      <Text className="text-xs text-muted-foreground">
        Rerunning a job may also rerun dependent jobs.
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
  const [expanded, setExpanded] = useState(false);
  const rerun = useAtomCommand(pullRequestCiEnvironment.rerunCi, { reportFailure: false });
  const input = { ...reference, runId: run.id, headSha, attempt: run.attempt };
  const submission = useAtomValue(pullRequestCiEnvironment.ciRerunState({ environmentId, input }));
  const pending = submission === "pending";
  const requested = submission === "requested";
  const submit = async (target: PullRequestCiRerunTarget) => {
    if (pending || requested || disabled) return;
    const result = await rerun({ environmentId, input: { ...input, target } });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      Alert.alert(
        "Unable to rerun CI",
        error instanceof Error ? error.message : "The host refused the rerun.",
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
        {pending ? "Requesting rerun…" : requested ? "Rerun requested" : run.status}
      </Text>
      <View className="flex-row flex-wrap">
        {run.url && <Action label="Open run" onPress={() => open(run.url!)} />}
        {run.rerunModes.map((kind) => (
          <Action
            key={kind}
            label={kind === "all" ? "Rerun all" : "Rerun failed"}
            disabled={disabled || pending || requested}
            onPress={() => void submit({ kind })}
          />
        ))}
      </View>
      {expanded && (
        <Jobs
          environmentId={environmentId}
          input={input}
          disabled={disabled || pending || requested}
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
  const query = useEnvironmentQuery(
    pullRequestCiEnvironment.ciRuns({ environmentId, input: reference }),
  );
  const invalidate = useAtomCommand(pullRequestCiEnvironment.invalidate);
  return (
    <View className="gap-2">
      <Action
        label="Refresh CI"
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
            <Text className="text-sm text-muted-foreground">No CI runs for this revision.</Text>
          )}
          {query.data.truncated && (
            <Text className="text-xs text-muted-foreground">
              More runs are available on the host.
            </Text>
          )}
        </>
      ) : query.isPending ? (
        <Text className="text-sm text-muted-foreground">Loading CI runs…</Text>
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
  if (!query.data) return <Text className="text-sm text-muted-foreground">Loading checks…</Text>;
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
        <Text className="text-sm text-muted-foreground">No checks reported.</Text>
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
        <Text className="font-t3-bold text-foreground">CI runs and checks</Text>
      </Pressable>
      {expanded && <Checks environmentId={environmentId} reference={reference} />}
    </View>
  );
}
