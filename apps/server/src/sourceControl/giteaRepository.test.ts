import { assert, it } from "@effect/vitest";

import {
  giteaPullRequestNumber,
  giteaRepositoryFromRemote,
  parseGiteaRepository,
} from "./giteaRepository.ts";

it("matches configured HTTPS and SSH remotes without guessing the hosting provider", () => {
  const base = "https://forge.example.test:8443/gitea";
  for (const remote of [
    "https://forge.example.test:8443/gitea/team/repo.git",
    "ssh://git@forge.example.test:2222/team/repo.git",
    "git@forge.example.test:team/repo.git",
  ]) {
    assert.strictEqual(giteaRepositoryFromRemote(remote, base), "team/repo");
  }
  for (const remote of [
    "git@github.com:team/repo.git",
    "git@unrelated.test:team/repo.git",
    "https://forge.example.test/gitea/team/repo.git",
    "https://forge.example.test:8443/team/repo.git",
    "https://forge.example.test:8443/gitea-other/team/repo.git",
  ]) {
    assert.isNull(giteaRepositoryFromRemote(remote, base));
  }
});

it("rejects nested groups and traversal repository locators", () => {
  assert.strictEqual(parseGiteaRepository(" team/repo.git "), "team/repo");
  for (const locator of [
    "../repo",
    "team/..",
    "team/repo/more",
    "team/",
    "team/a?b",
    "team/a#b",
    "team/a%2fb",
  ]) {
    assert.isNull(parseGiteaRepository(locator));
  }
});

it("accepts PR numbers and URLs only from the selected repository", () => {
  const base = "https://forge.example.test/gitea";
  assert.strictEqual(giteaPullRequestNumber("#42", "team/repo", base), 42);
  assert.strictEqual(giteaPullRequestNumber(`${base}/team/repo/pulls/42`, "team/repo", base), 42);
  assert.strictEqual(
    giteaPullRequestNumber(`${base}/TEAM/REPO/pulls/42/files`, "team/repo", base),
    42,
  );
  assert.strictEqual(
    giteaPullRequestNumber(`${base}/%C3%A9quipe/r%C3%A9po/pulls/43/files`, "équipe/répo", base),
    43,
  );
  for (const ref of [
    "0",
    "-1",
    "9007199254740992",
    `${base}/team/other/pulls/42`,
    "https://elsewhere.test/team/repo/pulls/42",
    `${base}/team/repo/pull/42`,
  ]) {
    assert.isNull(giteaPullRequestNumber(ref, "team/repo", base));
  }
});

it("accepts only explicit SSH aliases without extending the trusted HTTP origin", () => {
  const base = "https://forge.example.test/gitea";
  const aliases = ["work-forge", "ssh.example.test"];
  assert.strictEqual(
    giteaRepositoryFromRemote("git@work-forge:team/repo.git", base, aliases),
    "team/repo",
  );
  assert.strictEqual(
    giteaRepositoryFromRemote("ssh://git@SSH.EXAMPLE.TEST:2222/team/repo.git", base, aliases),
    "team/repo",
  );
  assert.isNull(giteaRepositoryFromRemote("git@other-forge:team/repo.git", base, aliases));
  assert.isNull(
    giteaRepositoryFromRemote("https://ssh.example.test/gitea/team/repo.git", base, aliases),
  );
  assert.isNull(giteaRepositoryFromRemote("git@work-forge:../repo.git", base, aliases));
});
