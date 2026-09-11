import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { ServerCliCommandExitError } from "./cliErrors.ts";

interface ReleaseManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Record<string, string>;
  readonly overrides: Record<string, string>;
  readonly publishConfig?: { readonly registry: string };
}

/** npm ignores overrides in installed packages; publish the resulting resolution instead. */
export const generateCliShrinkwrap = Effect.fn("cli.generateShrinkwrap")(function* (
  manifest: ReleaseManifest,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-lock-" });
  // Only pass the Effect package pins. Workspace overrides also contain pnpm-only
  // selectors and dependency removals, which npm cannot interpret.
  const overrides = Object.fromEntries(
    Object.entries(manifest.overrides).filter(
      ([name]) => name === "effect" || /^@effect\/[a-z0-9-]+$/.test(name),
    ),
  );
  yield* fs.writeFileString(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      private: true,
      dependencies: manifest.dependencies,
      overrides,
    }),
  );
  const command = yield* resolveSpawnCommand("npm", [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--include=optional",
    "--no-audit",
    "--no-fund",
    ...(manifest.publishConfig ? ["--registry", manifest.publishConfig.registry] : []),
  ]);
  const child = yield* spawner.spawn(
    ChildProcess.make(command.command, command.args, {
      cwd: directory,
      stdout: "ignore",
      stderr: "inherit",
      shell: command.shell,
    }),
  );
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: directory,
      exitCode,
    });
  }
  // Lock-only resolution retains optional platform packages without installing
  // a host-specific node_modules tree or running native build scripts.
  return yield* fs.readFileString(path.join(directory, "package-lock.json"));
}, Effect.scoped);

/** Restore an existing shrinkwrap, including after a failed or interrupted publish. */
export const withCliShrinkwrap = <A, E, R>(
  filePath: string,
  contents: string,
  publish: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return (yield* fs.exists(filePath)) ? yield* fs.readFile(filePath) : undefined;
    }),
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(filePath, contents);
        return yield* publish;
      }),
    (original) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (original === undefined) yield* fs.remove(filePath, { force: true });
        else yield* fs.writeFile(filePath, original);
      }),
  );
