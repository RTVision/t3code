import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { copyDownload } from "./DownloadFiles.ts";

it.effect("preserves concurrent same-name downloads and a preexisting file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const sources = [path.join(directory, "first"), path.join(directory, "second")];
    yield* fs.writeFileString(sources[0]!, "first download");
    yield* fs.writeFileString(sources[1]!, "second download");
    const existing = path.join(directory, "report.pdf");
    yield* fs.writeFileString(existing, "existing file");
    const targets = yield* Effect.all(
      sources.map((source) => copyDownload(source, directory, "report.pdf")),
      { concurrency: "unbounded" },
    );
    assert.notStrictEqual(targets[0], targets[1]);
    assert.strictEqual(yield* fs.readFileString(existing), "existing file");
    assert.strictEqual(yield* fs.readFileString(targets[0]!), "first download");
    assert.strictEqual(yield* fs.readFileString(targets[1]!), "second download");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("reports a missing download source instead of retrying filename collisions", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const error = yield* copyDownload(
      path.join(directory, "missing"),
      directory,
      "report.pdf",
    ).pipe(Effect.flip);
    assert.strictEqual(error._tag, "DownloadCopyError");
    assert.deepStrictEqual(yield* fs.readDirectory(directory), []);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
