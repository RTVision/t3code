import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { NodePtyModuleLoaderRef, NodePtyModuleLoadError } from "../terminal/NodePtyAdapter.ts";
import { checkPtySpawns } from "./servicePreflight.ts";

const withNodePty = (load: () => Promise<typeof import("node-pty")>) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HostProcessPlatform, "linux"),
    Layer.succeed(HostProcessArchitecture, "x64"),
    Layer.succeed(NodePtyModuleLoaderRef, load),
  );

it.effect("does not block an update on a host that cannot open PTYs", () =>
  checkPtySpawns.pipe(
    Effect.provide(
      withNodePty(() =>
        Promise.resolve({
          spawn: () => {
            throw new Error("open /dev/ptmx failed");
          },
        } as unknown as typeof import("node-pty")),
      ),
    ),
  ),
);

it.effect("fails when the runtime's node-pty cannot load", () =>
  Effect.gen(function* () {
    const exit = yield* checkPtySpawns.pipe(
      Effect.provide(withNodePty(() => Promise.reject(new Error("invalid ELF header")))),
      Effect.exit,
    );
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.instanceOf(Cause.squash(exit.cause), NodePtyModuleLoadError);
    }
  }),
);

it.effect("kills a PTY that never exits and fails the preflight", () =>
  Effect.gen(function* () {
    const kills: Array<string | undefined> = [];
    const spawned = yield* Deferred.make<void>();
    const fiber = yield* checkPtySpawns.pipe(
      Effect.provide(
        withNodePty(() =>
          Promise.resolve({
            spawn: () => {
              Deferred.doneUnsafe(spawned, Effect.void);
              return {
                pid: 42,
                kill: (signal?: string) => kills.push(signal),
                onExit: () => ({ dispose: () => {} }),
              };
            },
          } as unknown as typeof import("node-pty")),
        ),
      ),
      Effect.exit,
      Effect.forkChild,
    );
    yield* Deferred.await(spawned);
    yield* TestClock.adjust("10 seconds");
    const exit = yield* Fiber.join(fiber);
    assert.isTrue(Exit.isFailure(exit));
    assert.equal(kills.length, 1);
  }),
);
