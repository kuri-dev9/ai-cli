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


/** One run of composer text: either a participant mention or the plain text around it. */
export type MentionSegment = {
  text: string;
  /** The participant this run mentions, or null for ordinary text. */
  mentionedName: string | null;
};

/**
 * Splits composer text into mentions and the text between them, so the input
 * overlay can tint each `@name` in that participant's colour.
 *
 * Longer names win where several match at the same `@`, which keeps `@빌더2`
 * from being read as `@빌더`. An `@` with a letter or digit in front of it is
 * part of something else — an email address, usually — and is left alone, the
 * same rule the server reads handoffs by.
 */
export function splitByMentions(text: string, names: string[]): MentionSegment[] {
  if (!text) {
    return [];
  }
  const byLength = [...names].sort((a, b) => b.length - a.length);
  const segments: MentionSegment[] = [];
  let plainFrom = 0;
  let index = 0;

  while (index < text.length) {
    const at = text.indexOf('@', index);
    if (at < 0) {
      break;
    }
    const before = text.charAt(at - 1);
    const rest = text.slice(at + 1);
    const matched = before && /[\p{L}\p{N}_.-]/u.test(before)
      ? undefined
      : byLength.find((name) => rest.toLowerCase().startsWith(name.toLowerCase()));
    if (!matched) {
      index = at + 1;
      continue;
    }
    if (at > plainFrom) {
      segments.push({ text: text.slice(plainFrom, at), mentionedName: null });
    }
    const end = at + 1 + matched.length;
    segments.push({ text: text.slice(at, end), mentionedName: matched });
    plainFrom = end;
    index = end;
  }

  if (plainFrom < text.length) {
    segments.push({ text: text.slice(plainFrom), mentionedName: null });
  }
  return segments;
}
