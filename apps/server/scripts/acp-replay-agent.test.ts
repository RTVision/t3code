// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { expect, it } from "@effect/vitest";

it("keeps replay status readable during publication and complete before answering", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-acp-status-"));
  const statusPath = NodePath.join(directory, "status.json");
  const observerPath = NodePath.join(directory, "observe-status.mjs");
  // Observe from inside the child's write, after truncation and before its bytes
  // are written. Also read at the response boundary, before the client sees it.
  NodeFS.writeFileSync(
    observerPath,
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
const statusPath = process.env.T3_ACP_REPLAY_STATUS_PATH;
const writeFile = fs.writeFileSync;
fs.writeFileSync = (path, data, options) => {
  const hasPublishedStatus = fs.existsSync(statusPath);
  const descriptor = fs.openSync(path, "w");
  try {
    if (hasPublishedStatus) JSON.parse(fs.readFileSync(statusPath, "utf8"));
    return writeFile(descriptor, data, options);
  } finally {
    fs.closeSync(descriptor);
  }
};
syncBuiltinESMExports();
const writeOutput = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => {
  const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.equal(status.cursor, status.total);
  return writeOutput(...args);
};
`,
  );
  try {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--import",
        NodeURL.pathToFileURL(observerPath).href,
        "--experimental-strip-types",
        NodeURL.fileURLToPath(new URL("./acp-replay-agent.ts", import.meta.url)),
      ],
      {
        encoding: "utf8",
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
        env: {
          ...process.env,
          T3_ACP_REPLAY_TRANSCRIPT_PATH: undefined,
          T3_ACP_REPLAY_TRANSCRIPT: Buffer.from(
            JSON.stringify({
              scenario: "status-publication",
              entries: [
                {
                  type: "expect_outbound",
                  frame: { kind: "request", method: "initialize", params: {} },
                },
                {
                  type: "emit_inbound",
                  frame: { kind: "response", method: "initialize", result: {} },
                },
              ],
            }),
          ).toString("base64"),
          T3_ACP_REPLAY_STATUS_PATH: statusPath,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(JSON.parse(NodeFS.readFileSync(statusPath, "utf8"))).toEqual({
      scenario: "status-publication",
      cursor: 2,
      total: 2,
    });
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
