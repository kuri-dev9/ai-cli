/**
 * `@displayName` autocomplete for the room composer. Display names never
 * contain spaces or `@`, so a mention is `@` followed by non-space characters
 * that starts the text or follows whitespace.
 */

export type MentionQuery = {
  /** Index of the `@` that opened the mention. */
  start: number;
  /** What has been typed after the `@` so far. */
  query: string;
};

/** Returns the mention being typed at the caret, or null when the caret is not inside one. */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const beforeCaret = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(beforeCaret);
  if (!match) {
    return null;
  }
  return { start: caret - match[2].length - 1, query: match[2] };
}

/** Participant names that complete the query, case-insensitively by prefix. */
export function filterMentionCandidates(names: string[], query: string): string[] {
  const needle = query.toLowerCase();
  return names.filter((name) => name.toLowerCase().startsWith(needle));
}

/** Replaces the mention at the caret with the chosen name and a trailing space. */
export function applyMention(
  text: string,
  caret: number,
  mention: MentionQuery,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  const nextText = text.slice(0, mention.start) + inserted + text.slice(caret).replace(/^\s+/, '');
  return { text: nextText, caret: mention.start + inserted.length };
}

