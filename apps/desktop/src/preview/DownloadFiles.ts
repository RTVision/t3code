// FileSystem.copyFile has no exclusive-create flag; Node's COPYFILE_EXCL prevents overwrites.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class DownloadCopyError extends Schema.TaggedError<DownloadCopyError>()(
  "DownloadCopyError",
  {
    source: Schema.String,
    target: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const isAlreadyExists = Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }));

/** Copies a completed browser download without replacing another download or an existing file. */
export const copyDownload = Effect.fn("copyDownload")(function* (
  source: string,
  directory: string,
  fileName: string,
) {
  const path = yield* Path.Path;
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension) || "download";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const target = path.join(
      directory,
      attempt === 0 ? `${stem}${extension}` : `${stem} (${attempt})${extension}`,
    );
    const copied = yield* Effect.tryPromise({
      try: () => NodeFSP.copyFile(source, target, NodeFS.constants.COPYFILE_EXCL),
      catch: (cause) => new DownloadCopyError({ source, target, cause }),
    }).pipe(
      Effect.as(true),
      Effect.catchTags({
        DownloadCopyError: (error) =>
          isAlreadyExists(error.cause) ? Effect.succeed(false) : Effect.fail(error),
      }),
    );
    if (copied) return target;
  }
  return yield* new DownloadCopyError({
    source,
    target: directory,
    cause: new Error("No unused download filename remains after 100 attempts."),
  });
});
