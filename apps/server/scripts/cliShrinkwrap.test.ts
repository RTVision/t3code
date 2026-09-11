import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { withCliShrinkwrap } from "./cliShrinkwrap.ts";

it.layer(NodeServices.layer)("publish shrinkwrap lifecycle", (it) => {
  it.effect("includes the generated shrinkwrap during packing and removes it afterward", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-publish-lock-" });
      const file = path.join(directory, "npm-shrinkwrap.json");
      const packed = yield* withCliShrinkwrap(file, "generated lock\n", fs.readFileString(file));
      assert.equal(packed, "generated lock\n");
      assert.isFalse(yield* fs.exists(file));
    }),
  );

  it.effect("restores a pre-existing shrinkwrap after publishing fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-publish-lock-" });
      const file = path.join(directory, "npm-shrinkwrap.json");
      yield* fs.writeFileString(file, "original lock\n");
      const error = yield* withCliShrinkwrap(
        file,
        "generated lock\n",
        Effect.fail("pack failed"),
      ).pipe(Effect.flip);
      assert.equal(error, "pack failed");
      assert.equal(yield* fs.readFileString(file), "original lock\n");
    }),
  );

  it.effect("restores the shrinkwrap when publishing is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-publish-lock-" });
      const file = path.join(directory, "npm-shrinkwrap.json");
      yield* fs.writeFileString(file, "original lock\n");
      const publishing = yield* Deferred.make<void>();
      const fiber = yield* withCliShrinkwrap(
        file,
        "generated lock\n",
        Deferred.succeed(publishing, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(publishing);
      yield* Fiber.interrupt(fiber);
      assert.equal(yield* fs.readFileString(file), "original lock\n");
    }),
  );
});
