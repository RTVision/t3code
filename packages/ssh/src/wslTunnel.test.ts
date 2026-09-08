import * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { SshRunner } from "./runner.ts";
import { forwardWslTunnel } from "./wslTunnel.ts";

const listen = Effect.fn("test.listen")(function* (
  server: NodeNet.Server,
  port: number,
  host: string,
) {
  return yield* Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen(port, host, () => resume(Effect.succeed(server)));
      return Effect.sync(() => {
        server.close();
      });
    }),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const exchange = Effect.fn("test.exchange")(function* (port: number, payload: string) {
  return yield* Effect.callback<string>((resume) => {
    const client = NodeNet.connect(port, "127.0.0.1");
    let received = "";
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      received += chunk;
    });
    client.once("error", (error) => resume(Effect.die(error)));
    client.once("end", () => resume(Effect.succeed(received)));
    client.once("connect", () => client.end(payload));
    return Effect.sync(() => {
      client.destroy();
    });
  });
});

describe("WSL desktop loopback bridge", () => {
  it.effect("forwards traffic to the distro adapter and releases the listener on disconnect", () =>
    Effect.gen(function* () {
      const remote = yield* listen(
        NodeNet.createServer((socket) => socket.pipe(socket)),
        0,
        "127.0.0.2",
      );
      const address = remote.address();
      if (!address || typeof address === "string")
        return yield* Effect.die("Expected an IP listener");
      const port = address.port;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* forwardWslTunnel(port);
          assert.equal(yield* exchange(port, "ssh-forward-test"), "ssh-forward-test");
        }).pipe(
          Effect.provideService(SshRunner, {
            kind: "wsl",
            distro: "Debian",
            homeDir: "/home/test",
            tunnelHost: "127.0.0.2",
          }),
        ),
      );
      yield* listen(NodeNet.createServer(), port, "127.0.0.1");
    }).pipe(Effect.scoped),
  );
});
