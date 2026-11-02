/**
 * 여러 Claude 로그인을 등록해 두고, 세션마다 그중 하나를 골라 쓰게 하는 기능.
 *
 * Claude Code 는 `CLAUDE_CONFIG_DIR` 하나로 "집"(자격증명·설정·세션)을 통째로
 * 구분한다(`getClaudeHomeDirectory`). 여기서는 그 디렉터리에 라벨을 붙여 목록으로
 * 들고 있을 뿐이고, 실제로 "이 세션은 이 계정으로 돈다"는 선택은 세션 하나하나가
 * `claude_account_id` 로 들고 있다(`sessions`/`room_participants` 테이블) — 서버
 * 프로세스 전체의 `process.env.CLAUDE_CONFIG_DIR` 는 건드리지 않는다. 그래야 두
 * 세션이 서로 다른 계정으로 동시에 돌아도 서로의 설정을 밟지 않는다.
 *
 * 실제로 그 계정을 쓰는 지점은 두 곳이다: SDK 호출마다 환경을 새로 만드는
 * `claude-runtime.provider.js`(이 서비스로 id → configDir 를 찾아 그 호출의
 * 환경에만 얹는다), 그리고 계정별 사용량을 따로 읽어야 하는
 * `claude-usage.service.ts`.
 */

import crypto from 'node:crypto';
import path from 'node:path';

import { appConfigDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

const ACCOUNTS_KEY = 'claude_accounts';

export type ClaudeAccount = {
  id: string;
  label: string;
  /** `null` 은 `CLAUDE_CONFIG_DIR` 미설정 — 기본 `~/.claude`. */
  configDir: string | null;
};

type ClaudeAccountServiceDependencies = {
  readAccountsRaw: () => string | null;
  writeAccountsRaw: (value: string) => void;
  readConfigDirEnv: () => string | undefined;
  generateId: () => string;
};

const normalizeConfigDir = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed : null;
};

/** 등록된 적 없는 집을 처음 볼 때 쓸 라벨. 경로가 있으면 그 디렉터리 이름, 없으면 기본값. */
const defaultLabelFor = (configDir: string | null): string =>
  configDir ? path.basename(configDir) : '기본 계정';

export function createClaudeAccountService(
  dependencies: Partial<ClaudeAccountServiceDependencies> = {},
) {
  const {
    readAccountsRaw = () => appConfigDb.get(ACCOUNTS_KEY),
    writeAccountsRaw = (value: string) => appConfigDb.set(ACCOUNTS_KEY, value),
    readConfigDirEnv = () => process.env.CLAUDE_CONFIG_DIR,
    generateId = () => crypto.randomUUID(),
  } = dependencies;

  /** 첫 조회: 지금 이 서버가 보는 기본값을 계정 1개로 그대로 등록해 둔다. */
  const seed = (): ClaudeAccount[] => {
    const configDir = normalizeConfigDir(readConfigDirEnv());
    const account: ClaudeAccount = {
      id: generateId(),
      label: defaultLabelFor(configDir),
      configDir,
    };
    writeAccountsRaw(JSON.stringify([account]));
    return [account];
  };

  const read = (): ClaudeAccount[] => {
    const raw = readAccountsRaw();
    if (!raw) {
      return seed();
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('empty');
      }
      return parsed as ClaudeAccount[];
    } catch {
      // 손상됐거나 전부 지워진 값이면 지금 떠 있는 상태를 사실로 보고 다시 시드한다.
      return seed();
    }
  };

  return {
    listAccounts(): ClaudeAccount[] {
      return read();
    },

    /** id로 계정을 찾는다. 모르는 id·빈 값은 undefined — 호출한 쪽이 서버 기본값으로 물러선다. */
    resolveAccount(id: string | null | undefined): ClaudeAccount | undefined {
      if (!id) {
        return undefined;
      }
      return read().find((account) => account.id === id);
    },

    addAccount(input: { label: string; configDir: string | null }): ClaudeAccount {
      const label = input.label.trim();
      if (!label) {
        throw new AppError('Label is required.', {
          code: 'CLAUDE_ACCOUNT_LABEL_REQUIRED',
          statusCode: 400,
        });
      }

      const accounts = read();
      const account: ClaudeAccount = {
        id: generateId(),
        label,
        configDir: normalizeConfigDir(input.configDir),
      };
      writeAccountsRaw(JSON.stringify([...accounts, account]));
      return account;
    },

    /** 이름·경로를 고친다. 준 칸만 바뀐다. */
    updateAccount(id: string, changes: { label?: string; configDir?: string | null }): ClaudeAccount {
      const accounts = read();
      const index = accounts.findIndex((account) => account.id === id);
      if (index === -1) {
        throw new AppError('Account not found.', {
          code: 'CLAUDE_ACCOUNT_NOT_FOUND',
          statusCode: 404,
        });
      }

      const current = accounts[index];
      const label = changes.label !== undefined ? changes.label.trim() : current.label;
      if (!label) {
        throw new AppError('Label is required.', {
          code: 'CLAUDE_ACCOUNT_LABEL_REQUIRED',
          statusCode: 400,
        });
      }

      const updated: ClaudeAccount = {
        id: current.id,
        label,
        configDir: changes.configDir !== undefined ? normalizeConfigDir(changes.configDir) : current.configDir,
      };
      const next = [...accounts];
      next[index] = updated;
      writeAccountsRaw(JSON.stringify(next));
      return updated;
    },

    /**
     * 등록에서 지운다. 이미 이 계정으로 도는 세션이 있어도 막지 않는다 — 그
     * 세션의 `claude_account_id` 는 더 이상 못 찾는 id로 남고, 다음 턴부터는
     * 서버 기본값으로 조용히 물러선다(`resolveAccount` 가 undefined 를 돌려줌).
     */
    removeAccount(id: string): void {
      const accounts = read();
      const updated = accounts.filter((account) => account.id !== id);
      if (updated.length === accounts.length) {
        throw new AppError('Account not found.', {
          code: 'CLAUDE_ACCOUNT_NOT_FOUND',
          statusCode: 404,
        });
      }
      writeAccountsRaw(JSON.stringify(updated));
    },
  };
}

export const claudeAccountService = createClaudeAccountService();
