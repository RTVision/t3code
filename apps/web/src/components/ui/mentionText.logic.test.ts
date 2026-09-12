import { describe, expect, it } from "vite-plus/test";
import { insertMention, mentionAtCursor, mentionCandidates } from "./mentionText.logic";

describe("review mentions", () => {
  it("recognizes a mention at the caret without treating email addresses as mentions", () => {
    expect(mentionAtCursor("Please @al", 10)).toEqual({ start: 7, end: 10, query: "al" });
    expect(mentionAtCursor("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionAtCursor("a@example.com", 13)).toBeNull();
    expect(mentionAtCursor("@alice", 1, 6)).toBeNull();
  });
  it("matches names, removes duplicate logins, and prefers matching usernames", () => {
    expect(
      mentionCandidates(
        [{ login: "bob", name: "Alice Brown" }, { login: "alice" }, { login: "Alice" }],
        "ali",
      ).map((person) => person.login),
    ).toEqual(["alice", "bob"]);
  });
  it("replaces only the typed mention and keeps the surrounding review intact", () => {
    expect(insertMention("Please @al review this", { start: 7, end: 10 }, "alice")).toEqual({
      value: "Please @alice review this",
      cursor: 14,
    });
    expect(insertMention("@al", { start: 0, end: 3 }, "alice")).toEqual({
      value: "@alice ",
      cursor: 7,
    });
  });
});
