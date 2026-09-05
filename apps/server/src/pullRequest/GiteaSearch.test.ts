import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { decodeGiteaSearchIssue, giteaSearchIssueNumber, giteaSearchPath } from "./GiteaSearch.ts";

describe("giteaSearchPath", () => {
  it("encodes pull-only text search and authored involvement", () => {
    const path = giteaSearchPath({
      repositoryPath: "/repos/acme/web",
      query: "needs review & fixes",
      state: "merged",
      involvement: "authored",
      viewer: "Reviewer",
      page: 2,
      limit: 50,
    });
    const url = new URL(path, "https://forge.example.test");

    expect([...url.searchParams.entries()]).toEqual([
      ["type", "pulls"],
      ["q", "needs review & fixes"],
      ["state", "closed"],
      ["page", "2"],
      ["limit", "50"],
      ["created_by", "Reviewer"],
    ]);
  });

  it("does not add review involvement to the repository endpoint", () => {
    const path = giteaSearchPath({
      repositoryPath: "/repos/acme/web",
      query: "review",
      state: "all",
      involvement: "reviewing",
      viewer: "Reviewer",
      page: 1,
      limit: 50,
    });

    expect(new URL(path, "https://forge.example.test").searchParams.get("created_by")).toBeNull();
  });
});

describe("giteaSearchIssueNumber", () => {
  it("keeps only positive integer issue numbers", () => {
    expect(giteaSearchIssueNumber({ number: 12 })).toBe(12);
    expect(giteaSearchIssueNumber({ number: 0 })).toBeNull();
    expect(giteaSearchIssueNumber({ number: "12" })).toBeNull();
    expect(Option.isSome(decodeGiteaSearchIssue({ number: 12 }))).toBe(true);
  });
});
