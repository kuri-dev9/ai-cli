import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * 룸 초대 창의 역할 프리셋.
 *
 * 고르면 이름·역할·역할 지시·성향이 채워진다. 목록은 사용자 설정(`auth.db`)에 통째로
 * 저장돼 기기 사이에서 따라온다. 한 번도 고친 적이 없으면 저장된 값이 없고,
 * 그때는 기본 프리셋을 쓴다 — 그래서 기본 프리셋을 지우면 지운 채로 남는다.
 */

/** 프리셋 하나. `provider` 가 있으면 그 프로바이더가 쓸 수 있을 때만 같이 고른다. */
export type RoomRolePreset = {
  id: string;
  displayName: string;
  roleName: string;
  /** 무엇을 하는지. */
  rolePrompt: string;
  /** 어떤 말투와 태도로 하는지. 역할과 따로 두어 같은 역할도 다르게 말하게 한다. */
  persona: string;
  provider: 'claude' | 'codex' | null;
};

const PREFERENCE_KEY = 'roomRolePresets';

/** 서버 규칙과 같다: 공백·`@`·대괄호 없이 24자 이하. */
export const isValidRoomDisplayName = (name: string): boolean => /^[^\s@[\]]{1,24}$/u.test(name);

export const DEFAULT_ROOM_ROLE_PRESETS: RoomRolePreset[] = [
  {
    id: 'default-architect',
    displayName: '아키',
    roleName: '설계자',
    rolePrompt: '코드는 고치지 않는다. 요구사항을 정리하고 할 일을 3~7단계로 쪼갠 뒤, 각 단계를 맡을 참가자를 정해 @이름으로 넘긴다.',
    persona: '침착하고 결정이 빠르다. 길게 재지 않고 한 가지 방향을 정해 말한다.',
    provider: null,
  },
  {
    id: 'default-builder',
    displayName: '빌더',
    roleName: '구현자',
    rolePrompt: '설계에 따라 코드를 고치고 실행해 본다. 고친 파일과 실행 결과를 요약하고, 끝나면 리뷰어에게 넘긴다.',
    persona: '군더더기 없이 손부터 움직인다. 한 일을 사실대로 짧게 보고한다.',
    provider: null,
  },
  {
    id: 'default-checker',
    displayName: '체커',
    roleName: '리뷰어',
    rolePrompt: '직접 고치지 않는다. 버그, 빠진 경우, 보안 문제, 테스트 누락을 번호 목록으로 지적하고 구현자에게 넘긴다. 문제가 없으면 [DONE].',
    persona: '깐깐하고 의심이 많다. 칭찬은 아끼고 문제만 정확히 짚는다.',
    provider: 'codex',
  },
  {
    id: 'default-tester',
    displayName: '테스티',
    roleName: '테스터',
    rolePrompt: '기능 코드는 고치지 않는다. 테스트를 작성하고 실행해 실패를 재현한 뒤, 실패 내용과 재현 방법을 보고한다.',
    persona: '집요하다. 될 거라 믿지 않고 직접 돌려 본 결과만 말한다.',
    provider: null,
  },
  {
    id: 'default-devil',
    displayName: '딴지',
    roleName: '반대자',
    rolePrompt: '제안된 방식의 약점과 위험을 짚고, 다른 대안을 하나 이상 제시한다. 반대할 이유가 없으면 [PASS].',
    persona: '일부러 반대편에 선다. 날카롭되 비아냥대지 않고 대안을 함께 낸다.',
    provider: null,
  },
  {
    id: 'default-scribe',
    displayName: '서기',
    roleName: '정리자',
    rolePrompt: '코드는 고치지 않는다. 지금까지의 논의를 요약하고 결정된 것, 남은 일, 열린 질문을 정리해 사용자에게 보고한 뒤 [DONE].',
    persona: '차분하고 간결하다. 판단을 보태지 않고 오간 말을 있는 그대로 정리한다.',
    provider: null,
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

function normalizePreset(value: unknown): RoomRolePreset | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const displayName = typeof value.displayName === 'string' ? value.displayName.trim() : '';
  const roleName = typeof value.roleName === 'string' ? value.roleName.trim() : '';
  if (!id || !isValidRoomDisplayName(displayName) || !roleName) {
    return null;
  }
  return {
    id,
    displayName,
    roleName: roleName.slice(0, 40),
    rolePrompt: typeof value.rolePrompt === 'string' ? value.rolePrompt.trim() : '',
    persona: typeof value.persona === 'string' ? value.persona.trim() : '',
    provider: value.provider === 'claude' || value.provider === 'codex' ? value.provider : null,
  };
}

/** 정규화 결과 캐시. `useSyncExternalStore` 가 같은 값에 같은 참조를 받아야 한다. */
let cachedRaw: unknown = Symbol('unread');
let cachedPresets: RoomRolePreset[] = DEFAULT_ROOM_ROLE_PRESETS;

/** 지금 쓰는 프리셋 목록. 저장된 적이 없으면 기본 프리셋. */
export function readRoomRolePresets(): RoomRolePreset[] {
  const raw = readUserPreference<unknown>(PREFERENCE_KEY, null);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    if (!Array.isArray(raw)) {
      cachedPresets = DEFAULT_ROOM_ROLE_PRESETS;
    } else {
      const seen = new Set<string>();
      cachedPresets = raw
        .map(normalizePreset)
        .filter((preset): preset is RoomRolePreset => {
          if (!preset || seen.has(preset.id)) {
            return false;
          }
          seen.add(preset.id);
          return true;
        });
    }
  }
  return cachedPresets;
}

function writePresets(presets: RoomRolePreset[]): void {
  writeUserPreference(PREFERENCE_KEY, presets);
}

function createPresetId(): string {
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 새 프리셋을 맨 뒤에 넣는다. 형식이 맞지 않으면 아무것도 하지 않고 null. */
export function addRoomRolePreset(input: Omit<RoomRolePreset, 'id'>): RoomRolePreset | null {
  const preset = normalizePreset({ ...input, id: createPresetId() });
  if (!preset) {
    return null;
  }
  writePresets([...readRoomRolePresets(), preset]);
  return preset;
}

/** 프리셋 하나를 고친다. 형식이 맞지 않으면 고치지 않고 false. */
export function updateRoomRolePreset(id: string, input: Omit<RoomRolePreset, 'id'>): boolean {
  const preset = normalizePreset({ ...input, id });
  const current = readRoomRolePresets();
  if (!preset || !current.some((candidate) => candidate.id === id)) {
    return false;
  }
  writePresets(current.map((candidate) => (candidate.id === id ? preset : candidate)));
  return true;
}

export function deleteRoomRolePreset(id: string): void {
  writePresets(readRoomRolePresets().filter((preset) => preset.id !== id));
}

/** 프리셋 하나를 한 칸 위나 아래로 옮긴다. 칩이 놓이는 순서다. */
export function moveRoomRolePreset(id: string, direction: -1 | 1): void {
  const current = [...readRoomRolePresets()];
  const index = current.findIndex((preset) => preset.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= current.length) {
    return;
  }
  [current[index], current[target]] = [current[target], current[index]];
  writePresets(current);
}

/** 기본 프리셋으로 되돌린다. 저장된 값을 지워 다음 기본값 변경도 따라가게 한다. */
export function resetRoomRolePresets(): void {
  writeUserPreference(PREFERENCE_KEY, null);
}

/**
 * 프리셋 이름이 룸에서 이미 쓰이면 숫자를 붙인다(빌더 → 빌더2). 같은 역할을
 * 두 번 넣을 수 있게 하려는 것이다.
 */
export function pickAvailableDisplayName(base: string, takenNames: string[]): string {
  const taken = new Set(takenNames.map((name) => name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}${suffix}`.slice(0, 24);
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}
