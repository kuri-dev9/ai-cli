/**
 * 프로젝트 줄에 찍을 점을 고른다. 안쪽 세션들의 상태를 하나로 모은 값이다.
 *
 * 접어 둔 프로젝트는 세션이 보이지 않는다. 세션 줄에만 표시가 있으면 어느
 * 프로젝트를 펼쳐야 하는지 알 수 없어, 답이 온 곳을 찾으려고 하나씩 열어 보게
 * 된다. 그래서 같은 신호를 프로젝트 줄까지 끌어올린다.
 */

/** `null` 은 점을 그리지 않는다는 뜻이다. */
export type ProjectActivity = 'attention' | 'processing' | null;

export function resolveProjectActivity(
  sessions: readonly { id: string }[],
  attentionSessionIds: ReadonlySet<string>,
  activeSessions: ReadonlySet<string>,
): ProjectActivity {
  let hasProcessing = false;

  for (const session of sessions) {
    // 손이 필요한 쪽이 그냥 돌고 있는 쪽보다 급하다. 하나라도 만나면 더 볼 것이
    // 없으므로 거기서 끝낸다.
    if (attentionSessionIds.has(session.id)) {
      return 'attention';
    }
    if (activeSessions.has(session.id)) {
      hasProcessing = true;
    }
  }

  return hasProcessing ? 'processing' : null;
}
