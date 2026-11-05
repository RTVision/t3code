import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const require = NodeModule.createRequire(import.meta.url);
// The packaged tsrs binary requires glibc; Effect's Go compiler also runs on musl.
const compiler =
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Compiler selection runs before Effect is loaded.
  process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime
    ? "tsc"
    : "tsrs";
const entry = NodePath.join(
  NodePath.dirname(require.resolve("@effect/tsgo/package.json")),
  "dist/effect-tsgo.cjs",
);
const result = NodeChildProcess.spawnSync(
  process.execPath,
  [entry, compiler, "--noEmit", ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
