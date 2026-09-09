import {
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type PullRequestRefresh,
  type PullRequestRef,
  type PullRequestStack,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
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
} from "./pullRequests.ts";
import { PullRequestDiffLoader } from "./pullRequestDiffHttp.ts";
import { executeAtomQuery } from "./runtime.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

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
  return { runtime, atoms, registry };
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
