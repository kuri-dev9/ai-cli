import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  DEFAULT_FONT_SETTINGS,
  FONT_FAMILIES,
  applyFontSettings,
  normalizeFontSettings,
  readFontSettings,
  resolveFontStacks,
  startFontSettingsSync,
  writeFontSettings,
} from '@/shared/fontSettings';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * 글꼴은 컴포넌트에 박혀 있다가 사용자 설정으로 옮겨 왔다. 여기서 지켜야 할 것은
 * 네 가지다: 제목은 기본적으로 본문과 같을 것, 손상된 저장값이 화면을 망가뜨리지
 * 않을 것, "시스템 기본" 은 CDN 요청을 하지 않을 것, 설정을 바꾸면 새로고침 없이
 * 즉시 반영될 것.
 */

const fontLinks = () => Array.from(document.querySelectorAll('link[data-app-font]'));
const stylesheetHrefs = () => fontLinks()
  .filter((node) => node.getAttribute('rel') === 'stylesheet')
  .map((node) => node.getAttribute('href') ?? '');

beforeEach(() => {
  localStorage.clear();
  // 설정 저장소는 모듈 스코프 싱글턴이라 localStorage.clear() 로는 안 지워진다.
  resetUserPreferences();
  for (const node of fontLinks()) {
    node.remove();
  }
  document.documentElement.removeAttribute('style');
});

test('설정한 적이 없으면 본문은 Inter, 제목은 본문과 동일이다', () => {
  assert.deepEqual(readFontSettings(), DEFAULT_FONT_SETTINGS);

  const { body, heading } = resolveFontStacks(readFontSettings());
  assert.equal(heading.id, body.id, '제목만 세리프로 강요하지 않는다');
});

test('고른 글꼴이 저장되고 다시 읽힌다', () => {
  writeFontSettings({ body: 'pretendard' });

  assert.equal(readFontSettings().body, 'pretendard');
  // 넘기지 않은 항목은 그대로 남는다.
  assert.equal(readFontSettings().heading, DEFAULT_FONT_SETTINGS.heading);
});

test('모르는 값이 저장돼 있으면 기본값으로 떨어뜨린다', () => {
  assert.deepEqual(normalizeFontSettings({ body: 'comic-sans', heading: 7, scale: null }), DEFAULT_FONT_SETTINGS);
  assert.deepEqual(normalizeFontSettings('inter'), DEFAULT_FONT_SETTINGS);

  writeUserPreference('fontSettings', { body: 'nope' });
  assert.deepEqual(readFontSettings(), DEFAULT_FONT_SETTINGS);
});

test('모든 스택이 한글 시스템 폰트로 폴백한다', () => {
  // CDN 이 막힌 폐쇄망에서 한글이 두부(□)로 보이면 앱을 못 쓴다.
  for (const font of Object.values(FONT_FAMILIES)) {
    assert.ok(
      font.stack.includes('Apple SD Gothic Neo') && font.stack.includes('Malgun Gothic'),
      `${font.id} 스택에 한글 폴백이 없다`,
    );
  }
});

test('적용하면 CSS 변수 세 개가 채워진다', () => {
  applyFontSettings({ body: 'notoSansKr', heading: 'sourceSerif', scale: 'large' });

  const style = document.documentElement.style;
  assert.equal(style.getPropertyValue('--app-font-sans'), FONT_FAMILIES.notoSansKr.stack);
  assert.equal(style.getPropertyValue('--app-font-heading'), FONT_FAMILIES.sourceSerif.stack);
  assert.equal(style.getPropertyValue('--app-font-scale'), '1.1');
});

test('제목이 "본문과 동일" 이면 두 변수가 같은 값이 된다', () => {
  applyFontSettings({ body: 'pretendard', heading: 'sameAsBody', scale: 'normal' });

  const style = document.documentElement.style;
  assert.equal(
    style.getPropertyValue('--app-font-heading'),
    style.getPropertyValue('--app-font-sans'),
  );
});

test('시스템 기본만 쓰면 글꼴을 한 개도 내려받지 않는다', () => {
  applyFontSettings({ body: 'system', heading: 'sameAsBody', scale: 'normal' });

  assert.deepEqual(fontLinks(), [], '시스템 폰트를 골랐는데 CDN 요청이 남아 있다');
});

test('고른 글꼴의 스타일시트만 남는다', () => {
  applyFontSettings({ body: 'inter', heading: 'sourceSerif', scale: 'normal' });
  assert.deepEqual(
    stylesheetHrefs().sort(),
    [FONT_FAMILIES.inter.href!, FONT_FAMILIES.sourceSerif.href!].sort(),
  );

  applyFontSettings({ body: 'notoSansKr', heading: 'sameAsBody', scale: 'normal' });
  assert.deepEqual(stylesheetHrefs(), [FONT_FAMILIES.notoSansKr.href!], '이전 글꼴 링크가 남아 있다');
});

test('같은 설정을 다시 적용해도 링크가 늘어나지 않는다', () => {
  applyFontSettings({ body: 'inter', heading: 'sourceSerif', scale: 'normal' });
  const before = fontLinks().length;

  applyFontSettings({ body: 'inter', heading: 'sourceSerif', scale: 'normal' });

  assert.equal(fontLinks().length, before, 'preconnect 를 포함해 링크가 중복 주입됐다');
});

test('설정을 바꾸면 새로고침 없이 즉시 반영된다', () => {
  const stop = startFontSettingsSync();
  try {
    writeFontSettings({ body: 'system', heading: 'sourceSerif' });

    assert.equal(
      document.documentElement.style.getPropertyValue('--app-font-sans'),
      FONT_FAMILIES.system.stack,
    );
    assert.deepEqual(stylesheetHrefs(), [FONT_FAMILIES.sourceSerif.href!]);
  } finally {
    stop();
  }
});

test('구독을 끊으면 더 이상 따라가지 않는다', () => {
  const stop = startFontSettingsSync();
  stop();

  writeFontSettings({ body: 'notoSansKr' });

  assert.equal(
    document.documentElement.style.getPropertyValue('--app-font-sans'),
    FONT_FAMILIES[DEFAULT_FONT_SETTINGS.body].stack,
  );
});
