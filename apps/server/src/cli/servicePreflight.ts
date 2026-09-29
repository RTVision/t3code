import { HostProcessEnvironment, isHostWindows } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import { runServicePreflight } from "../cloud/servicePreflight.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";

/**
 * A native PTY addon built for the wrong libc can load and then segfault on its
 * first spawn, which a running server only reaches once a terminal opens.
 * Spawning one here turns that crash into a failed preflight, so the candidate
 * runtime is rejected before it replaces a working one.
 */
export const checkPtySpawns = Effect.gen(function* () {
  if (yield* isHostWindows) return;
  const pty = yield* PtyAdapter.PtyAdapter;
  const exited = yield* Deferred.make<void>();
  const child = yield* pty.spawn({
    shell: "/bin/sh",
    args: ["-c", "exit 0"],
    cwd: "/",
    cols: 80,
    rows: 24,
    env: yield* HostProcessEnvironment,
  });
  child.onExit(() => Deferred.doneUnsafe(exited, Effect.void));
  yield* Deferred.await(exited);
}).pipe(
  // A host that cannot open PTYs at all fails the same way on every version;
  // blocking on it would only stop that host from ever updating.
  Effect.catchTag("PtySpawnError", () => Effect.void),
  Effect.provide(NodePtyAdapter.layer),
);

export const servicePreflightCommand = Command.make("__service-preflight", {
  databasePath: Flag.String("database-path"),
  launcherProtocol: Flag.Int("launcher-protocol"),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ databasePath, launcherProtocol }) =>
    checkPtySpawns.pipe(
      Effect.andThen(
        Console.log(JSON.stringify(runServicePreflight({ databasePath, launcherProtocol }))),
      ),
      Effect.asVoid,
    ),
  ),
);
