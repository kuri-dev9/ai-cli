import { readUserPreference, subscribeToUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * 앱 전체 글꼴을 한 곳에서 정하는 모듈.
 *
 * 예전에는 `tailwind.config.js` 의 `fontFamily` 와 컴포넌트의 `font-serif` 클래스가
 * 글꼴을 직접 박아 두고 있어서, 사용자가 제목 세리프가 싫어도 바꿀 방법이 없었다.
 * 지금은 글꼴이 세 개의 CSS 변수(`--app-font-sans`, `--app-font-heading`,
 * `--app-font-scale`)로만 표현되고, Tailwind 의 `font-sans` / `font-heading` 이
 * 그 변수를 참조한다. 따라서 변수 하나만 갈아끼우면 앱 전체가 새로고침 없이 바뀐다.
 *
 * 저장은 나머지 사용자 설정과 같이 `auth.db`(`userSettings`)에 하므로 기기 사이에서도
 * 따라온다. 저장소가 쓴 즉시 동기로 통지하기 때문에, `startFontSettingsSync()` 를
 * 한 번 걸어 두면 설정 화면에서 고르는 순간 화면이 바뀐다.
 *
 * 오프라인·폐쇄망 원칙: 어떤 선택지든 `stack` 에 시스템 폰트 폴백이 끝까지 들어 있고
 * 한글 폴백(Apple SD Gothic Neo / Malgun Gothic)을 반드시 포함한다. CDN 이 죽어도
 * 글자가 사라지지 않고, "시스템 기본" 을 고르면 아예 요청 자체를 하지 않는다.
 */

/** 어떤 선택지를 골라도 마지막에 붙는 산세리프 폴백. 한글·이모지까지 책임진다. */
export const SYSTEM_SANS_FALLBACK =
  '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Segoe UI", "Malgun Gothic", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif';

/** 세리프 선택지의 폴백. 한글 세리프가 없는 환경이 많아 한글은 시스템 고딕으로 떨어뜨린다. */
export const SYSTEM_SERIF_FALLBACK =
  'Georgia, Cambria, "Apple SD Gothic Neo", "Malgun Gothic", "Times New Roman", serif';

const GOOGLE_FONTS_PRECONNECT = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
] as const;

/** 고를 수 있는 글꼴 가족. 값은 사용자 설정에 그대로 저장되므로 이름을 바꾸지 말 것. */
export type FontFamilyId = 'system' | 'inter' | 'pretendard' | 'notoSansKr' | 'sourceSerif';

/** 제목은 "본문과 동일" 을 고를 수 있다 — 그게 기본값이다. */
export type HeadingFontId = 'sameAsBody' | FontFamilyId;

export type FontScaleId = 'small' | 'normal' | 'large' | 'xlarge';

export type FontFamilyDefinition = {
  id: FontFamilyId;
  /** select 에 그대로 쓰는 이름. 글꼴 이름은 고유명사라 번역하지 않는다. */
  label: string;
  /** `font-family` 에 넣을 전체 스택. 폴백까지 포함한 완성된 값이다. */
  stack: string;
  /**
   * 내려받아야 하는 스타일시트. 없으면 네트워크 요청이 전혀 없다는 뜻이다.
   * 요청이 실패해도 `stack` 의 폴백이 받아내므로 앱이 깨지지는 않는다.
   */
  href?: string;
  /** `href` 가 쓰는 출처. 첫 요청을 앞당기려고 preconnect 로 깔아 둔다. */
  preconnect?: readonly string[];
};

export const FONT_FAMILIES: Record<FontFamilyId, FontFamilyDefinition> = {
  system: {
    id: 'system',
    label: 'System',
    // 유일하게 CDN 요청이 없는 선택지. 폐쇄망·저속 회선의 기본 추천값이다.
    stack: `ui-sans-serif, ${SYSTEM_SANS_FALLBACK}`,
  },
  inter: {
    id: 'inter',
    label: 'Inter',
    stack: `Inter, ${SYSTEM_SANS_FALLBACK}`,
    href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
    preconnect: GOOGLE_FONTS_PRECONNECT,
  },
  pretendard: {
    id: 'pretendard',
    label: 'Pretendard',
    // Google Fonts 에 없어서 배포처인 jsDelivr 의 dynamic subset 을 쓴다. 한글 자소가
    // 필요한 것만 쪼개져 오므로 Noto Sans KR 통짜보다 훨씬 가볍다.
    stack: `"Pretendard Variable", Pretendard, ${SYSTEM_SANS_FALLBACK}`,
    href: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css',
    preconnect: ['https://cdn.jsdelivr.net'],
  },
  notoSansKr: {
    id: 'notoSansKr',
    label: 'Noto Sans KR',
    stack: `"Noto Sans KR", ${SYSTEM_SANS_FALLBACK}`,
    href: 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700&display=swap',
    preconnect: GOOGLE_FONTS_PRECONNECT,
  },
  sourceSerif: {
    id: 'sourceSerif',
    label: 'Source Serif 4',
    // 이 앱이 원래 제목에 쓰던 세리프. 이제는 강제가 아니라 하나의 선택지다.
    stack: `"Source Serif 4", "Noto Serif KR", ${SYSTEM_SERIF_FALLBACK}`,
    href: 'https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&family=Noto+Serif+KR:wght@400;600;700&display=swap',
    preconnect: GOOGLE_FONTS_PRECONNECT,
  },
};

/** 화면에 그릴 때의 표준 순서. */
export const FONT_FAMILY_IDS: readonly FontFamilyId[] = [
  'system',
  'inter',
  'pretendard',
  'notoSansKr',
  'sourceSerif',
];

/** 제목 select 의 순서. "본문과 동일" 이 맨 위에 온다. */
export const HEADING_FONT_IDS: readonly HeadingFontId[] = ['sameAsBody', ...FONT_FAMILY_IDS];

/**
 * 글자 크기 배율. `html` 의 `font-size` 에 곱해지므로 rem 을 쓰는 곳이 전부 함께
 * 커진다 — 글자만 커지고 여백은 그대로인 어색한 화면을 피하려는 의도다.
 */
export const FONT_SCALES: Record<FontScaleId, number> = {
  small: 0.9,
  normal: 1,
  large: 1.1,
  xlarge: 1.2,
};

export const FONT_SCALE_IDS: readonly FontScaleId[] = ['small', 'normal', 'large', 'xlarge'];

export type FontSettings = {
  body: FontFamilyId;
  heading: HeadingFontId;
  scale: FontScaleId;
};

/**
 * 기본값.
 *
 * 본문은 지금까지 쓰던 Inter 그대로다 — 기존 사용자가 업그레이드했다고 글꼴이 갑자기
 * 바뀌면 안 된다. 제목은 `sameAsBody` 로 둔다. "제목만 세리프" 가 바로 사용자가
 * 싫다고 한 부분이고, 세리프를 원하면 설정에서 고르면 된다.
 */
export const DEFAULT_FONT_SETTINGS: FontSettings = {
  body: 'inter',
  heading: 'sameAsBody',
  scale: 'normal',
};

const PREFERENCE_KEY = 'fontSettings';

/** 주입한 `<link>` 를 알아보는 표시. 값은 글꼴 id 라 필요 없어진 것만 골라 지운다. */
const FONT_LINK_ATTRIBUTE = 'data-app-font';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/**
 * 저장값을 믿을 수 있는 형태로 되돌린다.
 *
 * 모르는 id 는 기본값으로 떨어뜨린다. 옛 버전에서 저장한 값이나 손상된 값 하나 때문에
 * 글자가 안 보이는 화면이 나오는 것이 최악이다.
 */
export function normalizeFontSettings(raw: unknown): FontSettings {
  if (!isRecord(raw)) {
    return { ...DEFAULT_FONT_SETTINGS };
  }

  const body = FONT_FAMILY_IDS.includes(raw.body as FontFamilyId)
    ? (raw.body as FontFamilyId)
    : DEFAULT_FONT_SETTINGS.body;

  const heading = HEADING_FONT_IDS.includes(raw.heading as HeadingFontId)
    ? (raw.heading as HeadingFontId)
    : DEFAULT_FONT_SETTINGS.heading;

  const scale = FONT_SCALE_IDS.includes(raw.scale as FontScaleId)
    ? (raw.scale as FontScaleId)
    : DEFAULT_FONT_SETTINGS.scale;

  return { body, heading, scale };
}

/** 지금 적용 중인 글꼴 설정. 설정한 적이 없으면 기본값. */
export function readFontSettings(): FontSettings {
  return normalizeFontSettings(readUserPreference<unknown>(PREFERENCE_KEY, null));
}

/** 바꾸고 싶은 항목만 넘긴다. 저장된 전체 설정을 돌려준다. */
export function writeFontSettings(patch: Partial<FontSettings>): FontSettings {
  const next = normalizeFontSettings({ ...readFontSettings(), ...patch });
  writeUserPreference(PREFERENCE_KEY, next);
  return next;
}

/** 설정이 실제로 가리키는 글꼴 정의 두 개. 제목이 `sameAsBody` 면 같은 객체가 나온다. */
export function resolveFontStacks(settings: FontSettings): {
  body: FontFamilyDefinition;
  heading: FontFamilyDefinition;
} {
  const body = FONT_FAMILIES[settings.body] ?? FONT_FAMILIES[DEFAULT_FONT_SETTINGS.body];
  const heading = settings.heading === 'sameAsBody'
    ? body
    : FONT_FAMILIES[settings.heading] ?? body;

  return { body, heading };
}

/**
 * 지금 고른 글꼴에 필요한 스타일시트만 문서에 남긴다.
 *
 * `index.html` 에 `<link>` 를 박아 두면 "시스템 기본" 을 고른 사용자도 Google Fonts
 * 를 세 벌씩 받는다. 그래서 정적 링크를 걷어내고 여기서 주입한다 — 고른 것만 받고,
 * 바꾸면 이전 것은 제거된다.
 */
function syncFontStylesheets(fonts: readonly FontFamilyDefinition[]): void {
  if (typeof document === 'undefined') {
    return;
  }

  const needed = new Map<string, FontFamilyDefinition>();
  for (const font of fonts) {
    if (font.href) {
      needed.set(font.id, font);
    }
  }

  // 글꼴 하나가 preconnect 까지 여러 개의 `<link>` 를 갖는다. 그래서 "남길 id" 를
  // 먼저 모으고 나서 추가한다 — 순회하면서 needed 에서 지우면 같은 id 의 두 번째
  // 링크가 불필요한 것으로 오인돼 함께 지워진다.
  const keptIds = new Set<string>();
  for (const node of Array.from(document.querySelectorAll(`link[${FONT_LINK_ATTRIBUTE}]`))) {
    const id = node.getAttribute(FONT_LINK_ATTRIBUTE) ?? '';
    if (needed.has(id)) {
      keptIds.add(id);
    } else {
      node.remove();
    }
  }

  for (const font of needed.values()) {
    if (keptIds.has(font.id)) {
      continue;
    }

    for (const origin of font.preconnect ?? []) {
      const preconnect = document.createElement('link');
      preconnect.rel = 'preconnect';
      preconnect.href = origin;
      if (origin.includes('gstatic')) {
        preconnect.crossOrigin = '';
      }
      preconnect.setAttribute(FONT_LINK_ATTRIBUTE, font.id);
      document.head.appendChild(preconnect);
    }

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = font.href!;
    stylesheet.setAttribute(FONT_LINK_ATTRIBUTE, font.id);
    document.head.appendChild(stylesheet);
  }
}

/**
 * 설정을 문서에 반영한다. CSS 변수 세 개를 바꾸는 것이 전부라, 리렌더 없이 즉시 먹는다.
 */
export function applyFontSettings(
  settings: FontSettings = readFontSettings(),
  root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement,
): void {
  if (!root) {
    return;
  }

  const { body, heading } = resolveFontStacks(settings);
  root.style.setProperty('--app-font-sans', body.stack);
  root.style.setProperty('--app-font-heading', heading.stack);
  root.style.setProperty('--app-font-scale', String(FONT_SCALES[settings.scale]));

  syncFontStylesheets([body, heading]);
}

/**
 * 저장된 글꼴을 한 번 적용하고, 이후의 변경을 계속 따라가게 한다.
 *
 * `main.tsx` 가 렌더 전에 한 번 부른다. 설정 저장소는 쓴 즉시 동기로 통지하므로
 * 설정 화면에서 고르는 순간 반영되고, 다른 기기에서 바꾼 값도 하이드레이트될 때
 * 같은 경로로 들어온다.
 */
export function startFontSettingsSync(): () => void {
  applyFontSettings();
  return subscribeToUserPreferences(() => {
    applyFontSettings();
  });
}
