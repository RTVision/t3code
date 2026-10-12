import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolvePullRequestImageAsset } from "./pullRequestMarkdown.logic";

describe("pull request image assets", () => {
  const source = "attachments/82cde921-c3fc-4c01-85b8-edf737cdaa83";

  it("routes a Gitea upload through the environment's signed image assets", () => {
    expect(
      resolvePullRequestImageAsset(
        source,
        SourceControlProviderKind.make("gitea"),
        "https://forge.test/rtvision/monorepo",
      ),
    ).toEqual({
      _tag: "source-control-image",
      provider: SourceControlProviderKind.make("gitea"),
      url: `https://forge.test/${source}`,
    });
  });

  it("retains a Gitea installation's subpath", () => {
    expect(
      resolvePullRequestImageAsset(
        source,
        SourceControlProviderKind.make("gitea"),
        "https://forge.test/gitea/acme/web/",
      )?.url,
    ).toBe(`https://forge.test/gitea/${source}`);
  });

  it("keeps workspace and other providers' images on their existing paths", () => {
    expect(
      resolvePullRequestImageAsset(
        "src/image.png",
        SourceControlProviderKind.make("gitea"),
        "https://forge.test/acme/web",
      ),
    ).toBeNull();
    expect(
      resolvePullRequestImageAsset(
        source,
        SourceControlProviderKind.make("github"),
        "https://github.com/acme/web",
      ),
    ).toBeNull();
    expect(
      resolvePullRequestImageAsset(source, SourceControlProviderKind.make("gitea"), null),
    ).toBeNull();
  });
});
