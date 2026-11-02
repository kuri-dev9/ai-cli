import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, LogIn, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { Badge, Button, Input, LLMProviderLogo } from '@/shared/ui';
import { PROVIDER_CONNECTION_TONES } from '@/shared/constants';
import type { AgentProvider, ProviderAuthStatus } from '@/shared/types';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { setProviderEnabled } from '@/shared/providerVisibility';
import { readProviderConnectionTone } from '@/shared/utils';
import { useEnabledProviders } from '@/shared/hooks/useEnabledProviders';

type ClaudeAccount = {
  id: string;
  label: string;
  /** `null` 은 `CLAUDE_CONFIG_DIR` 미설정 — 기본 `~/.claude`. */
  configDir: string | null;
};

/**
 * 이 PC에 로그인된 Claude 계정을 등록해 두면, 방/대화를 새로 시작할 때 그중
 * 하나를 고를 수 있다. 전환 개념은 없다 — 등록만 여기서 하고, 실제로 어느
 * 계정을 쓸지는 세션을 만드는 자리(방 초대, 새 대화)에서 고른다.
 */
function ClaudeAccountsManager() {
  const { t } = useTranslation('settings');
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newConfigDir, setNewConfigDir] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editConfigDir, setEditConfigDir] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.providers.claudeAccounts();
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      const payload = await response.json();
      setAccounts(Array.isArray(payload?.data) ? payload.data as ClaudeAccount[] : []);
    } catch (loadError) {
      console.error('Failed to load Claude accounts:', loadError);
      setError(t('agents.claudeAccounts.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRemove = useCallback(async (id: string) => {
    setError(null);
    try {
      const response = await api.providers.removeClaudeAccount(id);
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      await load();
    } catch (removeError) {
      console.error('Failed to remove Claude account:', removeError);
      setError(t('agents.claudeAccounts.removeFailed'));
    }
  }, [load, t]);

  const handleStartEdit = useCallback((account: ClaudeAccount) => {
    setEditingId(account.id);
    setEditLabel(account.label);
    setEditConfigDir(account.configDir ?? '');
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    const label = editLabel.trim();
    if (!editingId || !label) {
      return;
    }
    setIsUpdating(true);
    setError(null);
    try {
      const response = await api.providers.updateClaudeAccount(editingId, {
        label,
        configDir: editConfigDir.trim() || null,
      });
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      setEditingId(null);
      await load();
    } catch (updateError) {
      console.error('Failed to update Claude account:', updateError);
      setError(t('agents.claudeAccounts.updateFailed'));
    } finally {
      setIsUpdating(false);
    }
  }, [editConfigDir, editLabel, editingId, load, t]);

  const handleAdd = useCallback(async () => {
    const label = newLabel.trim();
    if (!label) {
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.providers.addClaudeAccount({
        label,
        configDir: newConfigDir.trim() || null,
      });
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      setNewLabel('');
      setNewConfigDir('');
      setShowAddForm(false);
      await load();
    } catch (addError) {
      console.error('Failed to add Claude account:', addError);
      setError(t('agents.claudeAccounts.addFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [load, newConfigDir, newLabel, t]);

  if (isLoading) {
    return null;
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-foreground">{t('agents.claudeAccounts.title')}</h4>
          <p className="text-xs text-muted-foreground">{t('agents.claudeAccounts.description')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowAddForm((previous) => !previous)}>
          {t('agents.claudeAccounts.add')}
        </Button>
      </div>

      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

      <div className="mt-3 space-y-2">
        {accounts.map((account) => (
          editingId === account.id ? (
            <div key={account.id} className="space-y-2 rounded-md border border-dashed border-border p-3">
              <Input
                placeholder={t('agents.claudeAccounts.labelPlaceholder')}
                value={editLabel}
                onChange={(event) => setEditLabel(event.target.value)}
              />
              <Input
                placeholder={t('agents.claudeAccounts.configDirPlaceholder')}
                value={editConfigDir}
                onChange={(event) => setEditConfigDir(event.target.value)}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveEdit} disabled={isUpdating || !editLabel.trim()}>
                  {t('agents.claudeAccounts.editSave')}
                </Button>
                <Button variant="ghost" size="sm" onClick={handleCancelEdit} disabled={isUpdating}>
                  {t('agents.claudeAccounts.editCancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div
              key={account.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <span className="truncate text-sm font-medium text-foreground">{account.label}</span>
                <p className="truncate text-xs text-muted-foreground">
                  {account.configDir ?? t('agents.claudeAccounts.defaultConfigDir')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleStartEdit(account)}
                  aria-label={t('agents.claudeAccounts.edit')}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemove(account.id)}
                  aria-label={t('agents.claudeAccounts.remove')}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )
        ))}
      </div>

      {showAddForm && (
        <div className="mt-3 space-y-2 rounded-md border border-dashed border-border p-3">
          <Input
            placeholder={t('agents.claudeAccounts.labelPlaceholder')}
            value={newLabel}
            onChange={(event) => setNewLabel(event.target.value)}
          />
          <Input
            placeholder={t('agents.claudeAccounts.configDirPlaceholder')}
            value={newConfigDir}
            onChange={(event) => setNewConfigDir(event.target.value)}
          />
          <Button size="sm" onClick={handleAdd} disabled={isSaving || !newLabel.trim()}>
            {t('agents.claudeAccounts.save')}
          </Button>
        </div>
      )}
    </div>
  );
}

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

      {agent === 'claude' && <ClaudeAccountsManager />}
    </div>
  );
}
