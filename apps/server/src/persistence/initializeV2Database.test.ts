// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeEvents from "node:events";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import { completeV2DatabaseTrial, initializeV2Database } from "./initializeV2Database.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  type ServiceUpdateRecord,
} from "../cloud/serviceProtocol.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ServiceLauncherClient from "../cloud/serviceLauncherClient.ts";

const withTrialDatabase = <E>(
  run: (paths: {
    directory: string;
    sourcePath: string;
    destinationPath: string;
  }) => Effect.Effect<void, E, FileSystem.FileSystem | Path.Path>,
) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-trial-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  const database = new NodeSqlite.DatabaseSync(sourcePath);
  try {
    database.exec(
      "CREATE TABLE messages (text TEXT); INSERT INTO messages VALUES ('Before upgrade')",
    );
  } finally {
    database.close();
  }
  return run({ directory, sourcePath, destinationPath }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcessEnvironment, {}),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
};

const trialUpdate = (sourcePath: string, id: string) => ({
  id,
  fromVersion: "0.0.67",
  targetVersion: "0.0.68",
  dbPath: sourcePath,
  status: "pending" as const,
});

const duringTrial = <A, E, R>(effect: Effect.Effect<A, E, R>, update: ServiceUpdateRecord) =>
  effect.pipe(
    Effect.provideService(HostProcessEnvironment, {
      [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        childVersion:
          update.status === "pending" || update.status === "committed"
            ? update.targetVersion
            : update.fromVersion,
        update,
      }),
    }),
  );

const readMessages = (filename: string) => {
  const database = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    return database
      .prepare("SELECT text FROM messages")
      .all()
      .map((row) => row.text);
  } finally {
    database.close();
  }
};

const writeServiceOutcome = (directory: string, update: ServiceUpdateRecord) => {
  const runtime = NodePath.join(directory, "runtime");
  NodeFS.mkdirSync(runtime, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(runtime, SERVICE_STATE_FILE),
    JSON.stringify({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: update.status === "committed" ? update.targetVersion : update.fromVersion,
      update,
    }),
  );
};

it.effect(
  "records prepared before launcher IPC and retires ownership only after its matching commit receipt",
  () =>
    withTrialDatabase(({ sourcePath, destinationPath }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pending = trialUpdate(sourcePath, "ipc-commit");
          yield* duringTrial(initializeV2Database(destinationPath), pending);
          const sent = yield* Deferred.make<void>();
          const messages = new NodeEvents.EventEmitter();
          const client = yield* duringTrial(
            ServiceLauncherClient.make({ currentVersion: pending.targetVersion }),
            pending,
          ).pipe(
            Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, {
              connected: true,
              on: (event, listener) => {
                messages.on(event, listener);
              },
              off: (event, listener) => {
                messages.off(event, listener);
              },
              send: (message, callback) => {
                assert.deepEqual(message, { type: "prepared", updateId: pending.id });
                const database = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
                try {
                  assert.equal(
                    database.prepare("SELECT phase FROM rtvision_v2_import_trial").get()?.phase,
                    "prepared",
                  );
                } finally {
                  database.close();
                }
                Deferred.doneUnsafe(sent, Effect.void);
                callback?.(null);
                return true;
              },
            }),
          );
          const completion = yield* duringTrial(
            completeV2DatabaseTrial(destinationPath, client.prepareTrial),
            pending,
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(sent);
          assert.isUndefined(completion.pollUnsafe());
          messages.emit("message", { type: "committed", updateId: "another-trial" });
          assert.isUndefined(completion.pollUnsafe());
          messages.emit("message", { type: "committed", updateId: pending.id });
          assert.equal((yield* Fiber.join(completion))?.status, "committed");
          const database = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
          try {
            assert.equal(
              database
                .prepare(
                  "SELECT count(*) AS count FROM sqlite_master WHERE name = 'rtvision_v2_import_trial'",
                )
                .get()?.count,
              0,
            );
          } finally {
            database.close();
          }
        }),
      ),
    ),
);

it.effect(
  "a failed first upgrade retry imports continued V1 work and removes the trial journals",
  () =>
    withTrialDatabase(({ sourcePath, destinationPath }) =>
      Effect.gen(function* () {
        yield* duringTrial(initializeV2Database(destinationPath), trialUpdate(sourcePath, "first"));
        const trial = new NodeSqlite.DatabaseSync(destinationPath);
        let wal: Buffer;
        let shm: Buffer;
        try {
          trial.exec(
            "PRAGMA journal_mode = WAL; INSERT INTO messages VALUES ('Discard trial work')",
          );
          wal = NodeFS.readFileSync(`${destinationPath}-wal`);
          shm = NodeFS.readFileSync(`${destinationPath}-shm`);
        } finally {
          trial.close();
        }
        // Retain the sidecars as an abruptly stopped trial does.
        NodeFS.writeFileSync(`${destinationPath}-wal`, wal);
        NodeFS.writeFileSync(`${destinationPath}-shm`, shm);
        const v1 = new NodeSqlite.DatabaseSync(sourcePath);
        try {
          v1.exec("INSERT INTO messages VALUES ('Continued after rollback')");
        } finally {
          v1.close();
        }
        yield* duringTrial(initializeV2Database(destinationPath), trialUpdate(sourcePath, "retry"));
        assert.deepEqual(readMessages(destinationPath), [
          "Before upgrade",
          "Continued after rollback",
        ]);
        assert.isFalse(NodeFS.existsSync(`${destinationPath}-wal`));
        assert.isFalse(NodeFS.existsSync(`${destinationPath}-shm`));
      }),
    ),
);

it.effect("a committed first upgrade retires trial ownership and preserves V2 work", () =>
  withTrialDatabase(({ sourcePath, destinationPath }) =>
    Effect.gen(function* () {
      const pending = trialUpdate(sourcePath, "committed");
      yield* duringTrial(initializeV2Database(destinationPath), pending);
      const outcome = {
        id: pending.id,
        fromVersion: pending.fromVersion,
        targetVersion: pending.targetVersion,
        status: "committed" as const,
      };
      yield* duringTrial(
        completeV2DatabaseTrial(destinationPath, Effect.succeed(outcome)),
        pending,
      );
      const v2 = new NodeSqlite.DatabaseSync(destinationPath);
      try {
        assert.equal(
          v2
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE name = 'rtvision_v2_import_trial'",
            )
            .get()?.count,
          0,
        );
        v2.exec("INSERT INTO messages VALUES ('Keep committed V2 work')");
      } finally {
        v2.close();
      }
      const v1 = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        v1.exec("INSERT INTO messages VALUES ('Later V1 work')");
      } finally {
        v1.close();
      }
      yield* duringTrial(
        initializeV2Database(destinationPath),
        trialUpdate(sourcePath, "later-upgrade"),
      );
      assert.deepEqual(readMessages(destinationPath), ["Before upgrade", "Keep committed V2 work"]);
    }),
  ),
);

it.effect(
  "a commit persisted before child death preserves V2 on committed and unmanaged restarts",
  () =>
    withTrialDatabase(({ directory, sourcePath, destinationPath }) =>
      Effect.gen(function* () {
        const pending = trialUpdate(sourcePath, "child-died");
        const outcome = {
          id: pending.id,
          fromVersion: pending.fromVersion,
          targetVersion: pending.targetVersion,
          status: "committed" as const,
        };
        for (const managed of [true, false]) {
          NodeFS.rmSync(destinationPath, { force: true });
          yield* duringTrial(initializeV2Database(destinationPath), pending);
          const failed = yield* Effect.result(
            duringTrial(
              completeV2DatabaseTrial(destinationPath, Effect.fail("child died after commit")),
              pending,
            ),
          );
          assert.equal(failed._tag, "Failure");
          writeServiceOutcome(directory, outcome);
          const v2 = new NodeSqlite.DatabaseSync(destinationPath);
          try {
            v2.exec("INSERT INTO messages VALUES ('Keep committed copy')");
          } finally {
            v2.close();
          }
          const restart = initializeV2Database(destinationPath, directory);
          yield* managed ? duringTrial(restart, outcome) : restart;
          assert.deepEqual(readMessages(destinationPath), [
            "Before upgrade",
            "Keep committed copy",
          ]);
        }
      }),
    ),
);

it.effect(
  "a prepared trial with an overwritten outcome preserves its database and fails closed",
  () =>
    withTrialDatabase(({ directory, sourcePath, destinationPath }) =>
      Effect.gen(function* () {
        const pending = trialUpdate(sourcePath, "uncertain");
        yield* duringTrial(initializeV2Database(destinationPath), pending);
        yield* Effect.result(
          duringTrial(
            completeV2DatabaseTrial(destinationPath, Effect.fail("disconnected")),
            pending,
          ),
        );
        const original = NodeFS.readFileSync(destinationPath);
        const retry = trialUpdate(sourcePath, "new-pending");
        writeServiceOutcome(directory, retry);
        assert.equal(
          (yield* Effect.result(
            duringTrial(initializeV2Database(destinationPath, directory), retry),
          ))._tag,
          "Failure",
        );
        assert.deepEqual(NodeFS.readFileSync(destinationPath), original);
        assert.equal(
          (yield* Effect.result(initializeV2Database(destinationPath, directory)))._tag,
          "Failure",
        );
        assert.deepEqual(NodeFS.readFileSync(destinationPath), original);
      }),
    ),
);

it.effect("an authoritative rollback permits a prepared trial to import current V1 again", () =>
  withTrialDatabase(({ directory, sourcePath, destinationPath }) =>
    Effect.gen(function* () {
      const pending = trialUpdate(sourcePath, "rolled-back");
      yield* duringTrial(initializeV2Database(destinationPath), pending);
      yield* Effect.result(
        duringTrial(
          completeV2DatabaseTrial(destinationPath, Effect.fail("trial timed out")),
          pending,
        ),
      );
      writeServiceOutcome(directory, {
        id: pending.id,
        fromVersion: pending.fromVersion,
        targetVersion: pending.targetVersion,
        status: "rolled-back",
      });
      const v1 = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        v1.exec("INSERT INTO messages VALUES ('Continued in V1')");
      } finally {
        v1.close();
      }
      yield* initializeV2Database(destinationPath, directory);
      assert.deepEqual(readMessages(destinationPath), ["Before upgrade", "Continued in V1"]);
    }),
  ),
);

it.effect(
  "a trial restart keeps its existing copy and a failed snapshot publishes no ownership",
  () =>
    withTrialDatabase(({ sourcePath, destinationPath }) =>
      Effect.gen(function* () {
        const pending = trialUpdate(sourcePath, "restarted");
        yield* duringTrial(initializeV2Database(destinationPath), pending);
        const original = NodeFS.readFileSync(destinationPath);
        yield* duringTrial(initializeV2Database(destinationPath), pending);
        assert.deepEqual(NodeFS.readFileSync(destinationPath), original);
        NodeFS.rmSync(destinationPath);
        NodeFS.writeFileSync(sourcePath, "invalid SQLite");
        assert.equal(
          (yield* Effect.result(duringTrial(initializeV2Database(destinationPath), pending)))._tag,
          "Failure",
        );
        assert.isFalse(NodeFS.existsSync(destinationPath));
      }),
    ),
);

it.effect(
  "invalid launcher context and malformed ownership never replace an existing trial copy",
  () =>
    withTrialDatabase(({ sourcePath, destinationPath }) =>
      Effect.gen(function* () {
        yield* duringTrial(
          initializeV2Database(destinationPath),
          trialUpdate(sourcePath, "preserved"),
        );
        const original = NodeFS.readFileSync(destinationPath);
        assert.equal(
          (yield* Effect.result(
            initializeV2Database(destinationPath).pipe(
              Effect.provideService(HostProcessEnvironment, {
                [SERVICE_LAUNCHER_CONTEXT_ENV]: "invalid context",
              }),
            ),
          ))._tag,
          "Failure",
        );
        assert.deepEqual(NodeFS.readFileSync(destinationPath), original);
        const database = new NodeSqlite.DatabaseSync(destinationPath);
        try {
          database.exec("UPDATE rtvision_v2_import_trial SET phase = 'invalid'");
        } finally {
          database.close();
        }
        const invalid = NodeFS.readFileSync(destinationPath);
        assert.equal(
          (yield* Effect.result(
            duringTrial(initializeV2Database(destinationPath), trialUpdate(sourcePath, "retry")),
          ))._tag,
          "Failure",
        );
        assert.deepEqual(NodeFS.readFileSync(destinationPath), invalid);
      }),
    ),
);

it.effect(
  "snapshots V1, imports transcripts lazily, and preserves both databases across switches",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v1-v2-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const threadId = ThreadId.make("legacy-thread");
    const seed = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'project', 'V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      for (let index = 0; index < 6; index++) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`message-${index}`}, ${threadId}, ${index % 2 ? "assistant" : "user"}, ${`Text ${index}`}, 0, ${`2026-01-0${index + 1}T00:00:00.000Z`}, ${`2026-01-0${index + 1}T00:00:00.000Z`})`;
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

    return Effect.gen(function* () {
      yield* seed;
      const original = NodeFS.readFileSync(sourcePath);
      const config = yield* ServerConfig.ServerConfig;
      const layerDatabase = SqlitePersistence.layerConfig.pipe(
        Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
      );
      const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(layerDatabase),
      );
      const layerSink = EventSink.layer.pipe(Layer.provide(layerStores));
      const layerImporter = LegacyV1ThreadImporter.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(layerStores, layerSink)),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        yield* legacy.reconcileShells;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shell = yield* projections.getThreadProjection(threadId);
        assert.equal(shell.thread.id, threadId);
        assert.deepEqual(
          shell.messages.map((message) => message.text),
          ["Text 4", "Text 5"],
        );
        const pending =
          yield* sql`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(pending[0]?.transcript_imported_at, null);
        yield* legacy.ensureTranscript(threadId);
        const transcript = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(
          transcript.messages.map((message) => message.text),
          ["Text 0", "Text 1", "Text 2", "Text 3", "Text 4", "Text 5"],
        );
        const imported =
          yield* sql`SELECT imported_message_count, transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(imported[0]?.imported_message_count, 6);
        assert.isNotNull(imported[0]?.transcript_imported_at);
        yield* sql`CREATE TABLE v2_work (text TEXT)`;
        yield* sql`INSERT INTO v2_work VALUES ('Keep V2 work')`;
      }).pipe(Effect.provide(layerImporter));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
      const v1 = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        assert.equal(
          v1.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
          52,
        );
        assert.equal(
          v1
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE name = 'orchestration_v2_legacy_imports'",
            )
            .get()?.count,
          0,
        );
        v1.exec("UPDATE projection_threads SET title = 'Continued in V1'");
      } finally {
        v1.close();
      }
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "Keep V2 work");
        assert.equal((yield* sql`SELECT title FROM projection_threads`)[0]?.title, "V1 thread");
      }).pipe(Effect.provide(layerDatabase));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);

it.effect("includes committed WAL data and does not publish a failed snapshot", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-snapshot-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  return Effect.gen(function* () {
    NodeFS.writeFileSync(sourcePath, "invalid SQLite");
    assert.isTrue((yield* Effect.result(initializeV2Database(destinationPath)))._tag === "Failure");
    assert.isFalse(NodeFS.existsSync(destinationPath));
    NodeFS.unlinkSync(sourcePath);
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('committed'); BEGIN; INSERT INTO messages VALUES ('uncommitted');",
      );
      yield* initializeV2Database(destinationPath);
      const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
      try {
        assert.deepEqual(
          copy
            .prepare("SELECT text FROM messages")
            .all()
            .map((row) => row.text),
          ["committed"],
        );
      } finally {
        copy.close();
      }
      source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("uses statev2.sqlite for default and explicit development paths", () =>
  Effect.gen(function* () {
    for (const devUrl of [undefined, new URL("http://localhost:5173")]) {
      for (const baseDirIsExplicit of [false, true]) {
        const paths = yield* ServerConfig.deriveServerPaths("/tmp/t3", devUrl, {
          baseDirIsExplicit,
        });
        assert.equal(NodePath.basename(paths.dbPath), "statev2.sqlite");
        assert.equal(paths.settingsPath, NodePath.join(paths.stateDir, "settings.json"));
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("starts fresh without V1 and never imports over existing V2 state", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-fresh-"));
  const destinationPath = NodePath.join(directory, "userdata", "statev2.sqlite");
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const layerDatabase = SqlitePersistence.layerConfig.pipe(
      Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE v2_work (text TEXT)`;
      yield* sql`INSERT INTO v2_work VALUES ('fresh V2 work')`;
    }).pipe(Effect.provide(layerDatabase));
    const sourcePath = NodePath.join(NodePath.dirname(destinationPath), "state.sqlite");
    assert.isFalse(NodeFS.existsSync(sourcePath));
    NodeFS.writeFileSync(sourcePath, "This source must never be opened once V2 exists");
    yield* initializeV2Database(destinationPath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "fresh V2 work");
    }).pipe(Effect.provide(layerDatabase));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
