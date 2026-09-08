export interface SearchableMessage {
  id: string;
  role: string;
  text: string;
}
export interface ConversationMatch {
  messageId: string;
  offset: number;
  text: string;
}
/** Literal search of conversational text; tool records are never included. */
export function searchConversation(
  messages: readonly SearchableMessage[],
  query: string,
): ConversationMatch[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const matches: ConversationMatch[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.text.toLowerCase();
    let offset = text.indexOf(needle);
    while (offset !== -1) {
      matches.push({ messageId: message.id, offset, text: message.text });
      offset = text.indexOf(needle, offset + Math.max(1, needle.length));
    }
  }
  return matches;
}
export function nextMatchIndex(index: number, length: number, delta: number): number {
  return length === 0 ? -1 : (((index + delta) % length) + length) % length;
}
