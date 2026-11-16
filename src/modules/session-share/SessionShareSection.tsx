import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Link2, Loader2, Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import { copyTextToClipboard } from '@/shared/utils';

/**
 * 세션 설정 안의 "외부 공유".
 *
 * 링크를 만들고, 복사하고, 끊는다. 게스트 질문의 권한은 따로 고르지 않고 이
 * 세션의 권한을 따른다 — 고를 곳이 두 군데면 어느 쪽이 이기는지 헷갈린다.
 * 그래서 여기서는 지금 권한이 무엇이고 그게 게스트에게 무슨 뜻인지만 알린다.
 */

type ShareLink = {
  id: number;
  token: string;
  permissionMode: string;
  expiresAt: string | null;
  createdAt: string;
};

/** 고를 수 있는 유효 기간(시간). 서버(`SHARE_EXPIRY_HOURS`)와 같은 값만 보낸다. */
const EXPIRY_CHOICES = ['1', '24', '168', 'never'] as const;
type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

/** 터널 주소는 세션마다 다르지 않다. 한 번 넣으면 이 브라우저에 남긴다. */
const PUBLIC_BASE_URL_KEY = 'sessionShare.publicBaseUrl';

function readPublicBaseUrl(): string {
  try {
    return localStorage.getItem(PUBLIC_BASE_URL_KEY) ?? '';
  } catch {
    return '';
  }
}

function writePublicBaseUrl(value: string): void {
  try {
    if (value) {
      localStorage.setItem(PUBLIC_BASE_URL_KEY, value);
    } else {
      localStorage.removeItem(PUBLIC_BASE_URL_KEY);
    }
  } catch {
    // 저장하지 못해도 이번 링크는 만들 수 있다.
  }
}

/** 링크 주소. 외부 주소를 넣었으면 그쪽, 아니면 지금 연 주소를 쓴다. */
export function buildShareUrl(token: string, publicBaseUrl: string, origin: string = window.location.origin): string {
  const base = (publicBaseUrl.trim() || origin).replace(/\/+$/, '');
  return `${base}/share/${token}`;
}

type SessionShareSectionProps = {
  sessionId: string;
  /** 이 세션의 지금 권한. 게스트 질문도 이 값으로 실행된다. */
  permissionMode: string;
  /** 권한을 사람이 읽는 이름으로. 세션 설정의 권한 버튼과 같은 말을 쓴다. */
  permissionLabel: string;
};

export default function SessionShareSection({ sessionId, permissionMode, permissionLabel }: SessionShareSectionProps) {
  const { t, i18n } = useTranslation('share');
  const [shares, setShares] = useState<ShareLink[] | null>(null);
  const [expiry, setExpiry] = useState<ExpiryChoice>('24');
  const [publicBaseUrl, setPublicBaseUrl] = useState(readPublicBaseUrl);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await readApiJson<{ shares?: ShareLink[] }>(await api.sessionShares.list(sessionId));
      setShares(Array.isArray(payload.shares) ? payload.shares : []);
    } catch {
      setShares([]);
      setError(t('section.loadFailed'));
    }
  }, [sessionId, t]);

  useEffect(() => {
    setShares(null);
    setError(null);
    void load();
  }, [load]);

  // 열린 링크가 지금 권한과 다르면 맞춘다. 권한은 이 브라우저에만 있어서,
  // 다른 기기에서 바꿨거나 바꾼 뒤 저장이 실패했으면 어긋나 있을 수 있다.
  useEffect(() => {
    if (!shares || !shares.some((share) => share.permissionMode !== permissionMode)) {
      return;
    }
    void api.sessionShares.syncPermission(sessionId, permissionMode)
      .then(() => {
        setShares((previous) => previous?.map((share) => ({ ...share, permissionMode })) ?? previous);
      })
      .catch(() => {});
  }, [permissionMode, sessionId, shares]);

  const create = async () => {
    setIsCreating(true);
    setError(null);
    try {
      const payload = await readApiJson<{ share: ShareLink }>(await api.sessionShares.create({
        sessionId,
        permissionMode,
        expiresInHours: expiry === 'never' ? null : Number(expiry),
      }));
      setShares((previous) => [payload.share, ...(previous ?? [])]);
      // 만들자마자 복사해 둔다. 링크를 만든 이유가 곧 누군가에게 보내는 것이다.
      if (await copyTextToClipboard(buildShareUrl(payload.share.token, publicBaseUrl))) {
        setCopiedId(payload.share.id);
      }
    } catch {
      setError(t('section.createFailed'));
    } finally {
      setIsCreating(false);
    }
  };

  const revoke = async (id: number) => {
    setError(null);
    try {
      await readApiJson(await api.sessionShares.revoke(id));
      setShares((previous) => previous?.filter((share) => share.id !== id) ?? previous);
    } catch {
      setError(t('section.revokeFailed'));
    }
  };

  const copy = async (share: ShareLink) => {
    if (await copyTextToClipboard(buildShareUrl(share.token, publicBaseUrl))) {
      setCopiedId(share.id);
    }
  };

  const formatDate = (value: string) => {
    try {
      return new Date(value).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return value;
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('section.description')}</p>

      <div className="space-y-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
        <p className="text-foreground">{t('section.permission', { mode: permissionLabel })}</p>
        {permissionMode === 'default' && (
          <p className="text-muted-foreground">{t('section.permissionAsk')}</p>
        )}
        {permissionMode === 'bypassPermissions' && (
          <p className="text-amber-700 dark:text-amber-300">{t('section.permissionDanger')}</p>
        )}
      </div>

      <div className="space-y-1">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-foreground">{t('section.publicUrl')}</span>
          <Input
            value={publicBaseUrl}
            onChange={(event) => setPublicBaseUrl(event.target.value)}
            onBlur={() => writePublicBaseUrl(publicBaseUrl.trim())}
            placeholder={t('section.publicUrlPlaceholder')}
            className="h-9 text-sm"
          />
        </label>
        <p className="text-[11px] text-muted-foreground">
          {t('section.publicUrlHint', { origin: window.location.origin })}
        </p>
      </div>

      <div className="flex gap-2">
        <select
          value={expiry}
          onChange={(event) => setExpiry(event.target.value as ExpiryChoice)}
          aria-label={t('section.expiry')}
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
        >
          {EXPIRY_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {t('section.expiry')}: {t(`section.expiryOptions.${choice}`)}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          className="h-9 flex-shrink-0"
          disabled={isCreating}
          onClick={() => void create()}
        >
          {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
          {isCreating ? t('section.creating') : t('section.create')}
        </Button>
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">{t('section.activeTitle')}</p>
        {shares === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : shares.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('section.empty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {shares.map((share) => (
              <li
                key={share.id}
                className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11px] text-foreground" title={buildShareUrl(share.token, publicBaseUrl)}>
                    {buildShareUrl(share.token, publicBaseUrl)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {share.expiresAt
                      ? t('section.expiresAt', { date: formatDate(share.expiresAt) })
                      : t('section.noExpiry')}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 flex-shrink-0 px-2 text-xs"
                  onClick={() => void copy(share)}
                >
                  {copiedId === share.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedId === share.id ? t('section.copied') : t('section.copy')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 flex-shrink-0 px-2 text-xs text-red-600 hover:text-red-700 dark:text-red-400"
                  onClick={() => void revoke(share.id)}
                >
                  <Unlink className="h-3.5 w-3.5" />
                  {t('section.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
