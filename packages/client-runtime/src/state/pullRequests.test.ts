import {
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type PullRequestRefresh,
  type PullRequestRef,
  PullRequestOperationError,
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
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { SshConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import { ConnectionProfileStore } from "../connection/profileStore.ts";
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
import { createPullRequestRouter } from "./pullRequestRouting.ts";
import { GitHubRoutingPermissions } from "../connection/githubRoutingPermissions.ts";

const trustedRouting = {
  get: () => Effect.succeed("read-write" as const),
  changes: Stream.empty,
  set: () => Effect.void,
  forget: () => Effect.void,
};

class MutationRefused extends Data.TaggedError("MutationRefused") {}

for (const scenario of [
  "prefers the local environment with the same github account",
  "falls back before mutation when the local account differs",
  "never retries an ambiguous mutation failure",
  "returns a fast source read without checking alternate identities",
  "keeps single-environment requests free of identity lookups",
  "keeps a local origin ahead of another local environment",
  "keeps mutations on an old origin server without retrying them",
  "skips an old alternate server before dispatching a mutation",
  "returns a successful mutation when source invalidation stalls",
  "does not dispatch after routing permission is revoked during the probe",
  "keeps mutations on the origin when the alternate is disabled",
  "does not dispatch after the alternate is disabled during the probe",
  "preserves a local source account rejection when alternate accounts differ",
] as const) {
  (scenario === "returns a successful mutation when source invalidation stalls"
    ? it.live
    : it.effect)(scenario, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const inputs: unknown[] = [];
        let trusted = true;
        let disableAlternate = Effect.void;
        const switchedAccount =
          scenario === "preserves a local source account rejection when alternate accounts differ";
        const mismatch =
          scenario === "falls back before mutation when the local account differs" ||
          switchedAccount;
        const ambiguous = scenario === "never retries an ambiguous mutation failure";
        const reading =
          scenario === "returns a fast source read without checking alternate identities";
        const single = scenario === "keeps single-environment requests free of identity lookups";
        const localOrigin =
          scenario === "keeps a local origin ahead of another local environment" || switchedAccount;
        const oldOrigin =
          scenario === "keeps mutations on an old origin server without retrying them";
        const oldAlternate =
          scenario === "skips an old alternate server before dispatching a mutation";
        const failure = new PullRequestOperationError({
          operation: switchedAccount ? "routeIdentity" : "runAction",
          detail: "connection lost after dispatch",
        });
        const clientFor = (local: boolean) => {
          const name = local ? "local" : "origin";
          return {
            [local ? WS_METHODS.pullRequestsRoutingIdentity : WS_METHODS.pullRequestsRouting]: (
              input: unknown,
            ) =>
              Effect.gen(function* () {
                if (local) expect(input).toEqual({ host: "github.com" });
                calls.push(`${name}:identity`);
                if (
                  local &&
                  scenario === "does not dispatch after the alternate is disabled during the probe"
                )
                  yield* disableAlternate;
                if (
                  local &&
                  scenario ===
                    "does not dispatch after routing permission is revoked during the probe"
                )
                  trusted = false;
                if ((!local && oldOrigin) || (local && oldAlternate)) {
                  return yield* Effect.die(
                    `Unknown request tag: ${WS_METHODS.pullRequestsRouting}`,
                  );
                }
                return {
                  host: "github.com",
                  provider: "github",
                  viewer: "maria-rcks",
                  accountId: local && mismatch ? "456" : "123",
                };
              }),
            [WS_METHODS.pullRequestsRunAction]: (input: unknown) =>
              Effect.gen(function* () {
                calls.push(`${name}:mutation`);
                inputs.push(input);
                if (
                  !local &&
                  switchedAccount &&
                  (input as { expectedAccountId?: string }).expectedAccountId === "123"
                )
                  return yield* failure;
                if (local && ambiguous) return yield* failure;
              }),
            [WS_METHODS.pullRequestsSummary]: (input: { allowStale?: boolean }) =>
              Effect.gen(function* () {
                calls.push(`${name}:read`);
                expect(input.allowStale).toBe(false);
                if (local) return yield* failure;
                return null;
              }),
            [WS_METHODS.pullRequestsInvalidate]: () =>
              Effect.gen(function* () {
                calls.push(`${name}:invalidate`);
                if (
                  !local &&
                  scenario === "returns a successful mutation when source invalidation stalls"
                ) {
                  return yield* Effect.never;
                }
              }),
          } as unknown as WsRpcProtocolClient;
        };
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(
          clientFor(false),
          single ? undefined : clientFor(true),
          localOrigin,
        );
        disableAlternate = SubscriptionRef.update(
          environmentRegistry.entries,
          (entries) =>
            new Map(
              [...entries].map(([id, entry]) => [
                id,
                id === TARGET.environmentId ? entry : { ...entry, enabled: false },
              ]),
            ),
        );
        const disabled =
          scenario === "keeps mutations on the origin when the alternate is disabled";
        const disabledDuringProbe =
          scenario === "does not dispatch after the alternate is disabled during the probe";
        if (disabled) yield* disableAlternate;
        const input = {
          projectId: ProjectId.make("project-1"),
          host: "github.com",
          repository: "acme/web",
          number: 7,
          action: "merge" as const,
        };
        const route = createPullRequestRouter();
        const result = yield* (
          reading
            ? route(WS_METHODS.pullRequestsSummary, input)
            : route(WS_METHODS.pullRequestsRunAction, input)
        ).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Effect.provideService(GitHubRoutingPermissions, {
            ...trustedRouting,
            get: () => Effect.succeed(trusted ? "read-write" : "off"),
          }),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.result,
        );

        if (switchedAccount) {
          expect(result).toMatchObject({ _tag: "Failure", failure });
          expect(calls.filter((call) => call.endsWith(":mutation"))).toEqual(["origin:mutation"]);
          expect(inputs).toEqual([{ ...input, expectedAccountId: "123" }]);
        } else if (ambiguous) {
          expect(result).toMatchObject({ _tag: "Failure", failure });
          expect(calls.filter((call) => call.endsWith(":mutation"))).toEqual(["local:mutation"]);
        } else {
          expect(result._tag).toBe("Success");
          if (single || disabled) {
            expect(calls.filter((call) => !call.endsWith(":invalidate"))).toEqual([
              "origin:mutation",
            ]);
          } else if (reading) expect(calls).toEqual(["origin:read"]);
          else if (
            mismatch ||
            localOrigin ||
            oldOrigin ||
            oldAlternate ||
            !trusted ||
            disabledDuringProbe
          )
            expect(calls.filter((call) => call.endsWith(":mutation"))).toEqual(["origin:mutation"]);
          else {
            expect(calls.filter((call) => call.endsWith(":mutation"))).toEqual(["local:mutation"]);
            expect(calls).toContain("origin:invalidate");
            expect(inputs).toEqual([{ ...input, expectedAccountId: "123" }]);
          }
        }
      }),
    ),
  );
}

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
    client: {
      ...client,
      [WS_METHODS.pullRequestsInvalidate]:
        client[WS_METHODS.pullRequestsInvalidate] ?? (() => Effect.void),
    },
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeTestRuntime = Effect.fn("makeTestRuntime")(function* (
  client: WsRpcProtocolClient,
  localClient?: WsRpcProtocolClient,
  localOrigin = false,
) {
  const originTarget = localOrigin
    ? new PrimaryConnectionTarget({
        ...TARGET,
        httpBaseUrl: "http://localhost:3774",
        wsBaseUrl: "ws://localhost:3774",
      })
    : TARGET;
  const connectionState: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: originTarget,
    state: yield* SubscriptionRef.make(connectionState),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const localTarget = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("local-environment"),
    label: "Local environment",
    httpBaseUrl: "http://localhost:3773",
    wsBaseUrl: "ws://localhost:3773",
  });
  const localSupervisor = {
    ...supervisor,
    target: localTarget,
    session: yield* SubscriptionRef.make(Option.some(session(localClient ?? client))),
  };
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([
        [
          originTarget.environmentId,
          { target: originTarget, profile: Option.none(), enabled: true },
        ],
        ...(localClient === undefined
          ? []
          : [
              [
                localTarget.environmentId,
                { target: localTarget, profile: Option.none(), enabled: true },
              ] as const,
            ]),
      ]),
    ),
    run: (environmentId, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        environmentId === localTarget.environmentId ? localSupervisor : supervisor,
      ),
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
  return {
    runtime,
    atoms,
    ciAtoms: createPullRequestCiEnvironmentAtoms(runtime),
    registry,
    environmentRegistry,
    supervisor,
  };
});

for (const permission of ["default", "origin-off", "destination-off", "read-only"] as const) {
  it.effect(`does not probe another environment with ${permission} routing permission`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const failure = new PullRequestOperationError({
          operation: "summary",
          detail: "source failed",
        });
        const client = {
          [WS_METHODS.pullRequestsSummary]: () =>
            Effect.suspend(() => {
              calls.push("source-read");
              return Effect.fail(failure);
            }),
          [WS_METHODS.pullRequestsRunAction]: () =>
            Effect.sync(() => {
              calls.push("source-write");
            }),
        } as unknown as WsRpcProtocolClient;
        const alternate = {
          [WS_METHODS.pullRequestsRoutingIdentity]: () =>
            Effect.die("untrusted environment was contacted"),
        } as unknown as WsRpcProtocolClient;
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(client, alternate);
        const ref = {
          projectId: ProjectId.make("project-1"),
          repository: "private/repo",
          number: 7,
        };
        const request = Effect.gen(function* () {
          const route = createPullRequestRouter();
          if (permission !== "read-only")
            yield* route(WS_METHODS.pullRequestsSummary, ref).pipe(Effect.flip);
          yield* route(WS_METHODS.pullRequestsRunAction, { ...ref, action: "merge" });
        }).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
        yield* permission === "default"
          ? request
          : request.pipe(
              Effect.provideService(GitHubRoutingPermissions, {
                ...trustedRouting,
                get: (entry) =>
                  Effect.succeed(
                    permission === "read-only"
                      ? "read"
                      : (entry.target.environmentId === TARGET.environmentId) ===
                          (permission === "origin-off")
                        ? "off"
                        : "read-write",
                  ),
              }),
            );
        expect(calls).toEqual(
          permission === "read-only" ? ["source-write"] : ["source-read", "source-write"],
        );
      }),
    ),
  );
}

for (const side of ["origin", "destination"] as const) {
  for (const stored of ["matching", "changed", "missing", "unavailable", "failed"] as const) {
    it.effect(`checks the current ${side} SSH profile before routing with ${stored} storage`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const calls: string[] = [];
          const identity = {
            host: "github.com",
            provider: "github",
            viewer: "maria",
            accountId: "123",
          };
          const client = {
            [WS_METHODS.pullRequestsRouting]: () =>
              Effect.sync(() => {
                calls.push("source-probe");
                return identity;
              }),
            [WS_METHODS.pullRequestsRunAction]: (input: { expectedAccountId?: string }) =>
              Effect.gen(function* () {
                if (input.expectedAccountId !== undefined) {
                  return yield* new PullRequestOperationError({
                    operation: "routeIdentity",
                    detail: "Source guard refused.",
                  });
                }
                calls.push("source-write");
              }),
            [WS_METHODS.pullRequestsInvalidate]: () => Effect.void,
          } as unknown as WsRpcProtocolClient;
          const alternate = {
            [WS_METHODS.pullRequestsRoutingIdentity]: () =>
              Effect.sync(() => {
                calls.push("alternate-probe");
                return identity;
              }),
            [WS_METHODS.pullRequestsRunAction]: () =>
              Effect.sync(() => {
                calls.push("alternate-write");
              }),
            [WS_METHODS.pullRequestsInvalidate]: () => Effect.void,
          } as unknown as WsRpcProtocolClient;
          const { environmentRegistry, supervisor } = yield* makeTestRuntime(client, alternate);
          const environmentId =
            side === "origin" ? TARGET.environmentId : EnvironmentId.make("local-environment");
          const profile = new SshConnectionProfile({
            connectionId: "ssh-1",
            environmentId,
            label: "SSH",
            target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
          });
          yield* SubscriptionRef.update(environmentRegistry.entries, (entries) =>
            new Map(entries).set(environmentId, {
              target: new SshConnectionTarget({
                environmentId,
                connectionId: profile.connectionId,
                label: "SSH",
              }),
              profile: Option.some(profile),
              enabled: true,
            }),
          );
          const read = Effect.suspend(() =>
            stored === "failed"
              ? Effect.fail(
                  new ConnectionTransientError({
                    reason: "remote-unavailable",
                    detail: "Profile storage unavailable.",
                  }),
                )
              : Effect.succeed(
                  stored === "missing"
                    ? Option.none()
                    : Option.some(
                        stored === "changed"
                          ? new SshConnectionProfile({
                              ...profile,
                              target: { ...profile.target, hostname: "replacement.example.test" },
                            })
                          : profile,
                      ),
                ),
          );
          const route = createPullRequestRouter()(WS_METHODS.pullRequestsRunAction, {
            projectId: ProjectId.make("project-1"),
            repository: "private/repo",
            number: 7,
            action: "merge",
          }).pipe(
            Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            // This also represents a user enabling the stale catalog entry after re-resolution.
            Effect.provideService(GitHubRoutingPermissions, trustedRouting),
          );
          yield* stored === "unavailable"
            ? route
            : route.pipe(
                Effect.provideService(ConnectionProfileStore, {
                  get: () => read,
                  put: () => Effect.die("unused"),
                  remove: () => Effect.die("unused"),
                }),
              );
          expect(calls).toEqual(
            stored === "matching"
              ? ["source-probe", "alternate-probe", "alternate-write"]
              : ["source-write"],
          );
        }),
      ),
    );
  }
}

for (const probe of ["origin", "alternate"] as const) {
  it.live(`bounds a stalled ${probe} metadata probe without repeating a strict source read`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        let sourceReads = 0;
        const identity = {
          host: "github.com",
          provider: "github",
          viewer: "maria",
          accountId: "123",
        };
        const client = {
          [WS_METHODS.pullRequestsRouting]: () =>
            probe === "origin" ? Effect.never : Effect.succeed(identity),
          [WS_METHODS.pullRequestsSummary]: () =>
            Effect.suspend(() => {
              sourceReads += 1;
              return Effect.fail(
                new PullRequestOperationError({ operation: "summary", detail: "source failed" }),
              );
            }),
        } as unknown as WsRpcProtocolClient;
        const alternate = {
          [WS_METHODS.pullRequestsRoutingIdentity]: () => Effect.never,
        } as unknown as WsRpcProtocolClient;
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(client, alternate);
        const error = yield* createPullRequestRouter()(WS_METHODS.pullRequestsSummary, {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 7,
          allowStale: false,
        }).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(GitHubRoutingPermissions, trustedRouting),
          Effect.flip,
        );
        expect(error._tag).toBe("PullRequestOperationError");
        expect(sourceReads).toBe(1);
      }),
    ),
  );
}

for (const source of ["pending", "pending-local", "failed", "offline"] as const) {
  it.live(
    source === "offline"
      ? "returns held source data only after both fresh paths fail"
      : `hedges a ${source} source read to local and interrupts the losing read`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let interrupted = false;
          const calls: string[] = [];
          const clientFor = (local: boolean) =>
            ({
              [local ? WS_METHODS.pullRequestsRoutingIdentity : WS_METHODS.pullRequestsRouting]:
                () =>
                  Effect.succeed({
                    host: "github.com",
                    provider: "github",
                    viewer: "maria-rcks",
                    accountId: "123",
                  }),
              [WS_METHODS.pullRequestsSummary]: (input: { allowStale?: boolean }) =>
                Effect.gen(function* () {
                  calls.push(local ? "local" : input.allowStale === false ? "origin" : "held");
                  if (source === "offline" && !local && input.allowStale === undefined) {
                    return { state: "open" };
                  }
                  expect(input.allowStale).toBe(false);
                  if (local && source !== "offline") return null;
                  if (source !== "pending" && source !== "pending-local")
                    return yield* new PullRequestOperationError({
                      operation: "summary",
                      detail: "github unreachable",
                    });
                  return yield* Effect.never.pipe(
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        interrupted = true;
                      }),
                    ),
                  );
                }),
            }) as unknown as WsRpcProtocolClient;
          const { environmentRegistry, supervisor } = yield* makeTestRuntime(
            clientFor(false),
            clientFor(true),
            source === "pending-local",
          );
          const result = yield* createPullRequestRouter()(WS_METHODS.pullRequestsSummary, {
            projectId: ProjectId.make("project-1"),
            repository: "acme/web",
            number: 7,
          }).pipe(
            Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Effect.provideService(GitHubRoutingPermissions, trustedRouting),
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          if (source === "offline") {
            expect(result).toEqual({ state: "open" });
            expect(calls).toEqual(["origin", "local", "held"]);
          } else {
            expect(result).toBeNull();
            expect(calls).toEqual(["origin", "local"]);
          }
          expect(interrupted).toBe(source === "pending" || source === "pending-local");
        }),
      ),
  );
}

it.live("keeps source workspace metadata when an alternate answers a detail read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const clientFor = (local: boolean) =>
        ({
          [local ? WS_METHODS.pullRequestsRoutingIdentity : WS_METHODS.pullRequestsRouting]: () =>
            Effect.succeed({
              host: "github.com",
              provider: "github",
              viewer: "maria-rcks",
              accountId: "123",
              projectTitle: local ? "local project" : "source project",
              workspaceRoot: local ? "/Users/local/repo" : "/srv/source/repo",
            }),
          [WS_METHODS.pullRequestsDetail]: () =>
            local
              ? Effect.succeed({
                  projectId: "local-project",
                  projectTitle: "local project",
                  workspaceRoot: "/Users/local/repo",
                  title: "github title",
                })
              : Effect.never,
        }) as unknown as WsRpcProtocolClient;
      const { environmentRegistry, supervisor } = yield* makeTestRuntime(
        clientFor(false),
        clientFor(true),
      );
      const result = yield* createPullRequestRouter()(WS_METHODS.pullRequestsDetail, {
        projectId: ProjectId.make("project-1"),
        repository: "acme/web",
        number: 7,
      }).pipe(
        Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        Effect.provideService(GitHubRoutingPermissions, trustedRouting),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(result).toEqual({
        projectId: "project-1",
        projectTitle: "source project",
        workspaceRoot: "/srv/source/repo",
        title: "github title",
      });
    }),
  ),
);

it.live.each([
  { read: WS_METHODS.pullRequestsSummary, write: WS_METHODS.pullRequestsRunAction },
  { read: WS_METHODS.pullRequestsCiRuns, write: WS_METHODS.pullRequestsRerunCi },
  { read: WS_METHODS.pullRequestsCiJobs, write: WS_METHODS.pullRequestsRerunCi },
  { read: WS_METHODS.pullRequestsViewedFiles, write: WS_METHODS.pullRequestsSetFileViewed },
  { read: WS_METHODS.pullRequestsDependencyContext, write: WS_METHODS.pullRequestsRunAction },
])(
  "refreshes identity for $write and invalidates prior $read readers across router instances",
  ({ read, write }) =>
    Effect.scoped(
      Effect.gen(function* () {
        let originAccountId = "123";
        const mutations: { environment: string; expectedAccountId: string }[] = [];
        const invalidations: { environment: string; input: unknown }[] = [];
        const identities: string[] = [];
        const clientFor = (local: boolean) => {
          const environment = local ? "local" : "origin";
          return {
            [local ? WS_METHODS.pullRequestsRoutingIdentity : WS_METHODS.pullRequestsRouting]: () =>
              Effect.sync(() => {
                identities.push(environment);
                return {
                  host: "github.com",
                  provider: "github",
                  viewer: "maria-rcks",
                  accountId: local ? "123" : originAccountId,
                };
              }),
            [read]: () => (local ? Effect.succeed(null) : Effect.never),
            [write]: (input: { expectedAccountId: string }) =>
              Effect.sync(() => {
                mutations.push({ environment, expectedAccountId: input.expectedAccountId });
              }),
            [WS_METHODS.pullRequestsInvalidate]: (input: unknown) =>
              Effect.sync(() => {
                invalidations.push({ environment, input });
              }),
          } as unknown as WsRpcProtocolClient;
        };
        const { environmentRegistry, supervisor } = yield* makeTestRuntime(
          clientFor(false),
          clientFor(true),
        );
        const reference = {
          projectId: ProjectId.make("project-1"),
          repository: "acme/web",
          number: 7,
          runId: "run-1",
        };
        const hostedReference = { ...reference, host: "github.com", allowStale: false };
        const route = createPullRequestRouter();
        yield* Effect.gen(function* () {
          yield* route(read, reference);
          originAccountId = "456";
          yield* route(write, {
            ...reference,
            action: "merge",
            mode: "all",
            path: "a.ts",
            viewed: true,
            headSha: "head",
          });

          expect(identities.filter((environment) => environment === "origin")).toHaveLength(2);
          expect(mutations).toEqual([{ environment: "origin", expectedAccountId: "456" }]);
          expect(invalidations).toEqual(
            expect.arrayContaining([
              { environment: "origin", input: { reference: expect.objectContaining(reference) } },
              { environment: "origin", input: { reference: hostedReference } },
              { environment: "local", input: { reference: hostedReference } },
              { environment: "origin", input: {} },
              { environment: "local", input: {} },
            ]),
          );

          invalidations.length = 0;
          const refresh = createPullRequestRouter();
          yield* refresh(WS_METHODS.pullRequestsInvalidate, { reference });
          expect(invalidations).toContainEqual({
            environment: "local",
            input: { reference: hostedReference },
          });

          invalidations.length = 0;
          yield* refresh(WS_METHODS.pullRequestsInvalidate, {});
          expect(invalidations).toContainEqual({ environment: "local", input: {} });
        }).pipe(
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Effect.provideService(GitHubRoutingPermissions, trustedRouting),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );
      }),
    ),
);

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
