import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.thread.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(
      new Set(["preview", "orchestration", "worktree", "pull-requests"]),
    );

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect(
  "keeps MCP writes with the active provider after handoff with a stopped prior binding",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(() => 1_000);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread-mcp-handoff");
      const now = yield* DateTime.now;
      const priorInstanceId = ProviderInstanceId.make("claude-proxy");
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "gpt-5.4" };
      const prior = yield* registry.issue({ threadId, providerInstanceId: priorInstanceId });
      const priorToken = prior.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const priorScope = yield* registry.resolve(priorToken);
      expect(priorScope).toBeDefined();
      yield* store.apply({
        id: EventId.make("mcp-handoff:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make("project-mcp-handoff"),
          title: "MCP handoff",
          createdBy: "user",
          creationSource: "web",
          providerInstanceId: priorInstanceId,
          modelSelection: { instanceId: priorInstanceId, model: "claude-sonnet-4-6" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      for (const [providerInstanceId, driver, status] of [
        [priorInstanceId, "claudeAgent", "stopped"],
        [instanceId, "codex", "ready"],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`mcp-handoff:${providerInstanceId}`),
          type: "provider-session.attached",
          threadId,
          occurredAt: now,
          payload: {
            id: ProviderSessionId.make(`session-${providerInstanceId}`),
            driver: ProviderDriverKind.make(driver),
            providerInstanceId,
            status,
            cwd: process.cwd(),
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
      }
      yield* store.apply({
        id: EventId.make("mcp-handoff:provider-switch"),
        type: "thread.provider-switched",
        threadId,
        occurredAt: now,
        payload: {
          ...(yield* store.getThread(threadId)),
          providerInstanceId: instanceId,
          modelSelection,
        },
      });
      yield* store.apply({
        id: EventId.make("mcp-handoff:run"),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: {
          id: RunId.make("run-mcp-handoff"),
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message-mcp-handoff"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* registry.revokeThread(threadId);
      const active = yield* registry.issue({ threadId, providerInstanceId: instanceId });
      const scope = yield* registry.resolve(
        active.config.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      expect(scope?.thread.providerInstanceId).toBe(instanceId);
      expect(yield* registry.resolve(priorToken)).toBeUndefined();
      expect(
        (yield* store.getThreadProjection(threadId)).providerSessions.map(
          (session) => session.status,
        ),
      ).toEqual(["stopped", "ready"]);
      let writes = 0;
      const threadsLayer = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (id) => store.getThreadShell(id).pipe(Effect.orDie),
        getProjectThreadRecords: (input, fields) =>
          store.getThreadRecords(input.threadId, fields).pipe(Effect.orDie),
        dispatch: () => Effect.sync(() => ({ sequence: ++writes, storedEvents: [] })),
      });
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const client = McpSchema.McpServerClient.of({
          clientId: 1,
          protocolVersion: "2025-06-18",
          clientCapabilities: {},
          clientInfo: { name: "handoff-test", version: "1" },
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "handoff-test", version: "1" },
          },
          getClient: Effect.die("unused"),
        });
        const call = (invocation: McpInvocationContext.McpInvocationScope, write = true) =>
          server
            .callTool({
              name: "t3_thread_configure",
              arguments: write ? { modelSelection } : {},
            })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
        const readable = yield* call(priorScope!, false);
        expect(readable.isError).toBe(false);
        const stale = yield* call(priorScope!);
        expect(stale.isError).toBe(true);
        expect(stale.content[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining("parent_not_active"),
        });
        expect(writes).toBe(0);
        const current = yield* call(scope!);
        expect(current.isError).toBe(false);
        expect(current.structuredContent).toEqual({ sequence: 1 });
        expect(writes).toBe(1);
      }).pipe(
        Effect.provide(
          McpHttpServer.layerThreadToolkit.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(threadsLayer),
            Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
            Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
            Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
            Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
            Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          NodeServices.layer,
        ),
      ),
    ),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual([
      "orchestration",
      "preview",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual([
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withDevice)).toEqual([
      "device",
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
  }),
);

// regression: #3114 use bound host for MCP endpoint
it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("only a trusted touch restores an expired token with its original scope", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-idle");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const scope = yield* registry.resolve(token);
    expect(scope).toBeDefined();

    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
    const otherThreadId = ThreadId.make("thread-active");
    const other = yield* registry.issue({
      threadId: otherThreadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    yield* registry.touch(otherThreadId);
    expect(
      (yield* registry.resolve(other.config.authorizationHeader.replace(/^Bearer\s+/, "")))?.thread
        .threadId,
    ).toBe(otherThreadId);
    expect(yield* registry.resolve("unknown-token")).toBeUndefined();
    expect(yield* registry.resolve(token)).toBeUndefined();

    yield* registry.touch(threadId);
    expect(yield* registry.resolve(token)).toEqual(scope);
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect.each(["provider-session", "thread", "all"] as const)(
  "never restores an expired token after %s revocation",
  (revocation) =>
    Effect.gen(function* () {
      let timestamp = 1_000;
      const registry = yield* makeRegistry(() => timestamp);
      const threadId = ThreadId.make("thread-revoked");
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

      timestamp += 101;
      yield* {
        "provider-session": registry.revokeProviderSession(issued.config.providerSessionId),
        thread: registry.revokeThread(threadId),
        all: registry.revokeAll,
      }[revocation];
      yield* registry.touch(threadId);
      expect(yield* registry.resolve(token)).toBeUndefined();
    }),
);
