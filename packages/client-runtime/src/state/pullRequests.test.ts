import {
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type PullRequestRefresh,
  type PullRequestRef,
  type PullRequestStack,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
  createPullRequestCiEnvironmentAtoms,
} from "./pullRequests.ts";
import { PullRequestDiffLoader } from "./pullRequestDiffHttp.ts";
import { executeAtomQuery } from "./runtime.ts";

class MutationRefused extends Data.TaggedError("MutationRefused") {}

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

// With --execArgv=--expose-gc, stress atom identity between turns when WeakRefs can clear.
const collectGarbage = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      const testRuntime = globalThis as typeof globalThis & {
        setImmediate: (callback: () => void) => void;
        gc?: () => void;
      };
      testRuntime.setImmediate(() => {
        testRuntime.gc?.();
        resolve();
      });
    }),
);

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeTestRuntime = Effect.fn("makeTestRuntime")(function* (client: WsRpcProtocolClient) {
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        PullRequestDiffLoader,
        PullRequestDiffLoader.of({ load: () => Effect.die("unused") }),
      ),
    ),
  );
  const atoms = createPullRequestEnvironmentAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { runtime, atoms, ciAtoms: createPullRequestCiEnvironmentAtoms(runtime), registry };
});

it.effect("keeps concurrent diff file reads on different hosts separate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = yield* Latch.make();
      const started = yield* Latch.make();
      const calls: string[] = [];
      const client = {
        [WS_METHODS.pullRequestsDiffFileContents]: (input: { readonly host: string }) =>
          Effect.gen(function* () {
            calls.push(input.host);
            yield* started.open;
            yield* release.await;
            return { oldContents: "", newContents: input.host };
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const input = {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 1,
        changeType: "change",
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
      } as const;
      const first = atoms.diffFileContents.run(registry, {
        environmentId: TARGET.environmentId,
        input: { ...input, host: "github.com" },
      });
      yield* started.await;
      const second = atoms.diffFileContents.run(registry, {
        environmentId: TARGET.environmentId,
        input: { ...input, host: "github.example.com" },
      });
      yield* release.open;

      const results = yield* Effect.promise(() => Promise.all([first, second]));
      expect(results).toMatchObject([
        { _tag: "Success", value: { newContents: "github.com" } },
        { _tag: "Success", value: { newContents: "github.example.com" } },
      ]);
      expect(calls).toEqual(["github.com", "github.example.com"]);
    }),
  ),
);

it.effect(
  "refreshes runs, expanded jobs, and mobile checks after another client requests a rerun",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reference = {
          projectId: ProjectId.make("project-1"),
          host: "forge.test",
          repository: "acme/web",
          number: 1,
        };
        const events = yield* PubSub.unbounded<PullRequestRefresh>();
        const subscribed = Latch.makeUnsafe();
        let subscriptions = 0;
        let attempt = 1;
        const client = {
          [WS_METHODS.pullRequestsSubscribeRefreshes]: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                const subscription = yield* PubSub.subscribe(events);
                subscriptions += 1;
                subscribed.openUnsafe();
                return Stream.fromSubscription(subscription);
              }),
            ),
          [WS_METHODS.pullRequestsCiRuns]: () =>
            Effect.sync(() => ({
              headSha: "head",
              truncated: false,
              runs: [
                {
                  id: "12",
                  name: "CI",
                  url: null,
                  status: attempt === 1 ? "failure" : "pending",
                  attempt,
                  rerunModes: [],
                },
              ],
            })),
          [WS_METHODS.pullRequestsCiJobs]: () =>
            Effect.sync(() => ({
              truncated: false,
              jobs: [
                {
                  id: "93",
                  name: "CI",
                  url: null,
                  status: attempt === 1 ? "failure" : "pending",
                  canRerun: false,
                },
              ],
            })),
          [WS_METHODS.pullRequestsDetail]: () =>
            Effect.sync(() => ({
              checks: [{ name: "CI", status: attempt === 1 ? "failure" : "pending", url: null }],
            })),
        } as unknown as WsRpcProtocolClient;
        const { ciAtoms: atoms, registry } = yield* makeTestRuntime(client);
        const runs = atoms.ciRuns({ environmentId: TARGET.environmentId, input: reference });
        const jobs = atoms.ciJobs({
          environmentId: TARGET.environmentId,
          input: { ...reference, runId: "12", headSha: "head", attempt: 1 },
        });
        const detail = atoms.detail({ environmentId: TARGET.environmentId, input: reference });
        const mounted: ReadonlyArray<Atom.Atom<unknown>> = [runs, jobs, detail];
        for (const atom of mounted) {
          const unmount = registry.mount(atom);
          yield* Effect.addFinalizer(() => Effect.sync(unmount));
        }
        const initial = yield* Effect.promise(() => executeAtomQuery(registry, runs));
        expect(AsyncResult.isSuccess(initial)).toBe(true);
        yield* AtomRegistry.getResult(registry, jobs);
        yield* AtomRegistry.getResult(registry, detail);
        yield* subscribed.await;
        const refreshed = Latch.makeUnsafe();
        const stop = registry.subscribe(runs, (result) => {
          if (AsyncResult.isSuccess(result) && result.value.runs[0]?.attempt === 2)
            refreshed.openUnsafe();
        });
        yield* Effect.addFinalizer(() => Effect.sync(stop));
        const jobsRefreshed = Latch.makeUnsafe();
        const detailRefreshed = Latch.makeUnsafe();
        const stopJobs = registry.subscribe(jobs, (result) => {
          if (AsyncResult.isSuccess(result) && result.value.jobs[0]?.status === "pending")
            jobsRefreshed.openUnsafe();
        });
        const stopDetail = registry.subscribe(detail, (result) => {
          if (AsyncResult.isSuccess(result) && result.value.checks[0]?.status === "pending")
            detailRefreshed.openUnsafe();
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            stopJobs();
            stopDetail();
          }),
        );
        attempt = 2;
        yield* PubSub.publish(events, { revision: 1, reference, listings: true });
        yield* refreshed.await;
        yield* jobsRefreshed.await;
        yield* detailRefreshed.await;
        expect(subscriptions).toBe(1);
        expect((yield* AtomRegistry.getResult(registry, runs)).runs[0]?.status).toBe("pending");
      }),
    ),
);

for (const nextStatus of ["pending", "failure"] as const) {
  it.effect(
    `shares rerun submission state across views and clears it on a fresh ${nextStatus} response without an attempt change`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const reference = {
            projectId: ProjectId.make("project-1"),
            host: "forge.test",
            repository: "acme/web",
            number: 1,
          };
          const target = {
            environmentId: TARGET.environmentId,
            input: { ...reference, runId: "12", headSha: "head", attempt: 0 },
          };
          const events = yield* PubSub.unbounded<PullRequestRefresh>();
          const subscribed = Latch.makeUnsafe();
          const started = Latch.makeUnsafe();
          const finish = Latch.makeUnsafe();
          let writes = 0;
          let status: "pending" | "failure" = "failure";
          const client = {
            [WS_METHODS.pullRequestsSubscribeRefreshes]: () =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const subscription = yield* PubSub.subscribe(events);
                  subscribed.openUnsafe();
                  return Stream.fromSubscription(subscription);
                }),
              ),
            [WS_METHODS.pullRequestsCiRuns]: () =>
              Effect.sync(() => ({
                headSha: "head",
                truncated: false,
                runs: [
                  {
                    id: "12",
                    name: "CI",
                    url: null,
                    status,
                    attempt: 0,
                    rerunModes: status === "failure" ? ["all", "failed"] : [],
                  },
                ],
              })),
            [WS_METHODS.pullRequestsRerunCi]: () =>
              Effect.gen(function* () {
                writes += 1;
                started.openUnsafe();
                yield* finish.await;
              }),
          } as unknown as WsRpcProtocolClient;
          const { atoms, registry } = yield* makeTestRuntime(client);
          const runs = atoms.ciRuns({
            environmentId: target.environmentId,
            input: {
              number: reference.number,
              repository: reference.repository,
              projectId: reference.projectId,
              host: reference.host,
            },
          });
          const state = atoms.ciRerunState(target);
          const otherHost = atoms.ciRerunState({
            ...target,
            input: { ...target.input, host: "another.test" },
          });
          const { number, ...otherInput } = target.input;
          const otherView = atoms.ciRerunState({ ...target, input: { number, ...otherInput } });
          const unmountRuns = registry.mount(runs);
          const unmountState = registry.mount(state);
          const unmountOther = registry.mount(otherView);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              unmountRuns();
              unmountState();
              unmountOther();
            }),
          );
          yield* AtomRegistry.getResult(registry, runs);
          yield* subscribed.await;
          yield* collectGarbage;
          const first = atoms.rerunCi.run(registry, {
            ...target,
            input: { ...target.input, target: { kind: "all" } },
          });
          yield* started.await;
          expect(registry.get(otherView)).toBe("pending");
          expect(registry.get(otherHost)).toBe("idle");
          yield* collectGarbage;
          yield* Effect.promise(() =>
            atoms.rerunCi.run(registry, {
              ...target,
              input: { ...target.input, target: { kind: "failed" } },
            }),
          );
          expect(writes).toBe(1);
          const beforeRefresh = yield* AtomRegistry.getResult(registry, runs);
          const refreshedWhilePending = Latch.makeUnsafe();
          const stopPendingRefresh = registry.subscribe(runs, (result) => {
            if (AsyncResult.isSuccess(result) && !result.waiting && result.value !== beforeRefresh)
              refreshedWhilePending.openUnsafe();
          });
          yield* Effect.addFinalizer(() => Effect.sync(stopPendingRefresh));
          yield* PubSub.publish(events, { revision: 1, reference, listings: true });
          yield* refreshedWhilePending.await;
          expect(registry.get(otherView)).toBe("pending");
          finish.openUnsafe();
          const result = yield* Effect.promise(() => first);
          expect(result._tag).toBe("Success");
          expect(registry.get(state)).toBe("requested");
          expect(registry.get(otherView)).toBe("requested");
          yield* Effect.promise(() =>
            atoms.rerunCi.run(registry, {
              ...target,
              input: { ...target.input, target: { kind: "all" } },
            }),
          );
          expect(writes).toBe(1);
          const refreshed = Latch.makeUnsafe();
          const stop = registry.subscribe(state, (phase) => {
            if (phase === "idle") refreshed.openUnsafe();
          });
          yield* Effect.addFinalizer(() => Effect.sync(stop));
          status = nextStatus;
          yield* PubSub.publish(events, { revision: 2, reference, listings: true });
          yield* refreshed.await;
          expect(registry.get(otherView)).toBe("idle");
          expect((yield* AtomRegistry.getResult(registry, runs)).runs[0]?.status).toBe(nextStatus);
        }),
      ),
  );
}

it.effect("refreshes pull request activity after a comment is updated", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number>();
      let commentBody = "old comment";
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsActivity]: () =>
          Effect.succeed({
            author: null,
            reviewers: [],
            comments: [
              {
                id: "comment-1",
                kind: "issue-comment",
                author: null,
                body: commentBody,
                createdAt: "2026-08-24T00:00:00Z",
                url: null,
                path: null,
                reviewState: null,
                reactions: [],
              },
            ],
            commentCount: 1,
            commentsTruncated: false,
            reviewThreads: [],
            commits: [],
            reactions: [],
          }),
        [WS_METHODS.pullRequestsUpdateComment]: (input: { readonly body: string }) =>
          Effect.sync(() => {
            commentBody = input.body;
          }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const reference = {
        projectId: ProjectId.make("project-1"),
        host: "github.example.com",
        repository: "acme/web",
        number: 1,
      } as const;
      const activity = atoms.activity({ environmentId: TARGET.environmentId, input: reference });
      const unmount = registry.mount(activity);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));

      const initial = yield* Effect.promise(() => executeAtomQuery(registry, activity));
      expect(AsyncResult.isSuccess(initial)).toBe(true);
      if (!AsyncResult.isSuccess(initial)) {
        return yield* Effect.die("activity did not load");
      }
      expect(initial.value.comments[0]?.body).toBe("old comment");

      const update = yield* Effect.promise(() =>
        atoms.updateComment.run(registry, {
          environmentId: TARGET.environmentId,
          input: { ...reference, commentId: "comment-1", kind: "issue-comment", body: "updated" },
        }),
      );

      expect(AsyncResult.isSuccess(update)).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true })).comments[0]
          ?.body,
      ).toBe("updated");
      const refreshed = Latch.makeUnsafe();
      const stop = registry.subscribe(activity, (result) => {
        if (AsyncResult.isSuccess(result) && result.value.comments[0]?.body === "after turn") {
          refreshed.openUnsafe();
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));

      commentBody = "after turn";
      yield* PubSub.publish(refreshEvents, 1);
      yield* refreshed.await;

      expect(
        (yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true })).comments[0]
          ?.body,
      ).toBe("after turn");
    }),
  ),
);

it.effect(
  "scoped refreshes update matching clients without re-fetching unrelated active repositories",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const refreshEvents = yield* PubSub.unbounded<PullRequestRefresh>();
        const subscribed = Latch.makeUnsafe();
        let revision = 0;
        const activityReads = new Map<string, number>();
        const listReads = new Map<string, number>();
        const reference = {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
        };
        const sibling = {
          ...reference,
          projectId: ProjectId.make("sibling"),
          repository: "Acme/Web",
        };
        const unrelated = {
          ...reference,
          projectId: ProjectId.make("project-2"),
          repository: "acme/api",
        };
        const client = {
          [WS_METHODS.pullRequestsSubscribeRefreshes]: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                const subscription = yield* PubSub.subscribe(refreshEvents);
                subscribed.openUnsafe();
                return Stream.fromSubscription(subscription);
              }),
            ),
          [WS_METHODS.pullRequestsActivity]: (input: PullRequestRef) =>
            Effect.sync(() => {
              activityReads.set(input.projectId, (activityReads.get(input.projectId) ?? 0) + 1);
              return {
                author: null,
                reviewers: [],
                comments: [],
                commentCount: revision,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
                reactions: [],
              };
            }),
          [WS_METHODS.pullRequestsList]: (input: { projectId: string }) =>
            Effect.sync(() => {
              listReads.set(input.projectId, (listReads.get(input.projectId) ?? 0) + 1);
              return {
                entries: [],
                providers: [],
                viewers: {},
                errors: [],
                truncated: false,
                nextCursors: {},
              };
            }),
        } as unknown as WsRpcProtocolClient;
        const { atoms, registry } = yield* makeTestRuntime(client);
        const activityAtoms = [reference, sibling, unrelated].map((input) =>
          atoms.activity({ environmentId: TARGET.environmentId, input }),
        );
        const listAtoms = [reference, unrelated].map((input) =>
          atoms.list({
            environmentId: TARGET.environmentId,
            input: { state: "open", projectId: input.projectId },
          }),
        );
        for (const atom of [...activityAtoms, ...listAtoms]) {
          const unmount = registry.mount<unknown>(atom);
          yield* Effect.addFinalizer(() => Effect.sync(unmount));
        }
        for (const atom of activityAtoms)
          yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        for (const atom of listAtoms)
          yield* AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        yield* subscribed.await;
        const beforeActivity = new Map(activityReads);
        const beforeLists = new Map(listReads);
        const updated = [Latch.makeUnsafe(), Latch.makeUnsafe()];
        for (const [index, atom] of activityAtoms.slice(0, 2).entries()) {
          const stop = registry.subscribe(atom, (result) => {
            if (AsyncResult.isSuccess(result) && result.value.commentCount === 1)
              updated[index]!.openUnsafe();
          });
          yield* Effect.addFinalizer(() => Effect.sync(stop));
        }
        revision = 1;
        yield* PubSub.publish(refreshEvents, {
          revision,
          reference,
          projectIds: [reference.projectId, sibling.projectId],
          listings: false,
        });
        for (const latch of updated) yield* latch.await;
        expect(activityReads.get(reference.projectId)).toBe(
          beforeActivity.get(reference.projectId)! + 1,
        );
        expect(activityReads.get(sibling.projectId)).toBe(
          beforeActivity.get(sibling.projectId)! + 1,
        );
        expect(activityReads.get(unrelated.projectId)).toBe(
          beforeActivity.get(unrelated.projectId),
        );
        expect(listReads).toEqual(beforeLists);

        const listed = Latch.makeUnsafe();
        const stop = registry.subscribe(listAtoms[0]!, (result) => {
          if (
            AsyncResult.isSuccess(result) &&
            listReads.get(reference.projectId) === beforeLists.get(reference.projectId)! + 1
          )
            listed.openUnsafe();
        });
        yield* Effect.addFinalizer(() => Effect.sync(stop));
        const burstUpdated = [Latch.makeUnsafe(), Latch.makeUnsafe()];
        for (const [index, atom] of [activityAtoms[0]!, activityAtoms[2]!].entries()) {
          const stopActivity = registry.subscribe(atom, (result) => {
            if (AsyncResult.isSuccess(result) && result.value.commentCount === 2) {
              burstUpdated[index]!.openUnsafe();
            }
          });
          yield* Effect.addFinalizer(() => Effect.sync(stopActivity));
        }
        revision = 2;
        // One chunk must retain both repositories and the earlier listing invalidation even
        // when a later reaction on that reference does not affect listings.
        yield* PubSub.publishAll(refreshEvents, [
          {
            revision: 2,
            reference,
            projectIds: [reference.projectId, sibling.projectId],
            listings: true,
          },
          {
            revision: 3,
            reference,
            projectIds: [reference.projectId, sibling.projectId],
            listings: false,
          },
          { revision: 4, reference: unrelated, listings: false },
        ]);
        yield* listed.await;
        for (const latch of burstUpdated) yield* latch.await;
        expect(listReads.get(unrelated.projectId)).toBe(beforeLists.get(unrelated.projectId));
        expect(activityReads.get(reference.projectId)).toBe(
          beforeActivity.get(reference.projectId)! + 2,
        );
        expect(activityReads.get(unrelated.projectId)).toBe(
          beforeActivity.get(unrelated.projectId)! + 1,
        );
      }),
    ),
);

it.effect("updates cached labels after successful edits without rereading the host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let detailReads = 0;
      let candidateReads = 0;
      let refuse = false;
      let failDetail = false;
      const existing = { name: "existing", color: "111111" };
      const addedLabel = { name: "new", color: "abcdef" };
      const detailRefreshStarted = yield* Latch.make();
      const releaseDetailRefresh = yield* Latch.make();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.gen(function* () {
            detailReads++;
            if (failDetail) {
              yield* detailRefreshStarted.open;
              yield* releaseDetailRefresh.await;
              return yield* Effect.fail(new MutationRefused());
            }
            return { title: "keep this title", labels: [existing] };
          }),
        [WS_METHODS.pullRequestsLabelCandidates]: () =>
          Effect.sync(() => {
            candidateReads++;
            return {
              candidates: [
                { ...existing, description: null, isApplied: true },
                { ...addedLabel, description: "description", isApplied: false },
              ],
              truncated: false,
            };
          }),
        [WS_METHODS.pullRequestsSetLabels]: () =>
          refuse ? Effect.fail(new MutationRefused()) : Effect.void,
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
          host: "github.example.com",
        },
      };
      const detail = atoms.detail(target);
      const candidates = atoms.labelCandidates(target);
      registry.mount(detail);
      const unmountCandidates = registry.mount(candidates);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, candidates, { suspendOnWaiting: true });

      const added = yield* Effect.promise(() =>
        atoms.setLabels.run(registry, {
          ...target,
          input: {
            host: target.input.host,
            projectId: target.input.projectId,
            repository: target.input.repository,
            number: target.input.number,
            labels: ["new"],
            applied: true,
          },
        }),
      );
      expect(AsyncResult.isSuccess(added)).toBe(true);
      expect(yield* AtomRegistry.getResult(registry, detail)).toEqual({
        title: "keep this title",
        labels: [existing, addedLabel],
      });
      unmountCandidates();
      registry.mount(atoms.labelCandidates(target));
      expect((yield* AtomRegistry.getResult(registry, candidates)).candidates[1]).toEqual({
        ...addedLabel,
        description: "description",
        isApplied: true,
      });

      for (const name of ["existing", "new"]) {
        refuse = name === "new";
        const result = yield* Effect.promise(() =>
          atoms.setLabels.run(registry, {
            ...target,
            input: { ...target.input, labels: [name], applied: false },
          }),
        );
        expect(result._tag).toBe(refuse ? "Failure" : "Success");
        expect((yield* AtomRegistry.getResult(registry, detail)).labels).toEqual([addedLabel]);
        expect((yield* AtomRegistry.getResult(registry, candidates)).candidates).toMatchObject([
          { name: "existing", isApplied: false },
          { name: "new", isApplied: true },
        ]);
      }
      expect(detailReads).toBe(1);
      expect(candidateReads).toBe(1);

      failDetail = true;
      registry.refresh(detail);
      yield* detailRefreshStarted.await;
      expect(registry.get(detail).waiting).toBe(true);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).labels).toEqual([
        addedLabel,
      ]);
      yield* releaseDetailRefresh.open;
      yield* Effect.exit(AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true }));
      expect(AsyncResult.isFailure(registry.get(detail))).toBe(true);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(detail))).labels).toEqual([
        addedLabel,
      ]);
      failDetail = false;
      registry.refresh(detail);
      expect(
        (yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true })).labels,
      ).toEqual([existing]);
      expect(detailReads).toBe(3);
    }),
  ),
);

it.effect("updates reviewer requests and enriched reviewers without rereading the host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;
      let refuse = false;
      const actor = { login: "reviewer", name: "Reviewer", avatarUrl: null };
      const hostActor = { ...actor, login: "Reviewer" };
      let hostRequested = false;
      let reviewed = false;
      let pauseActivity = false;
      const activityStarted = yield* Latch.make();
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.never,
        [WS_METHODS.pullRequestsDetail]: () =>
          Effect.sync(() => {
            reads++;
            return { reviewers: hostRequested ? [hostActor] : [] };
          }),
        [WS_METHODS.pullRequestsActivity]: () =>
          Effect.gen(function* () {
            reads++;
            if (pauseActivity) {
              pauseActivity = false;
              yield* activityStarted.open;
              return yield* Effect.never;
            }
            return {
              reviewers: hostRequested ? [hostActor] : [],
              comments: reviewed ? [{ kind: "review-comment", author: hostActor }] : [],
            };
          }),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input: { number: number }) =>
          input.number === 2
            ? Effect.never
            : Effect.sync(() => {
                reads++;
                return {
                  candidates: [{ ...actor, id: "12", kind: "user", isRequested: false }],
                  truncated: false,
                };
              }),
        [WS_METHODS.pullRequestsRequestReviewers]: (input: { requested: boolean }) =>
          refuse
            ? Effect.fail(new MutationRefused())
            : Effect.sync(() => {
                hostRequested = input.requested;
              }),
      } as unknown as WsRpcProtocolClient;
      const { atoms, registry } = yield* makeTestRuntime(client);
      const target = {
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
          host: "github.example.com",
        },
      };
      const detail = atoms.detail(target);
      const activity = atoms.activity(target);
      const candidates = atoms.reviewerCandidates(target);
      registry.mount(detail);
      registry.mount(activity);
      registry.mount(candidates);
      yield* AtomRegistry.getResult(registry, detail, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true });
      yield* AtomRegistry.getResult(registry, candidates, { suspendOnWaiting: true });
      const request = (requested: boolean, reference = target) =>
        Effect.promise(() =>
          atoms.requestReviewers.run(registry, {
            ...reference,
            input: { ...reference.input, reviewers: [{ id: "12", kind: "user" }], requested },
          }),
        );
      for (const operation of ["request", "refuse", "remove"]) {
        refuse = operation === "refuse";
        expect((yield* request(operation === "request"))._tag).toBe(refuse ? "Failure" : "Success");
        const expected = operation === "remove" ? [] : [actor];
        expect((yield* AtomRegistry.getResult(registry, detail)).reviewers).toEqual(expected);
        expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual(expected);
        expect((yield* AtomRegistry.getResult(registry, candidates)).candidates).toMatchObject([
          { isRequested: operation !== "remove" },
        ]);
      }
      expect(reads).toBe(3);
      // A slow activity read started before the write must not hide the new request.
      pauseActivity = true;
      registry.refresh(activity);
      yield* activityStarted.await;
      expect(AsyncResult.isSuccess(yield* request(true))).toBe(true);
      expect(
        (yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true })).reviewers,
      ).toEqual([hostActor]);
      expect(reads).toBe(5);
      expect(AsyncResult.isSuccess(yield* request(false))).toBe(true);
      expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual([]);

      reviewed = true;
      yield* request(true);
      registry.refresh(activity);
      yield* AtomRegistry.getResult(registry, activity, { suspendOnWaiting: true });
      yield* request(false);
      expect((yield* AtomRegistry.getResult(registry, activity)).reviewers).toEqual([hostActor]);

      // A caller without an open picker still needs authoritative reviewer identities.
      const otherTarget = { ...target, input: { ...target.input, number: 2 } };
      const otherDetail = atoms.detail(otherTarget);
      registry.mount(otherDetail);
      yield* AtomRegistry.getResult(registry, otherDetail, { suspendOnWaiting: true });
      yield* request(true, otherTarget);
      expect(
        (yield* AtomRegistry.getResult(registry, otherDetail, { suspendOnWaiting: true }))
          .reviewers,
      ).toEqual([hostActor]);
    }),
  ),
);

it.effect("refreshes stack state after reopening and head SHAs after a turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const refreshEvents = yield* PubSub.unbounded<number | PullRequestRefresh>();
      let state: "closed" | "open" = "closed";
      let headSha = "old-head";
      const client = {
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () => Stream.fromPubSub(refreshEvents),
        [WS_METHODS.pullRequestsStack]: () =>
          Effect.sync(
            () =>
              ({
                id: "stack-1",
                number: 1,
                url: "https://github.com/acme/web/pull/1",
                base: "main",
                layers: [
                  {
                    number: 1,
                    headBranch: "feature",
                    headSha,
                    state,
                    isDraft: false,
                  },
                ],
              }) satisfies PullRequestStack,
          ),
      } as unknown as WsRpcProtocolClient;
      const { runtime, registry } = yield* makeTestRuntime(client);
      const stacks = createPullRequestStackAtomFamily(runtime);
      const stack = stacks({
        environmentId: TARGET.environmentId,
        input: {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 1,
        },
      });
      const unmount = registry.mount(stack);
      yield* Effect.addFinalizer(() => Effect.sync(unmount));
      yield* Effect.promise(() => executeAtomQuery(registry, stack));
      expect((yield* AtomRegistry.getResult(registry, stack))?.layers[0]?.state).toBe("closed");
      state = "open";
      registry.refresh(stack);
      expect(
        (yield* AtomRegistry.getResult(registry, stack, { suspendOnWaiting: true }))?.layers[0]
          ?.state,
      ).toBe("open");

      const scoped = Latch.makeUnsafe();
      const stopScoped = registry.subscribe(stack, (result) => {
        if (AsyncResult.isSuccess(result) && result.value?.layers[0]?.headSha === "scoped-head")
          scoped.openUnsafe();
      });
      yield* Effect.addFinalizer(() => Effect.sync(stopScoped));
      headSha = "scoped-head";
      yield* PubSub.publish(refreshEvents, {
        revision: 1,
        reference: {
          projectId: ProjectId.make("project-1"),
          host: "github.com",
          repository: "acme/web",
          number: 2,
        },
        host: "github.com",
        listings: false,
      });
      yield* scoped.await;

      const refreshed = Latch.makeUnsafe();
      const stop = registry.subscribe(stack, (result) => {
        if (AsyncResult.isSuccess(result) && result.value?.layers[0]?.headSha === "new-head") {
          refreshed.openUnsafe();
        }
      });
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      headSha = "new-head";
      yield* PubSub.publish(refreshEvents, 2);
      yield* refreshed.await;
      expect((yield* AtomRegistry.getResult(registry, stack))?.layers[0]?.headSha).toBe("new-head");
    }),
  ),
);
