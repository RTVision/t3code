import { FolderClosedIcon } from "lucide-react";
import { FileExplorerIcon, FinderIcon } from "../Icons";
import { resolveOpenInOptions } from "./OpenInPicker";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldShowOpenInPicker } from "./OpenInPicker.logic";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");
  const remoteEnvironmentId = EnvironmentId.make("environment-remote");
  const contexts = [
    [
      "primary local environment",
      {
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      },
    ],
    [
      "remote environment with an SSH route",
      {
        activeThreadEnvironmentId: remoteEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      },
    ],
    [
      "remote environment without an SSH route",
      {
        activeThreadEnvironmentId: remoteEnvironmentId,
        primaryEnvironmentId: null,
        remoteOpenMode: "remote-unavailable",
      },
    ],
    [
      "nonprimary local environment",
      {
        activeThreadEnvironmentId: remoteEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      },
    ],
  ] as const;

  it.each(contexts)("shows the picker for a project in a %s", (_name, context) => {
    const project = { ...context, activeProjectName: "codething-mvp" };
    expect(shouldShowOpenInPicker(project)).toBe(true);
  });

  it.each(contexts)("hides the picker without a project in a %s", (_name, context) => {
    const project = { ...context, activeProjectName: undefined };
    expect(shouldShowOpenInPicker(project)).toBe(false);
  });
});

describe("resolveOpenInOptions", () => {
  it.each([
    ["MacIntel", "Finder", FinderIcon],
    ["Win32", "File Explorer", FileExplorerIcon],
    ["Linux x86_64", "Files", FolderClosedIcon],
  ] as const)("includes the file manager with its icon on %s", (platform, label, Icon) => {
    expect(resolveOpenInOptions(platform, ["cursor", "vscode", "file-manager"])).toEqual([
      expect.objectContaining({ value: "cursor", label: "Cursor" }),
      expect.objectContaining({ value: "vscode", label: "VS Code" }),
      expect.objectContaining({ value: "file-manager", label, Icon }),
    ]);
  });

  it("omits the file manager when unavailable or using remote editors", () => {
    expect(resolveOpenInOptions("MacIntel", ["vscode"])).toEqual([
      expect.objectContaining({ value: "vscode" }),
    ]);
    expect(resolveOpenInOptions("MacIntel", [])).toEqual([]);
  });
});
