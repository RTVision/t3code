import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { builtInSourceControlDefinitions } from "./registry.ts";
import { definition } from "./gitea.ts";

describe("Gitea source-control ownership", () => {
  it("recognizes Gitea-looking remotes without claiming Forgejo or Codeberg", () => {
    expect(recognizeRemoteWith(definition, "https://gitea.example.test/team/repo.git")).toEqual({
      kind: "gitea",
      name: "Gitea",
      baseUrl: "https://gitea.example.test",
    });
    expect(
      recognizeRemoteWith(definition, "https://forgejo.example.test/team/repo.git"),
    ).toBeNull();
    expect(recognizeRemoteWith(definition, "https://codeberg.org/team/repo.git")).toBeNull();
  });

  it("keeps pull-request URLs owned by the matching host", () => {
    expect(
      builtInSourceControlDefinitions.findByChangeRequestUrl(
        "https://gitea.example.test/team/repo/pulls/7",
      )?.kind,
    ).toBe("gitea");
    expect(
      builtInSourceControlDefinitions.findByChangeRequestUrl(
        "https://forgejo.example.test/team/repo/pulls/7",
      )?.kind,
    ).toBe("forgejo");
    expect(
      builtInSourceControlDefinitions.findByChangeRequestUrl(
        "https://codeberg.org/team/repo/pulls/7",
      )?.kind,
    ).toBe("forgejo");
  });
});
