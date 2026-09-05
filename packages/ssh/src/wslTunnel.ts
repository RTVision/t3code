import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";

import { SshCommandError } from "./errors.ts";
import { SshRunner } from "./runner.ts";

// Keep the desktop HTTP bridge restricted to Windows loopback. NAT-mode WSL
// listeners are reached over the distro adapter, avoiding delayed wslhost forwarding.
export const forwardWslTunnel = Effect.fn("ssh/wslTunnel.forward")(function* (localPort: number) {
  const runner = yield* SshRunner;
  if (runner.kind !== "wsl" || runner.tunnelHost === "127.0.0.1") return;
  yield* Effect.acquireRelease(
    Effect.callback<
      { readonly server: NodeNet.Server; readonly sockets: Set<NodeNet.Socket> },
      SshCommandError
    >((resume) => {
      const sockets = new Set<NodeNet.Socket>();
      const server = NodeNet.createServer({ allowHalfOpen: true }, (client) => {
        const upstream = NodeNet.connect({
          host: runner.tunnelHost,
          port: localPort,
          allowHalfOpen: true,
        });
        sockets.add(client);
        sockets.add(upstream);
        const close = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.once("error", close);
        upstream.once("error", close);
        client.once("close", close);
        upstream.once("close", close);
        client.pipe(upstream).pipe(client);
      });
      server.once("error", (cause) =>
        resume(
          Effect.fail(
            new SshCommandError({
              command: ["wsl.exe"],
              exitCode: null,
              stderr: "",
              message: `Could not open the desktop tunnel bridge via WSL (${runner.distro}).`,
              cause,
            }),
          ),
        ),
      );
      server.listen(localPort, "127.0.0.1", () => resume(Effect.succeed({ server, sockets })));
      return Effect.sync(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
      });
    }),
    ({ server, sockets }) =>
      Effect.sync(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
      }),
  );
});
