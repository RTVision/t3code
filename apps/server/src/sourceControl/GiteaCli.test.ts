import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/unstable/http";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../config.ts";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as GiteaCli from "./GiteaCli.ts";

const target = {
  command: "tea",
  login: "work",
  baseUrl: "https://forge.test/gitea",
  repository: "",
} as const;
const login = {
  name: "work",
  url: target.baseUrl,
  user: "reviewer",
  default: "true",
  ssh_host: "work-forge",
};
function fixture(env: Record<string, string> = {}) {
  const request = vi.fn<ForgejoCli.ForgejoCli["Service"]["api"]>(() =>
    Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: '{"login":"reviewer"}',
      stderr:
        'HTTP/1.1 200 OK\nX-Total-Count: 51\nLink: <https://forge.test/gitea/api/v1/user?page=2>; rel="next"\n',
      stdoutTruncated: false,
      stderrTruncated: false,
    }),
  );
  const resolveServer = vi.fn<ForgejoCli.ForgejoCli["Service"]["resolveServer"]>(() =>
    Effect.succeed(target),
  );
  const layer = Layer.mergeAll(
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-tea-test-" }),
    Layer.mock(ForgejoCli.ForgejoCli)({
      api: request,
      resolveServer,
      listLogins: () => Effect.succeed([login]),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return { request, resolveServer, layer };
}

it.effect("uses tea's default account without a daemon API token", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const cli = yield* GiteaCli.make;
    expect(cli.baseUrl).toEqual(Option.some(target.baseUrl));
    expect(cli.sshHosts).toEqual(["work-forge"]);
    expect((yield* cli.probeAuth).account).toEqual(Option.some("reviewer"));
    expect(f.resolveServer.mock.calls[0]?.[0]).toMatchObject({
      command: "tea",
      reference: target.baseUrl,
    });
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      resolvedTarget: target,
      path: "user",
      method: "GET",
    });
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect("preserves JSON bodies and pagination metadata through tea", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const cli = yield* GiteaCli.make;
    const response = yield* cli.request({
      operation: "review",
      method: "POST",
      path: `${target.baseUrl}/api/v1/repos/acme/web/pulls/1/reviews`,
      body: '{"body":"hello","comments":[{"new_position":4}]}',
    });
    expect(f.request.mock.calls[0]?.[0]).toMatchObject({
      path: "repos/acme/web/pulls/1/reviews",
      body: { body: "hello", comments: [{ new_position: 4 }] },
    });
    expect(response.headers["x-total-count"]).toBe("51");
    expect(response.headers.link).toContain('rel="next"');
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect.each([
  "https://other.test/api/v1/user",
  "//other.test/api/v1/user",
  "../user",
  "/user#fragment",
  "https://user:password@forge.test/gitea/api/v1/user",
])("rejects an API path outside the selected login: %s", (path) => {
  const f = fixture();
  return Effect.gen(function* () {
    const cli = yield* GiteaCli.make;
    expect(
      (yield* cli.request({ operation: "read", method: "GET", path }).pipe(Effect.flip)).reason,
    ).toBe("failed");
    expect(f.resolveServer).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect(
  "keeps tea authentication failures instead of falling back to an environment token",
  () => {
    const f = fixture({ T3CODE_GITEA_TOKEN: "obsolete-token" });
    f.request.mockReturnValue(
      Effect.fail(
        new ForgejoCli.ForgejoCliError({
          command: "tea",
          cwd: "/w",
          reason: "authentication",
          httpStatus: 401,
          detail: "Expired tea login",
        }),
      ),
    );
    return Effect.gen(function* () {
      const cli = yield* GiteaCli.make;
      expect(
        yield* cli.request({ operation: "read", method: "GET", path: "/user" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "unauthenticated", status: 401 });
      expect((yield* cli.probeAuth).status).toBe("unauthenticated");
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);

function transportFixture(status = 200) {
  const run = vi.fn<VcsProcess.VcsProcess["Service"]["run"]>((input) => {
    expect(input.command).toBe("tea");
    const listing = input.args[0] === "login";
    return Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: listing ? JSON.stringify([login]) : '{"id":42}',
      stderr: listing
        ? ""
        : `Warning: diagnostic before HTTP response\nHTTP/2.0 ${status}\nX-Total-Count: 51\nRetry-After: 120\n\nWarning: diagnostic after HTTP response\n`,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });
  const layer = Layer.mergeAll(
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          T3CODE_GITEA_BASE_URL: target.baseUrl,
          T3CODE_GITEA_TOKEN: "unused-legacy-token",
        },
      }),
    ),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-tea-transport-test-" }),
    ForgejoCli.layer.pipe(Layer.provide(Layer.mock(VcsProcess.VcsProcess)({ run }))),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));
  return { layer, run };
}

it.effect("passes a mounted Gitea review through ForgejoCli to tea with JSON on stdin", () => {
  const f = transportFixture();
  return Effect.gen(function* () {
    const cli = yield* GiteaCli.make;
    const body = {
      event: "REQUEST_CHANGES",
      body: "See inline comments.",
      comments: [{ path: "a.ts", new_position: 4, body: "Use the upstream behavior." }],
    };
    const response = yield* cli.request({
      operation: "review",
      method: "POST",
      path: "/repos/acme/web/pulls/42/reviews",
      body: JSON.stringify(body),
      maxBytes: 1024,
    });
    const call = f.run.mock.calls.find(([input]) => input.args[0] === "api")?.[0];
    expect(call).toMatchObject({
      command: "tea",
      stdin: JSON.stringify(body),
      maxOutputBytes: 1024,
    });
    expect(call?.args).toEqual([
      "api",
      "--include",
      "--login",
      "work",
      "--method",
      "POST",
      "--data",
      "@-",
      "https://forge.test/gitea/api/v1/repos/acme/web/pulls/42/reviews",
    ]);
    expect(JSON.stringify(f.run.mock.calls)).not.toContain("unused-legacy-token");
    expect(response.body).toBe('{"id":42}');
    expect(response.headers).toEqual({ "x-total-count": "51", "retry-after": "120" });
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect.each([
  { status: 401, reason: "unauthenticated" },
  { status: 403, reason: "failed" },
  { status: 429, reason: "rate-limited" },
])("rejects tea's successful process exit when HTTP status is $status", ({ status, reason }) => {
  const f = transportFixture(status);
  return Effect.gen(function* () {
    const cli = yield* GiteaCli.make;
    const error = yield* cli
      .request({ operation: "read", method: "GET", path: "/user" })
      .pipe(Effect.flip);
    expect(error).toMatchObject({ reason, status });
    if (status === 429) expect(error.retryAt).toBe((yield* Clock.currentTimeMillis) + 120_000);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect("rejects a tea login whose proxy root differs from the configured server", () => {
  const f = fixture({ T3CODE_GITEA_BASE_URL: "https://forge.test" });
  return Effect.gen(function* () {
    const cli = yield* GiteaCli.make;
    const error = yield* cli
      .request({ operation: "read", method: "GET", path: "/user" })
      .pipe(Effect.flip);
    expect(error.detail).toContain("must match the tea login URL");
    expect(f.request).not.toHaveBeenCalled();
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});
