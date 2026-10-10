import { requestGuarded, runStreamGuarded } from "../rpc/client.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { RpcSession } from "../rpc/session.ts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  TurnItemId,
  AuthSourceControlWriteScope,
  ThreadId,
  EnvironmentId,
  ScheduledTaskId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const permissions = createCommandPermissions(runtime, WS_METHODS.scheduledTasksDelete);
const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect(
    "checks preview profile reports against the destination and rejects a revoked grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          const report = createCommandPermissions(runtime, WS_METHODS.previewReportProfiles);
          registry.set(sessions(env), AsyncResult.success(grant(false)));
          registry.set(
            sessions(other),
            AsyncResult.success({
              ...grant(false),
              scopes: [AuthPreviewOperateScope],
              permissions: [AuthPreviewOperateScope],
            }),
          );
          expect(registry.get(report.permissionAtom(env))).toBe(false);
          expect(
            (yield* report.authorize(registry, env).pipe(Effect.flip)).requiredPermission,
          ).toBe(AuthPreviewOperateScope);
          yield* report.authorize(registry, other);
          expect(registry.get(report.permissionAtom(other))).toBe(true);
          registry.set(sessions(other), AsyncResult.success(grant(false)));
          expect((yield* report.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
        }),
      ),
  );
  it.effect("uses the target grant for both availability and execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(permissions.permissionAtom(env))).toBe(true);
        expect(permissions.permissionAtom(env)).toBe(permissions.permissionAtom(env));
        yield* permissions.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(permissions.permissionAtom(other))).toBe(false);
        const denied = yield* permissions.authorize(registry, other).pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect("waits for an initial grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions.authorize(registry, env).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* Fiber.join(fiber);
      }),
    ),
  );
  it.effect("bounds a session that never loads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const fiber = yield* permissions
          .authorize(registry, env)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("6 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("EnvironmentAuthorizationError");
      }),
    ),
  );
  it.effect(
    "denies failed and unauthenticated sessions, but accepts a cached refreshing grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const registry = yield* setup;
          registry.set(sessions(env), AsyncResult.failure(Cause.fail("offline")));
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(
            sessions(env),
            AsyncResult.success({ ...grant(true), authenticated: false }),
          );
          expect((yield* permissions.authorize(registry, env).pipe(Effect.flip))._tag).toBe(
            "EnvironmentAuthorizationError",
          );
          registry.set(sessions(env), AsyncResult.waiting(AsyncResult.success(grant(true))));
          yield* permissions.authorize(registry, env);
        }),
      ),
  );
  it("rechecks permission after waiting in a serial command lane", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(sessions(env));
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const command = createEnvironmentRpcCommand(runtime, {
      label: "test.delete",
      tag: WS_METHODS.scheduledTasksDelete,
      concurrency: { mode: "serial", key: () => "target" },
      execute: () =>
        Effect.promise(async () => {
          calls++;
          started();
          await gate;
          return { id: ScheduledTaskId.make("task") };
        }),
    });
    const target = { environmentId: env, input: { id: ScheduledTaskId.make("task") } };
    try {
      const first = command.run(registry, target);
      await entered;
      const second = command.run(registry, target);
      registry.set(sessions(env), AsyncResult.success(grant(false)));
      release();
      expect((await first)._tag).toBe("Success");
      expect((await second)._tag).toBe("Failure");
      expect(calls).toBe(1);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

it.effect(
  "requires source control alone for git, and both grants when attaching a worktree to a thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
        expect((yield* git.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        yield* git.authorize(registry, env);
        const prepare = createCommandPermissions(runtime, WS_METHODS.gitPreparePullRequestThread);
        const input = {
          cwd: "/repo",
          reference: "123",
          mode: "worktree",
          threadId: ThreadId.make("thread"),
        };
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(false);
        expect(
          (yield* prepare.authorize(registry, env, input).pipe(Effect.flip)).requiredScope,
        ).toBe(AuthOrchestrationOperateScope);
        yield* prepare.authorize(registry, env, { ...input, threadId: undefined });
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(true),
            scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
            permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          }),
        );
        expect(registry.get(prepare.permissionAtom(env, input))).toBe(true);
        yield* prepare.authorize(registry, env, input);
      }),
    ),
);

it.effect("honors exact empty permissions and preserves legacy parent grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* setup;
      const git = createCommandPermissions(runtime, WS_METHODS.vcsInit);
      registry.set(sessions(env), AsyncResult.success({ ...grant(true), permissions: [] }));
      expect(registry.get(git.permissionAtom(env))).toBe(false);
      const denied = yield* git.authorize(registry, env).pipe(Effect.flip);
      expect(denied).toMatchObject({
        requiredPermission: AuthSourceControlWriteScope,
        requiredScope: AuthOrchestrationOperateScope,
      });
      const { permissions: _exact, ...legacy } = grant(true);
      registry.set(sessions(env), AsyncResult.success(legacy));
      expect(registry.get(git.permissionAtom(env))).toBe(true);
      yield* git.authorize(registry, env);
    }),
  ),
);

it.effect("rejects protected unary and streamed RPCs outside a guarded command", () =>
  Effect.gen(function* () {
    let writes = 0;
    const session = {
      client: {
        [WS_METHODS.scheduledTasksDelete]: () =>
          Effect.sync(() => {
            writes++;
            return { id: ScheduledTaskId.make("task") };
          }),
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              writes++;
            }),
          ),
      },
    } as unknown as RpcSession;
    const supervisor = {
      target: { environmentId: env, label: "target" },
      session: yield* SubscriptionRef.make(Option.some(session)),
    } as unknown as EnvironmentSupervisor["Service"];
    const unary = yield* requestGuarded(WS_METHODS.scheduledTasksDelete, {
      id: ScheduledTaskId.make("task"),
    }).pipe(Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(unary._tag).toBe("EnvironmentAuthorizationError");
    const streamed = yield* runStreamGuarded(WS_METHODS.gitRunStackedAction, {
      actionId: "test-action",
      cwd: "/repo",
      action: "commit",
    }).pipe(Stream.runDrain, Effect.provideService(EnvironmentSupervisor, supervisor), Effect.flip);
    expect(streamed._tag).toBe("EnvironmentAuthorizationError");
    expect(writes).toBe(0);
  }),
);

it.effect.each([WS_METHODS.pullRequestsRerunCi, WS_METHODS.pullRequestsSetFileViewed])(
  "checks the target source control grant for %s",
  (method) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const command = createCommandPermissions(runtime, method);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        expect(registry.get(command.permissionAtom(env))).toBe(false);
        expect((yield* command.authorize(registry, env).pipe(Effect.flip)).requiredPermission).toBe(
          AuthSourceControlWriteScope,
        );
        registry.set(
          sessions(env),
          AsyncResult.success({
            ...grant(false),
            scopes: [AuthSourceControlWriteScope],
            permissions: [AuthSourceControlWriteScope],
          }),
        );
        expect(registry.get(command.permissionAtom(env))).toBe(true);
        yield* command.authorize(registry, env);
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(command.permissionAtom(other))).toBe(false);
        expect(
          (yield* command.authorize(registry, other).pipe(Effect.flip)).requiredPermission,
        ).toBe(AuthSourceControlWriteScope);
      }),
    ),
);

it("matches the server editor grant for availability and destination dispatch across revocation and regrant", async () => {
  const registry = AtomRegistry.make();
  const unmount = registry.mount(sessions(env));
  const unmountOther = registry.mount(sessions(other));
  let writes = 0;
  const command = createEnvironmentRpcCommand(runtime, {
    label: "test.editor",
    tag: WS_METHODS.shellOpenInEditor,
    execute: () =>
      Effect.sync(() => {
        writes++;
      }),
  });
  const target = { environmentId: env, input: { cwd: "/repo/file.ts", editor: "vscode" as const } };
  try {
    registry.set(sessions(env), AsyncResult.success(grant(false)));
    registry.set(sessions(other), AsyncResult.success(grant(true)));
    expect(registry.get(command.permissionAtom(env))).toBe(false);
    expect((await command.run(registry, target))._tag).toBe("Failure");
    expect(writes).toBe(0);
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    expect(registry.get(command.permissionAtom(env))).toBe(true);
    expect((await command.run(registry, target))._tag).toBe("Success");
    expect(writes).toBe(1);
    registry.set(sessions(env), AsyncResult.success(grant(false)));
    expect(registry.get(command.permissionAtom(env))).toBe(false);
    expect((await command.run(registry, target))._tag).toBe("Failure");
    expect(writes).toBe(1);
  } finally {
    unmount();
    unmountOther();
    registry.dispose();
  }
});

const readGrant = (): AuthSessionState => ({
  ...grant(false),
  scopes: [AuthOrchestrationReadScope],
  permissions: [AuthOrchestrationReadScope],
});
it.effect.each([WS_METHODS.mcpAppsCallTool, WS_METHODS.mcpAppsUpdateModelContext])(
  "requires the destination operate grant for MCP Apps %s",
  (method) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const permission = createCommandPermissions(runtime, method);
        registry.set(sessions(other), AsyncResult.success(grant(true)));
        registry.set(sessions(env), AsyncResult.success(readGrant()));
        expect(registry.get(permission.permissionAtom(other))).toBe(true);
        expect(registry.get(permission.permissionAtom(env))).toBe(false);
        expect((yield* permission.authorize(registry, env).pipe(Effect.flip)).requiredScope).toBe(
          AuthOrchestrationOperateScope,
        );
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        yield* permission.authorize(registry, env);
      }),
    ),
);
it("refuses an MCP tool queued before destination access was revoked", async () => {
  const registry = AtomRegistry.make();
  const unmount = registry.mount(sessions(env));
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const command = createEnvironmentRpcCommand(runtime, {
    label: "test.mcp-tool",
    tag: WS_METHODS.mcpAppsCallTool,
    concurrency: { mode: "serial", key: () => "target" },
    execute: () =>
      Effect.promise(async () => {
        calls++;
        started();
        await gate;
        return { content: [] };
      }),
  });
  const target = {
    environmentId: env,
    input: {
      threadId: ThreadId.make("thread"),
      itemId: TurnItemId.make("item"),
      name: "tool",
      arguments: {},
    },
  };
  try {
    registry.set(sessions(env), AsyncResult.success(grant(true)));
    const first = command.run(registry, target);
    await entered;
    const second = command.run(registry, target);
    registry.set(sessions(env), AsyncResult.success(readGrant()));
    release();
    expect((await first)._tag).toBe("Success");
    expect((await second)._tag).toBe("Failure");
    expect(calls).toBe(1);
  } finally {
    release();
    unmount();
    registry.dispose();
  }
});
