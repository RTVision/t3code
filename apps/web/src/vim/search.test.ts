import { describe, expect, it } from "vite-plus/test";
import { nextMatchIndex, searchConversation } from "./search";

describe("conversation search", () => {
  it("finds every literal occurrence in user and assistant text, excluding tool output", () => {
    expect(
      searchConversation(
        [
          { id: "1", role: "user", text: "Why [x]?" },
          { id: "2", role: "tool", text: "[x]" },
          { id: "3", role: "assistant", text: "[X] and [x]" },
        ],
        "[x]",
      ).map(({ messageId, offset }) => [messageId, offset]),
    ).toEqual([
      ["1", 4],
      ["3", 0],
      ["3", 8],
    ]);
  });
  it("returns no matches for empty queries", () => {
    expect(searchConversation([{ id: "1", role: "user", text: "text" }], "")).toEqual([]);
  });
  it("wraps forward and backward with counts and handles no matches", () => {
    expect(nextMatchIndex(2, 3, 1)).toBe(0);
    expect(nextMatchIndex(0, 3, -1)).toBe(2);
    expect(nextMatchIndex(0, 3, 5)).toBe(2);
    expect(nextMatchIndex(0, 0, 1)).toBe(-1);
  });
});
