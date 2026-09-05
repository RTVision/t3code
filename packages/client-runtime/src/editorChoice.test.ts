import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { BearerConnectionTarget, PrimaryConnectionTarget } from "./connection/model.ts";
import {
  editorTargetFromLegacy,
  editorWorkspace,
  guiEditorTarget,
  resolveEditorChoice,
  terminalEditorConnectionRef,
} from "./editorChoice.ts";
const environmentId = EnvironmentId.make("test-environment");
describe("editor choice", () => {
  it("retains explicitly selected Neovim when detection cannot offer it", () => {
    expect(
      resolveEditorChoice({ kind: "terminal", editor: "neovim" }, null, "vscode", ["vscode"]),
    ).toEqual({ kind: "terminal", editor: "neovim" });
  });
  it("migrates legacy choices without silently selecting a terminal editor", () => {
    expect(resolveEditorChoice(null, null, "vscode", ["vscode", "cursor"])).toEqual({
      kind: "gui",
      editor: "vscode",
    });
    expect(resolveEditorChoice(null, null, null, [])).toBeNull();
  });
  it("uses connection ownership, never a forwarded localhost URL, for desktop routing", () => {
    const target = {
      environmentId,
      label: "host",
      httpBaseUrl: "http://localhost:2222",
      wsBaseUrl: "ws://localhost:2222",
    };
    expect(terminalEditorConnectionRef(new PrimaryConnectionTarget(target), environmentId)).toEqual(
      { kind: "primary" },
    );
    expect(
      terminalEditorConnectionRef(
        new BearerConnectionTarget({ ...target, connectionId: "local:wsl:Ubuntu" }),
        environmentId,
      ),
    ).toEqual({ kind: "local", backendId: "wsl:Ubuntu" });
    expect(
      terminalEditorConnectionRef(
        new BearerConnectionTarget({ ...target, connectionId: "manual-forward" }),
        environmentId,
      ),
    ).toEqual({ kind: "saved", environmentId });
    expect(terminalEditorConnectionRef(null, environmentId)).toBeNull();
  });
  it("keeps workspace separate from a positioned file outside it", () => {
    const target = editorTargetFromLegacy("/outside/file.ts:12:5");
    expect(target).toEqual({
      kind: "file",
      path: "/outside/file.ts",
      line: 12,
      column: 5,
      columnEncoding: "utf-16",
    });
    expect(editorWorkspace(target, "/project/worktree")).toBe("/project/worktree");
    expect(editorWorkspace(target)).toBe("/outside");
    expect(editorWorkspace({ kind: "file", path: "file.txt" })).toBe(".");
    expect(guiEditorTarget(target)).toBe("/outside/file.ts:12:5");
    expect(editorWorkspace({ kind: "file", path: "C:\\config.json" })).toBe("C:\\");
  });
});
