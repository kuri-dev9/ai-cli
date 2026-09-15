import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Auto-cleanup only self-registers when vitest globals are enabled, and they are
// not. Without this, a hook rendered in one test stays mounted — with its timers
// and effects live — for the rest of the file.
afterEach(cleanup);

// Node 26 부터 런타임에 전역 `localStorage` 가 생겼는데, `--localstorage-file` 없이
// 실행하면 그 전역이 undefined 인 채로 자리를 차지한다. 그 바람에 jsdom 이 만들어주는
// localStorage 가 가려져서, 저장소를 쓰는 테스트가 전부 한꺼번에 깨진다.
// (.nvmrc 가 지정한 Node 22 에서는 이 문제가 없다.)
if (typeof globalThis.localStorage === 'undefined') {
  const createStorage = (): Storage => {
    const store = new Map<string, string>();
    return {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (key: string) => (store.has(String(key)) ? store.get(String(key))! : null),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      removeItem: (key: string) => void store.delete(String(key)),
      setItem: (key: string, value: string) => void store.set(String(key), String(value)),
    } as Storage;
  };

  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const storage = createStorage();
    Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
    }
  }
}

// jsdom ships no `matchMedia`, and components that pick a layout from the
// viewport call it during render. Report the desktop breakpoint, which is the
// layout the sidebar row tests assert on.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
