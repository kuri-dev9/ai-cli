import { createHash } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

/**
 * 앱 바깥에서 들어온 메시지의 출처.
 *
 * 세션 기록은 Claude CLI 가 쓰는 `.jsonl` 이고 우리 소유가 아니다. 거기에
 * 필드를 끼워 넣을 수 없고, 프롬프트 본문에 표시를 섞는 것은 더 나쁘다 —
 * 모델이 읽는 글이 사용자가 친 것과 달라진다. 그래서 출처만 여기에 두고,
 * 기록을 화면에 내려줄 때 붙인다.
 */

/** 지금은 텔레그램 하나뿐이지만, 다른 통로가 생겨도 표를 바꾸지 않도록 열어 둔다. */
export type MessageSource = 'telegram';

type MessageSourceRow = {
  id: number;
  content_hash: string;
  source: string;
  transcript_anchor_id: string | null;
  created_at: string;
};

/**
 * 본문으로 만드는 매칭 키.
 *
 * 턴을 시작하는 시점에는 CLI 가 만들 메시지 uuid 를 알 수 없어서, 맞출 수
 * 있는 것이 본문뿐이다. 앞뒤 공백은 떼고 비교한다 — 같은 글이 한쪽에서만
 * 다듬어지는 일이 있다.
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}

/**
 * 이 세션의 이 본문이 바깥에서 들어왔다고 적어 둔다.
 *
 * 적어 둔 표시의 id 를 돌려준다. 턴이 끝내 시작되지 못했다면 부른 쪽이 이
 * id 로 표시를 도로 지워야 한다 — 남겨 두면 나중에 브라우저에서 같은 글을
 * 보냈을 때 그 메시지에 잘못 붙을 수 있다.
 */
export function markMessageSource(
  sessionId: string,
  content: string,
  source: MessageSource,
): number | null {
  if (!sessionId || !content.trim()) {
    return null;
  }
  const result = getConnection()
    .prepare(
      `INSERT INTO message_sources (session_id, content_hash, source)
       VALUES (?, ?, ?)`,
    )
    .run(sessionId, hashContent(content), source);
  return Number(result.lastInsertRowid);
}

/** 쓰이지 못한 표시를 지운다. 아직 메시지에 고정되지 않은 것만 지운다. */
export function dropMessageSource(id: number | null): void {
  if (id === null) {
    return;
  }
  getConnection()
    .prepare('DELETE FROM message_sources WHERE id = ? AND transcript_anchor_id IS NULL')
    .run(id);
}

function readSessionRows(sessionId: string): MessageSourceRow[] {
  return getConnection()
    .prepare(
      `SELECT id, content_hash, source, transcript_anchor_id, created_at
         FROM message_sources
        WHERE session_id = ?
        ORDER BY id`,
    )
    .all(sessionId) as MessageSourceRow[];
}

function fixAnchor(id: number, anchorId: string): void {
  getConnection()
    .prepare('UPDATE message_sources SET transcript_anchor_id = ? WHERE id = ?')
    .run(anchorId, id);
}

type AnnotatableMessage = {
  transcriptAnchorId?: string;
  timestamp?: string;
  role?: 'user' | 'assistant';
  content?: string;
  source?: MessageSource;
};

/**
 * 기록에 출처를 붙인다.
 *
 * 맞추는 순서가 중요하다. 이미 uuid 가 고정된 표시는 그 메시지에만 붙고,
 * 아직 고정되지 않은 표시만 본문으로 맞춘 뒤 곧바로 고정된다. 그래서 같은
 * 글을 나중에 브라우저에서 또 보내도 먼저 붙은 표시가 옮겨 가지 않는다.
 *
 * 맞출 수 없으면 붙이지 않는다. 브라우저에서 친 메시지에 "텔레그램" 이
 * 잘못 붙는 쪽이, 표시가 하나 빠지는 쪽보다 훨씬 나쁘다 — 기록을 믿을 수
 * 없게 만든다.
 */
export function annotateMessageSources<T extends AnnotatableMessage>(
  sessionId: string,
  messages: T[],
): T[] {
  if (!sessionId || messages.length === 0) {
    return messages;
  }

  const rows = readSessionRows(sessionId);
  if (rows.length === 0) {
    return messages;
  }

  const byAnchor = new Map<string, MessageSourceRow>();
  const unfixed: MessageSourceRow[] = [];
  for (const row of rows) {
    if (row.transcript_anchor_id) {
      byAnchor.set(row.transcript_anchor_id, row);
    } else {
      unfixed.push(row);
    }
  }

  /** 표시 하나는 메시지 하나에만 쓴다. */
  const used = new Set<number>();

  return messages.map((message) => {
    if (message.role !== 'user' || !message.content) {
      return message;
    }

    const anchorId = message.transcriptAnchorId;
    if (anchorId) {
      const fixed = byAnchor.get(anchorId);
      if (fixed) {
        return { ...message, source: fixed.source as MessageSource };
      }
    }

    const hash = hashContent(message.content);
    const candidate = unfixed.find((row) => {
      if (used.has(row.id) || row.content_hash !== hash) {
        return false;
      }
      // 적어 둔 시각보다 앞선 메시지일 수는 없다. 대기열을 거쳐 한참 뒤에
      // 실행되는 경우가 있으므로 위쪽은 막지 않는다. 시계가 조금 어긋나는
      // 정도는 넘어가도록 1 분의 여유를 둔다.
      if (!message.timestamp) {
        return true;
      }
      const sentAt = Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
      const shownAt = Date.parse(message.timestamp);
      if (!Number.isFinite(sentAt) || !Number.isFinite(shownAt)) {
        return true;
      }
      return shownAt >= sentAt - 60_000;
    });

    if (!candidate) {
      return message;
    }

    used.add(candidate.id);
    if (anchorId) {
      // 다음부터는 본문이 아니라 이 uuid 로 곧장 맞는다.
      fixAnchor(candidate.id, anchorId);
    }
    return { ...message, source: candidate.source as MessageSource };
  });
}

export const messageSourcesDb = {
  markMessageSource,
  dropMessageSource,
  annotateMessageSources,
};
