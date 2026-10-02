import * as NodeSqlite from "node:sqlite";

import type { ServerSelfUpdateOutcome } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  decodeServiceLauncherContext,
  parseServiceState,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_STATE_FILE,
  type ServiceUpdateRecord,
} from "../cloud/serviceProtocol.ts";

const trialTable = "rtvision_v2_import_trial";
const TrialImport = Schema.Struct({
  update_id: Schema.NonEmptyString,
  from_version: Schema.NonEmptyString,
  target_version: Schema.NonEmptyString,
  phase: Schema.Literals(["imported", "prepared"]),
});
const decodeTrialImport = Schema.decodeUnknownSync(TrialImport);

const readTrialImport = (database: NodeSqlite.DatabaseSync) => {
  if (!database.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(trialTable)) {
    return undefined;
  }
  const rows = database.prepare(`SELECT * FROM ${trialTable}`).all();
  if (rows.length !== 1) throw new Error("The V2 trial import record is invalid.");
  return decodeTrialImport(rows[0]);
};

const matchesTrial = (update: ServiceUpdateRecord | undefined, trial: typeof TrialImport.Type) =>
  update?.id === trial.update_id &&
  update.fromVersion === trial.from_version &&
  update.targetVersion === trial.target_version;

const withDatabase = <A>(
  filename: string,
  readOnly: boolean,
  use: (db: NodeSqlite.DatabaseSync) => A,
) => {
  const database = new NodeSqlite.DatabaseSync(filename, { readOnly });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    return use(database);
  } finally {
    database.close();
  }
};

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}
const isV2DatabaseImportError = Schema.is(V2DatabaseImportError);

/** Seed V2 once. Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
  baseDir?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  const environment = yield* HostProcessEnvironment;
  const rawContext = environment[SERVICE_LAUNCHER_CONTEXT_ENV];
  const context = rawContext === undefined ? undefined : decodeServiceLauncherContext(rawContext);
  const pending =
    context?.update?.status === "pending" &&
    path.normalize(context.update.dbPath) === path.normalize(sourcePath)
      ? context.update
      : undefined;
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) {
      const trial = yield* Effect.try(() => withDatabase(destinationPath, true, readTrialImport));
      if (trial === undefined) return;
      if (rawContext !== undefined && context === undefined) {
        return yield* new V2DatabaseImportError({
          sourcePath,
          destinationPath,
          cause: new Error("The service launcher supplied invalid startup context."),
        });
      }
      const statePath = path.join(
        baseDir ?? path.dirname(directory),
        "runtime",
        SERVICE_STATE_FILE,
      );
      const state = (yield* fs.exists(statePath))
        ? parseServiceState(yield* fs.readFileString(statePath))
        : undefined;
      const outcome = matchesTrial(state?.update, trial)
        ? state?.update
        : matchesTrial(context?.update, trial)
          ? context?.update
          : undefined;
      if (outcome?.status === "committed") {
        yield* Effect.try(() =>
          withDatabase(destinationPath, false, (database) =>
            database.exec(`DROP TABLE ${trialTable}`),
          ),
        );
        return;
      }
      if (pending !== undefined && matchesTrial(pending, trial)) return;
      const rolledBack = outcome?.status === "rolled-back" || outcome?.status === "failed";
      if (!rolledBack && !(trial.phase === "imported" && pending !== undefined)) {
        return yield* new V2DatabaseImportError({
          sourcePath,
          destinationPath,
          cause: new Error(
            "The previous V2 trial may have committed. Its database was preserved; recovery requires a matching committed or rollback record.",
          ),
        });
      }
      if (!(yield* fs.exists(sourcePath))) {
        return yield* new V2DatabaseImportError({
          sourcePath,
          destinationPath,
          cause: new Error(
            "The V1 source for the failed V2 trial is missing. Its database was preserved.",
          ),
        });
      }
      // The previous trial is stopped. Remove its journal before publishing another snapshot.
      for (const suffix of ["-wal", "-shm", "-journal", ""]) {
        yield* fs.remove(`${destinationPath}${suffix}`, { force: true });
      }
    }
    if (!(yield* fs.exists(sourcePath))) return;
    if (rawContext !== undefined && context === undefined) {
      return yield* new V2DatabaseImportError({
        sourcePath,
        destinationPath,
        cause: new Error("The service launcher supplied invalid startup context."),
      });
    }
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".v2-import-",
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise(async () => {
      const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        await NodeSqlite.backup(database, snapshotPath);
      } finally {
        database.close();
      }
      if (pending !== undefined) {
        withDatabase(snapshotPath, false, (snapshot) => {
          // The published hard link must contain the marker without depending on scratch WAL files.
          snapshot.exec(
            `PRAGMA journal_mode = DELETE; CREATE TABLE ${trialTable} (update_id TEXT NOT NULL, from_version TEXT NOT NULL, target_version TEXT NOT NULL, phase TEXT NOT NULL);`,
          );
          snapshot
            .prepare(`INSERT INTO ${trialTable} VALUES (?, ?, ?, 'imported')`)
            .run(pending.id, pending.fromVersion, pending.targetVersion);
        });
      }
    });
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs
      .link(snapshotPath, destinationPath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      isV2DatabaseImportError(cause)
        ? cause
        : new V2DatabaseImportError({ sourcePath, destinationPath, cause }),
    ),
  );
});

/** Mark commit intent before IPC, then retire ownership before startup accepts work. */
export const completeV2DatabaseTrial = Effect.fn("completeV2DatabaseTrial")(function* <E, R>(
  destinationPath: string,
  prepareTrial: Effect.Effect<ServerSelfUpdateOutcome | undefined, E, R>,
) {
  const path = yield* Path.Path;
  const sourcePath = path.join(path.dirname(destinationPath), "state.sqlite");
  const environment = yield* HostProcessEnvironment;
  const rawContext = environment[SERVICE_LAUNCHER_CONTEXT_ENV];
  const context = rawContext === undefined ? undefined : decodeServiceLauncherContext(rawContext);
  const mark = (outcome?: ServerSelfUpdateOutcome) =>
    Effect.try({
      try: () =>
        withDatabase(destinationPath, false, (database) => {
          const trial = readTrialImport(database);
          if (trial === undefined) return;
          const update = outcome ?? context?.update;
          if (!matchesTrial(update, trial))
            throw new Error("The V2 import belongs to another service update.");
          if (outcome?.status === "committed") database.exec(`DROP TABLE ${trialTable}`);
          else if (update?.status === "pending")
            database.exec(`UPDATE ${trialTable} SET phase = 'prepared'`);
        }),
      catch: (cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause }),
    });
  yield* mark();
  const outcome = yield* prepareTrial;
  if (outcome?.status === "committed") yield* mark(outcome);
  return outcome;
});
