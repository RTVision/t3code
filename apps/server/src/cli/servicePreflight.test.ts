import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

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
