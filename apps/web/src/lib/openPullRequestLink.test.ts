import { describe, expect, it } from "vite-plus/test";

import { findProjectOnChangeRequestHost } from "./openPullRequestLink";

describe("findProjectOnChangeRequestHost", () => {
  const project = (id: string, identity: Record<string, unknown>) =>
    ({ id, repositoryIdentity: identity }) as never;
  const frontend = project("frontend", {
    canonicalKey: "github.com/acme/frontend",
    provider: "github",
    owner: "acme",
    name: "frontend",
  });
  const backend = project("backend", {
    canonicalKey: "github.com/acme/backend",
    provider: "github",
    owner: "acme",
    name: "backend",
  });

  it("prefers the project checked out from the link's own repository", () => {
    expect(
      findProjectOnChangeRequestHost([frontend, backend], {
        host: "github.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBe(backend);
  });

  it("lends any project on the host to a repository nobody has checked out", () => {
    expect(
      findProjectOnChangeRequestHost([frontend], {
        host: "github.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBe(frontend);
  });

  it("borrows Gitea credentials only from the same web root", () => {
    const checkout = project("gitea", {
      canonicalKey: "forge.example.test/gitea/acme/web",
      provider: "gitea",
      displayName: "acme/web",
      locator: { remoteUrl: "https://forge.example.test/gitea/acme/web.git" },
    });
    const link = parseChangeRequestUrl("https://forge.example.test/gitea/acme/other/pulls/7")!;
    expect(findProjectOnChangeRequestHost([checkout], link)).toBe(checkout);
    for (const url of [
      "https://forge.example.test/other/acme/other/pulls/7",
      "https://forge.example.test/acme/other/pulls/7",
      "https://forge.example.test:8443/gitea/acme/other/pulls/7",
    ]) {
      expect(
        findProjectOnChangeRequestHost([checkout], parseChangeRequestUrl(url)!),
      ).toBeUndefined();
    }
  });

  it("finds nothing on a host nothing is checked out from", () => {
    expect(
      findProjectOnChangeRequestHost([frontend], {
        host: "gitlab.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBeUndefined();
  });
});
