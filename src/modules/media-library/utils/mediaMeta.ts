/** 재생 길이를 `0:34` / `1:02:03` 으로. 아직 모르면 null. */
export function formatMediaDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const padded = `${String(minutes).padStart(hours > 0 ? 2 : 1, '0')}:${String(secs).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${padded}` : padded;
}

/**
 * 수정 시각을 로캘에 맞춘 짧은 날짜로. 읽을 수 없으면 null.
 *
 * 서버는 목록에서 ISO 문자열을, 헤더로는 HTTP 날짜를 준다. 둘 다 받는다.
 */
export function formatMediaDate(value: string | null | undefined, locale: string): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
