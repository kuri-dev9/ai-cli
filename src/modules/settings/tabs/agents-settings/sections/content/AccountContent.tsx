import { Eye, EyeOff, LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, Button, LLMProviderLogo } from '@/shared/ui';
import { PROVIDER_CONNECTION_TONES } from '@/shared/constants';
import type { AgentProvider, ProviderAuthStatus } from '@/shared/types';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { setProviderEnabled } from '@/shared/providerVisibility';
import { readProviderConnectionTone } from '@/shared/utils';
import { useEnabledProviders } from '@/shared/hooks/useEnabledProviders';

type AccountContentProps = {
  agent: AgentProvider;
  authStatus: ProviderAuthStatus;
  onLogin: () => void;
};

const agentNames: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** 번역이 없을 때만 쓰는 설명 문구. 이름과 달리 프로바이더마다 다를 이유가 있다. */
const agentFallbackDescriptions: Partial<Record<AgentProvider, string>> = {
  opencode: 'OpenCode CLI assistant',
};

/** Rendered by AgentCategoryContentSection for the "account" category to show sign-in state for one provider. */
export default function AccountContent({ agent, authStatus, onLogin }: AccountContentProps) {
  const { t } = useTranslation('settings');
  const agentName = agentNames[agent];
  // 카드 색은 어느 CLI 인지가 아니라 연결이 지금 어떤 상태인지를 말한다.
  const tone = PROVIDER_CONNECTION_TONES[readProviderConnectionTone(authStatus)];

  const enabledProviders = useEnabledProviders();
  const isEnabled = enabledProviders.includes(agent);
  // 마지막으로 남은 하나까지 끄면 채팅을 시작할 CLI 가 없어진다. 그래서 그때는
  // 토글을 비활성화해 아예 누를 수 없게 하고, 왜 못 끄는지 한 줄로 설명한다.
  // (`setProviderEnabled` 도 같은 규칙으로 거절하므로 UI 를 우회해도 안전하다.)
  const canDisable = !isEnabled || enabledProviders.length > 1;

  return (
    <div className="space-y-6">
      <div className="mb-4 flex items-center gap-3">
        <LLMProviderLogo
          provider={agent}
          className={`h-6 w-6 ${isEnabled ? '' : 'opacity-40 grayscale'}`}
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-medium text-foreground">{agentName}</h3>
            {!isEnabled && (
              <Badge variant="secondary" className="bg-muted text-muted-foreground">
                {t('agents.visibility.disabledBadge')}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {t(`agents.account.${agent}.description`, {
              defaultValue: agentFallbackDescriptions[agent] || `${agentName} CLI assistant`,
            })}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-medium text-foreground">
              {isEnabled
                ? <Eye className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                : <EyeOff className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
              {t('agents.visibility.title')}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {isEnabled
                ? t('agents.visibility.enabledDescription')
                : t('agents.visibility.disabledDescription')}
            </p>
            {isEnabled && !canDisable && (
              <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-500">
                {t('agents.visibility.lastOneHint')}
              </p>
            )}
          </div>
          <SettingsToggle
            checked={isEnabled}
            disabled={isEnabled && !canDisable}
            onChange={(next) => setProviderEnabled(agent, next)}
            ariaLabel={t('agents.visibility.toggleLabel', { agent: agentName })}
          />
        </div>
      </div>

      <div className={`rounded-lg border p-4 ${tone.cardClass}`}>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className={`font-medium ${tone.titleClass}`}>
                {t('agents.connectionStatus')}
              </div>
              <div className={`text-sm ${tone.textClass}`}>
                {authStatus.loading ? (
                  t('agents.authStatus.checkingAuth')
                ) : authStatus.authenticated ? (
                  t('agents.authStatus.loggedInAs', {
                    email: authStatus.email || t('agents.authStatus.authenticatedUser'),
                  })
                ) : (
                  t('agents.authStatus.notConnected')
                )}
              </div>
            </div>
            <div>
              {/* 배지도 카드와 같은 색을 쓴다 — 한 상태에 색 하나. */}
              <Badge variant="secondary" className={tone.badgeClass}>
                {authStatus.loading
                  ? t('agents.authStatus.checking')
                  : authStatus.authenticated
                    ? t('agents.authStatus.connected')
                    : t('agents.authStatus.disconnected')}
              </Badge>
            </div>
          </div>

          {authStatus.method !== 'api_key' && (
            <div className="border-t border-border/50 pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className={`font-medium ${tone.titleClass}`}>
                    {authStatus.authenticated ? t('agents.login.reAuthenticate') : t('agents.login.title')}
                  </div>
                  <div className={`text-sm ${tone.textClass}`}>
                    {authStatus.authenticated
                      ? t('agents.login.reAuthDescription')
                      : t('agents.login.description', { agent: agentName })}
                  </div>
                </div>
                {/* 버튼의 강조도 상태를 따른다. 이미 연결돼 있으면 재로그인은 보조 행동이다. */}
                <Button
                  onClick={onLogin}
                  variant={authStatus.authenticated ? 'outline' : 'default'}
                  size="sm"
                >
                  <LogIn className="mr-2 h-4 w-4" />
                  {authStatus.authenticated ? t('agents.login.reLoginButton') : t('agents.login.button')}
                </Button>
              </div>
            </div>
          )}

          {authStatus.error && (
            <div className="border-t border-border/50 pt-4">
              <div className="text-sm text-red-600 dark:text-red-400">
                {t('agents.error', { error: authStatus.error })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
