export interface MentionCandidate {
  readonly login: string;
  readonly name?: string | null;
}

export function mentionAtCursor(value: string, start: number, end = start) {
  if (start !== end) return null;
  const match = /(?:^|[\s([{])@([\w.-]*)$/.exec(value.slice(0, start));
  if (!match) return null;
  return { start: start - match[1]!.length - 1, end: start, query: match[1]! };
}

export function mentionCandidates(candidates: ReadonlyArray<MentionCandidate>, query: string) {
  const needle = query.toLowerCase();
  const unique = new Map<string, MentionCandidate>();
  for (const candidate of candidates) {
    const key = candidate.login.toLowerCase();
    if (!/^[\w.-]+$/.test(candidate.login) || unique.has(key)) continue;
    if (key.includes(needle) || candidate.name?.toLowerCase().includes(needle)) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()]
    .sort(
      (a, b) =>
        Number(b.login.toLowerCase().startsWith(needle)) -
        Number(a.login.toLowerCase().startsWith(needle)),
    )
    .slice(0, 8);
}

export function insertMention(value: string, range: { start: number; end: number }, login: string) {
  const suffix = value.slice(range.end);
  const inserted = `@${login}${/^\s/.test(suffix) ? "" : " "}`;
  return {
    value: value.slice(0, range.start) + inserted + suffix,
    cursor: range.start + inserted.length + (/^\s/.test(suffix) ? 1 : 0),
  };
}
