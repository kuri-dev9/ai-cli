import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { BookmarkPlus, Check, ListPlus, Settings2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useRoomRolePresets } from '@/modules/rooms/hooks/useRoomRolePresets';
import RoomPresetManager from '@/modules/rooms/RoomPresetManager';
import {
  addRoomRolePreset,
  isValidRoomDisplayName,
  pickAvailableDisplayName,
} from '@/modules/rooms/utils/roomRolePresets';
import type { RoomRolePreset } from '@/modules/rooms/utils/roomRolePresets';
import { api, readApiJson } from '@/shared/api';
import { ROOM_INVITABLE_PROVIDERS } from '@/shared/constants';
import { useEnabledProviders } from '@/shared/hooks/useEnabledProviders';
import type { ProviderModelsDefinition, RoomDetail } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';

/**
 * Where the invitee goes: a plain session becoming a room, or an existing room.
 *
 * `create` 는 호스트 세션 id 를 보낼 때 받아 온다. 아직 한 마디도 하지 않은 새
 * 대화에는 세션이 없어서, 초대를 누르는 순간에 만들어야 하기 때문이다.
 */
type InviteTarget =
  /**
   * `fresh` 는 아직 한 마디도 하지 않은 새 대화다. 남길 대화가 없으니 따로 "내
   * 세션" 을 두지 않고, 방장으로 고른 사람이 곧 이 세션이 된다 — 그 사람의
   * 프로바이더로 세션을 열도록 `resolveHostSessionId` 에 넘긴다.
   */
  | { kind: 'create'; fresh?: boolean; resolveHostSessionId: (provider?: string) => Promise<string> }
  | { kind: 'add'; roomId: string };

type InviteParticipantModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: InviteTarget;
  /** Display names already used in the room, rejected before the request goes out. */
  takenNames: string[];
  onInvited: (detail: RoomDetail) => void;
};

/** 한 명분 초대 내용. 서버에 그대로 보낸다. */
type InviteeInput = {
  provider: string;
  model: string | null;
  /** 등록된 Claude 계정 id. Claude 가 아니면 비워 둔다. */
  claudeAccountId?: string | null;
  displayName: string;
  roleName: string;
  rolePrompt?: string;
  persona?: string;
  status: 'active' | 'standby';
};

/** 목록에 담아 둔 한 명. 프리셋 칩으로 담았으면 어느 프리셋인지 기억해 칩을 다시 누르면 뺀다. */
type QueuedInvitee = InviteeInput & { presetId?: string };

type ClaudeAccount = {
  id: string;
  label: string;
  configDir: string | null;
};

const FIELD_CLASS = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none';
const QUEUE_FIELD_CLASS = 'rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none';

/**
 * Invite form shared by InviteParticipantButton (first invite, which creates
 * the room) and RoomInterface (adding a member to an existing room).
 */
export default function InviteParticipantModal({
  open,
  onOpenChange,
  target,
  takenNames,
  onInvited,
}: InviteParticipantModalProps) {
  const { t } = useTranslation('chat');
  const enabledProviders = useEnabledProviders();
  const providers = useMemo(
    () => ROOM_INVITABLE_PROVIDERS.filter((provider) => enabledProviders.includes(provider)),
    [enabledProviders],
  );

  // 폼으로 적는 사람의 프로바이더·모델·계정. 화면에 따로 고르는 칸은 없고, 목록에
  // 담긴 뒤 줄마다 고른다. 담긴 사람을 폼으로 꺼내 고칠 때 고른 값을 잃지 않게 둔다.
  const defaultProvider = providers[0] ?? 'claude';
  const [provider, setProvider] = useState<string>(defaultProvider);
  const [model, setModel] = useState('');
  const [claudeAccountId, setClaudeAccountId] = useState('');
  const [claudeAccounts, setClaudeAccounts] = useState<ClaudeAccount[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [roleName, setRoleName] = useState('');
  const [rolePrompt, setRolePrompt] = useState('');
  const [persona, setPersona] = useState('');
  // 명단에 담을지(불러야 옴) 바로 들일지(매 차례 함께 돎).
  const [joinNow, setJoinNow] = useState(false);
  // Optional host identity, only sent with the first invite.
  const [hostDisplayName, setHostDisplayName] = useState('');
  const [hostRoleName, setHostRoleName] = useState('');
  const [hostRolePrompt, setHostRolePrompt] = useState('');
  const [hostPersona, setHostPersona] = useState('');
  // 초대 폼과 프리셋 관리 화면 중 무엇을 보여줄지.
  const [view, setView] = useState<'invite' | 'presets'>('invite');
  // 폼에 채운 프리셋. 저장 직후 그 칩을 알아보는 데만 쓴다.
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [hostPresetId, setHostPresetId] = useState<string>('');
  // "프리셋으로 저장"을 누른 직후 잠깐 보여주는 확인 표시.
  const [presetSaved, setPresetSaved] = useState(false);
  const presets = useRoomRolePresets();
  // Model lists fetched so far, by provider; the select reads the chosen one.
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, ProviderModelsDefinition>>({});
  // "목록에 담기" 로 쌓아 둔 사람. 초대를 누르면 폼에 남은 사람과 함께 차례로 들어온다.
  const [queue, setQueue] = useState<QueuedInvitee[]>([]);
  // 방장으로 세울 초대 대상의 이름. 비어 있으면 처음 만들 때는 내 세션, 더할 때는 지금 방장 그대로다.
  const [leaderName, setLeaderName] = useState('');
  // 여럿을 초대하다 룸을 만든 뒤 실패했으면, 다시 누를 때는 그 룸에 더한다.
  const [createdRoomId, setCreatedRoomId] = useState<string | null>(null);
  // In-flight flag so a double click cannot invite twice.
  const [submitting, setSubmitting] = useState(false);
  // Server (or validation) message shown above the buttons.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 목록의 줄마다 프로바이더를 따로 고르므로, 쓸 수 있는 프로바이더의 모델 목록을 모두 받아 둔다.
  const missingCatalogs = providers.filter((option) => !modelCatalogs[option]).join(',');
  useEffect(() => {
    if (!open || !missingCatalogs) return undefined;
    let cancelled = false;
    for (const option of missingCatalogs.split(',')) {
      void (async () => {
        try {
          const response = await api.providers.models(option);
          const body = await readApiJson<{ data?: { models?: ProviderModelsDefinition } }>(response);
          const models = body.data?.models;
          if (!cancelled && models) {
            setModelCatalogs((previous) => ({ ...previous, [option]: models }));
          }
        } catch {
          // The default model still works without the list.
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [open, missingCatalogs]);

  // Claude 계정 목록. 다른 프로바이더를 고를 땐 쓰지 않아 열릴 때 한 번만 가져온다.
  useEffect(() => {
    if (!open || claudeAccounts.length > 0) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.providers.claudeAccounts();
        const body = await readApiJson<{ data?: ClaudeAccount[] }>(response);
        if (!cancelled && Array.isArray(body.data)) {
          setClaudeAccounts(body.data);
        }
      } catch {
        // 계정 선택 없이도 초대는 되니 조용히 넘어간다.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applyHostPreset = (presetId: string) => {
    setHostPresetId(presetId);
    const preset = presets.find((candidate) => candidate.id === presetId);
    setHostDisplayName(preset?.displayName ?? '');
    setHostRoleName(preset?.roleName ?? '');
    setHostRolePrompt(preset?.rolePrompt ?? '');
    setHostPersona(preset?.persona ?? '');
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setErrorMessage(null);
      setQueue([]);
      setLeaderName('');
      setCreatedRoomId(null);
      setView('invite');
      setSelectedPresetId(null);
    }
    onOpenChange(next);
  };

  /** 목록의 한 사람만 고친다. 프로바이더를 바꾸면 모델과 계정은 그 프로바이더 것이 아니라 비운다. */
  const updateQueued = (index: number, patch: Partial<Pick<InviteeInput, 'provider' | 'model' | 'claudeAccountId'>>) => {
    setQueue((previous) => previous.map((invitee, position) => {
      if (position !== index) return invitee;
      if (patch.provider && patch.provider !== invitee.provider) {
        return { ...invitee, provider: patch.provider, model: null, claudeAccountId: null };
      }
      return { ...invitee, ...patch };
    }));
  };

  // 처음 만들 때는 아직 룸이 없으니, 호스트가 쓸 이름도 겹치면 안 되는 이름이다.
  // 목록에 담아 둔 이름도 곧 룸에 들어올 이름이다.
  const allTakenNames = [
    ...(target.kind === 'create' && !createdRoomId && !target.fresh ? [...takenNames, hostDisplayName.trim() || 'Claude'] : takenNames),
    ...queue.map((invitee) => invitee.displayName),
  ];

  /**
   * 프리셋 칩은 여러 개를 골라 한꺼번에 초대한다. 누르면 목록에 담기고, 다시
   * 누르면 빠진다. 프로바이더는 프리셋이 추천하는 것을 쓸 수 있으면 따르고,
   * 모델·계정은 목록에서 사람마다 고른다.
   */
  const togglePreset = (preset: RoomRolePreset) => {
    if (queue.some((invitee) => invitee.presetId === preset.id)) {
      setQueue((previous) => previous.filter((invitee) => invitee.presetId !== preset.id));
      return;
    }
    setQueue((previous) => [...previous, {
      presetId: preset.id,
      provider: preset.provider && providers.includes(preset.provider) ? preset.provider : defaultProvider,
      model: null,
      claudeAccountId: null,
      displayName: pickAvailableDisplayName(preset.displayName, allTakenNames),
      roleName: preset.roleName,
      rolePrompt: preset.rolePrompt || undefined,
      persona: preset.persona || undefined,
      status: joinNow ? 'active' : 'standby',
    }]);
  };

  /** 담아 둔 사람을 폼으로 꺼내 고친다. 폼에 적던 것은 덮어쓴다. */
  const editQueued = (index: number) => {
    const invitee = queue[index];
    if (!invitee) return;
    setQueue((previous) => previous.filter((_, position) => position !== index));
    setProvider(invitee.provider);
    setModel(invitee.model ?? '');
    setClaudeAccountId(invitee.claudeAccountId ?? '');
    setDisplayName(invitee.displayName);
    setRoleName(invitee.roleName);
    setRolePrompt(invitee.rolePrompt ?? '');
    setPersona(invitee.persona ?? '');
    setJoinNow(invitee.status === 'active');
    setSelectedPresetId(invitee.presetId ?? null);
  };

  const saveCurrentAsPreset = () => {
    const saved = addRoomRolePreset({
      displayName: displayName.trim(),
      roleName: roleName.trim(),
      rolePrompt: rolePrompt.trim(),
      persona: persona.trim(),
      provider: provider === 'claude' || provider === 'codex' ? provider : null,
    });
    if (saved) {
      setSelectedPresetId(saved.id);
      setPresetSaved(true);
      window.setTimeout(() => setPresetSaved(false), 1500);
    }
  };

  const trimmedName = displayName.trim();
  const nameInvalid = trimmedName.length > 0 && !isValidRoomDisplayName(trimmedName);
  const nameTaken = allTakenNames.some((name) => name.toLowerCase() === trimmedName.toLowerCase());
  const formValid = isValidRoomDisplayName(trimmedName) && !nameTaken && roleName.trim().length > 0;
  // 폼이 비었으면 담아 둔 사람만 초대한다. 뭔가 적혀 있으면 그것도 올바라야 한다.
  const formEmpty = !trimmedName && !roleName.trim();
  const inviteCount = queue.length + (formValid ? 1 : 0);
  const canSubmit = !submitting && (formValid || (formEmpty && queue.length > 0));
  // 룸을 처음 만들 때의 첫 참가자는 늘 상주다. 부를 호스트가 아직 말하기 전이다.
  const firstCreatesRoom = target.kind === 'create' && !createdRoomId;
  // 새 대화로 처음 만드는 중이면 방장이 원래 세션이 된다. 따로 "내 세션" 은 없다.
  const leaderIsHostSession = firstCreatesRoom && target.kind === 'create' && Boolean(target.fresh);
  const showJoinMode = target.kind === 'add' || createdRoomId !== null || queue.length > 0;
  // 방장으로 고를 수 있는 초대 대상. 고른 사람이 목록에서 빠졌으면 고르지 않은 것으로 본다.
  const leaderCandidates = [...queue.map((invitee) => invitee.displayName), ...(formValid ? [trimmedName] : [])];
  const effectiveLeaderName = leaderCandidates.includes(leaderName)
    ? leaderName
    : leaderIsHostSession ? (leaderCandidates[0] ?? '') : '';
  const showLeaderPick = firstCreatesRoom || leaderCandidates.length > 0;

  const resetForm = () => {
    setProvider(defaultProvider);
    setModel('');
    setClaudeAccountId('');
    setDisplayName('');
    setRoleName('');
    setRolePrompt('');
    setPersona('');
    setSelectedPresetId(null);
  };

  const buildInvitee = (): InviteeInput => ({
    provider,
    model: model || null,
    claudeAccountId: provider === 'claude' ? (claudeAccountId || null) : null,
    displayName: trimmedName,
    roleName: roleName.trim(),
    rolePrompt: rolePrompt.trim() || undefined,
    persona: persona.trim() || undefined,
    status: joinNow ? 'active' : 'standby',
  });

  const addToQueue = () => {
    if (!formValid) return;
    setQueue((previous) => [...previous, buildInvitee()]);
    resetForm();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMessage(null);
    // 방장으로 세울 사람은 상주로 들인다 — 방장은 사용자 글을 먼저 받는다.
    const invitees: InviteeInput[] = ([...queue, ...(formValid ? [buildInvitee()] : [])] as QueuedInvitee[])
      .map(({ presetId: _presetId, ...invitee }, index) => (
        (index === 0 && firstCreatesRoom) || invitee.displayName === effectiveLeaderName
          ? { ...invitee, status: 'active' as const }
          : invitee
      ));
    // 새 대화면 방장이 곧 원래 세션이라 초대 목록에서 빠지고 룸을 만들 때 호스트로 간다.
    const leaderAsHost = leaderIsHostSession
      ? invitees.find((invitee) => invitee.displayName === effectiveLeaderName) ?? null
      : null;
    const pending = invitees.filter((invitee) => invitee !== leaderAsHost);
    // 들어간 사람의 이름. 실패하면 아직 안 들어간 사람만 목록에 남긴다.
    const joined = new Set<string>();
    let roomId = target.kind === 'add' ? target.roomId : createdRoomId;
    let leaderParticipantId: string | null = null;

    const accept = (detail: RoomDetail | undefined, participant: InviteeInput | null) => {
      if (!detail) return;
      if (!roomId) {
        roomId = detail.room.roomId;
        setCreatedRoomId(roomId);
      }
      if (participant && !leaderAsHost && participant.displayName === effectiveLeaderName) {
        leaderParticipantId = detail.participants
          .find((member) => member.displayName === participant.displayName)?.participantId ?? null;
      }
      onInvited(detail);
    };

    try {
      if (!roomId && target.kind === 'create') {
        const participant = pending.shift() ?? null;
        const host = leaderAsHost
          ? {
            displayName: leaderAsHost.displayName,
            roleName: leaderAsHost.roleName,
            rolePrompt: leaderAsHost.rolePrompt,
            persona: leaderAsHost.persona,
            model: leaderAsHost.model,
            claudeAccountId: leaderAsHost.claudeAccountId,
          }
          : hostDisplayName.trim() || hostRoleName.trim() || hostRolePrompt.trim() || hostPersona.trim()
            ? {
              displayName: hostDisplayName.trim() || undefined,
              roleName: hostRoleName.trim() || undefined,
              rolePrompt: hostRolePrompt.trim() || undefined,
              persona: hostPersona.trim() || undefined,
            }
            : undefined;
        const response = await api.rooms.create({
          hostSessionId: await target.resolveHostSessionId(leaderAsHost?.provider),
          host,
          participant: participant ?? undefined,
        });
        const body = await readApiJson<{ data?: RoomDetail }>(response);
        if (leaderAsHost) joined.add(leaderAsHost.displayName);
        if (participant) joined.add(participant.displayName);
        accept(body.data, participant);
      }
      // 한 명씩 차례로 보낸다. 이름 겹침과 인원 상한을 서버가 한 명마다 따진다.
      for (const participant of pending) {
        const response = await api.rooms.addParticipant(roomId!, participant);
        const body = await readApiJson<{ data?: RoomDetail }>(response);
        joined.add(participant.displayName);
        accept(body.data, participant);
      }
      if (roomId && leaderParticipantId) {
        const response = await api.rooms.setLeader(roomId, leaderParticipantId);
        const body = await readApiJson<{ data?: RoomDetail }>(response);
        if (body.data) onInvited(body.data);
      }
      resetForm();
      handleOpenChange(false);
    } catch (error) {
      // 들어간 사람은 목록에서 빼고, 남은 사람으로 다시 누를 수 있게 한다.
      // 폼에 적힌 사람이 아직 안 들어갔으면 폼에 그대로 둔다.
      // 모두 들어갔는데 실패했다면 방장 넘기기다. 룸의 참가자 설정에서 다시 넘길 수 있다.
      const formName = formValid ? trimmedName : null;
      const formJoined = formName !== null && joined.has(formName);
      setQueue(invitees.filter((invitee) => !joined.has(invitee.displayName) && invitee.displayName !== formName));
      if (formJoined) resetForm();
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* 사람마다 프로바이더·모델·계정을 한 줄에 고르므로 기본 대화창보다 넓게 연다. */}
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-4xl overflow-y-auto p-6">
        <DialogTitle>{t('rooms.inviteTitle')}</DialogTitle>
        {view === 'presets' ? (
          <RoomPresetManager onBack={() => setView('invite')} />
        ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">{t('rooms.inviteTitle')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {target.kind === 'add'
                ? t('rooms.inviteDescriptionAdd')
                : target.fresh ? t('rooms.inviteDescriptionCreateFresh') : t('rooms.inviteDescriptionCreate')}
            </p>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">{t('rooms.presets')}</span>
              <button
                type="button"
                onClick={() => setView('presets')}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Settings2 className="h-3.5 w-3.5" />
                {t('rooms.presetsManage')}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {presets.length === 0 && (
                <span className="text-xs text-muted-foreground">{t('rooms.presetsEmpty')}</span>
              )}
              {presets.map((preset) => {
                const picked = queue.some((invitee) => invitee.presetId === preset.id);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => togglePreset(preset)}
                    aria-pressed={picked}
                    title={preset.rolePrompt || preset.roleName}
                    className={cn(
                      'flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
                      picked || selectedPresetId === preset.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent',
                    )}
                  >
                    {picked && <Check className="h-3 w-3 text-primary" />}
                    {preset.provider && <LLMProviderLogo provider={preset.provider} className="h-3 w-3" />}
                    <span className="font-medium">{preset.displayName}</span>
                    <span className="text-muted-foreground">{preset.roleName}</span>
                  </button>
                );
              })}
            </div>
            {presets.length > 0 && (
              <p className="mt-1.5 text-xs text-muted-foreground">{t('rooms.presetsMultiHint')}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('rooms.displayName')}</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t('rooms.displayNamePlaceholder')}
                className={FIELD_CLASS}
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('rooms.roleName')}</span>
              <input
                value={roleName}
                onChange={(event) => setRoleName(event.target.value)}
                placeholder={t('rooms.roleNamePlaceholder')}
                className={FIELD_CLASS}
                autoComplete="off"
              />
            </label>
          </div>
          {(nameInvalid || nameTaken) && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {nameInvalid ? t('rooms.displayNameInvalid') : t('rooms.displayNameTaken')}
            </p>
          )}

          <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('rooms.rolePrompt')}</span>
            <textarea
              value={rolePrompt}
              onChange={(event) => setRolePrompt(event.target.value)}
              placeholder={t('rooms.rolePromptPlaceholder')}
              rows={3}
              className={FIELD_CLASS}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('rooms.persona')}</span>
            <textarea
              value={persona}
              onChange={(event) => setPersona(event.target.value)}
              placeholder={t('rooms.personaPlaceholder')}
              rows={3}
              className={FIELD_CLASS}
            />
          </label>
          </div>
          {showJoinMode && (
            <div className="rounded-md border border-border/60 px-3 py-2">
              <div className="inline-flex overflow-hidden rounded-md border border-border text-xs" role="group" aria-label={t('rooms.joinMode')}>
                {([false, true] as const).map((value) => (
                  <button
                    key={String(value)}
                    type="button"
                    aria-pressed={joinNow === value}
                    onClick={() => setJoinNow(value)}
                    className={cn(
                      'px-2.5 py-1 transition-colors',
                      joinNow === value
                        ? 'bg-primary/15 font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    {value ? t('rooms.joinNow') : t('rooms.joinOnCall')}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {joinNow ? t('rooms.joinNowHint') : t('rooms.joinOnCallHint')}
              </p>
            </div>
          )}

          <div className="-mt-1 flex justify-end gap-3">
            <button
              type="button"
              onClick={addToQueue}
              disabled={!formValid}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <ListPlus className="h-3.5 w-3.5" />
              {t('rooms.queueAdd')}
            </button>
            <button
              type="button"
              onClick={saveCurrentAsPreset}
              disabled={!isValidRoomDisplayName(trimmedName) || !roleName.trim()}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
              {presetSaved ? t('rooms.presetSaved') : t('rooms.presetSaveCurrent')}
            </button>
          </div>

          {queue.length > 0 && (
            <div className="rounded-md border border-border/60 px-3 py-2">
              <ul className="space-y-2">
                {queue.map((invitee, index) => {
                  const catalog = modelCatalogs[invitee.provider];
                  return (
                    <li key={invitee.displayName} className="space-y-1.5 border-b border-border/40 pb-2 last:border-b-0 last:pb-0">
                      <div className="flex items-center gap-1 text-xs">
                        <button
                          type="button"
                          onClick={() => editQueued(index)}
                          title={t('rooms.queueEdit', { name: invitee.displayName })}
                          className="flex min-w-0 items-center gap-1 hover:text-primary"
                        >
                          <span className="truncate font-medium">{invitee.displayName}</span>
                          <span className="truncate text-muted-foreground">{invitee.roleName}</span>
                        </button>
                        {invitee.displayName === effectiveLeaderName && <span className="text-primary">· {t('rooms.leader')}</span>}
                        {(invitee.status === 'active' || (index === 0 && firstCreatesRoom) || invitee.displayName === effectiveLeaderName)
                          && <span className="text-muted-foreground">· {t('rooms.joinNow')}</span>}
                        <button
                          type="button"
                          onClick={() => setQueue((previous) => previous.filter((_, position) => position !== index))}
                          aria-label={t('rooms.queueRemove', { name: invitee.displayName })}
                          className="ml-auto text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="inline-flex overflow-hidden rounded-md border border-border" role="group" aria-label={t('rooms.queueProvider', { name: invitee.displayName })}>
                          {ROOM_INVITABLE_PROVIDERS.map((option) => (
                            <button
                              key={option}
                              type="button"
                              disabled={!providers.includes(option)}
                              aria-pressed={invitee.provider === option}
                              title={option === 'codex' ? 'Codex' : 'Claude'}
                              onClick={() => updateQueued(index, { provider: option })}
                              className={cn(
                                'flex items-center gap-1 px-2 py-1 text-xs transition-colors disabled:opacity-40',
                                invitee.provider === option ? 'bg-primary/15 font-medium' : 'text-muted-foreground hover:bg-accent',
                              )}
                            >
                              <LLMProviderLogo provider={option} className="h-3.5 w-3.5" />
                              {option === 'codex' ? 'Codex' : 'Claude'}
                            </button>
                          ))}
                        </div>
                        <select
                          value={invitee.model ?? ''}
                          onChange={(event) => updateQueued(index, { model: event.target.value || null })}
                          aria-label={t('rooms.queueModel', { name: invitee.displayName })}
                          className={cn(QUEUE_FIELD_CLASS, 'min-w-0 flex-1')}
                        >
                          <option value="">{t('rooms.modelDefault')}</option>
                          {(catalog?.OPTIONS ?? []).map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                        {invitee.provider === 'claude' && claudeAccounts.length > 0 && (
                          <select
                            value={invitee.claudeAccountId ?? ''}
                            onChange={(event) => updateQueued(index, { claudeAccountId: event.target.value || null })}
                            aria-label={t('rooms.queueClaudeAccount', { name: invitee.displayName })}
                            className={cn(QUEUE_FIELD_CLASS, 'min-w-0 flex-1')}
                          >
                            <option value="">{t('rooms.claudeAccountDefault')}</option>
                            {claudeAccounts.map((account) => (
                              <option key={account.id} value={account.id}>{account.label}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1.5 text-xs text-muted-foreground">{t('rooms.queueHint')}</p>
            </div>
          )}

          {target.kind === 'create' && !createdRoomId && !leaderIsHostSession && (
            <details open className="rounded-md border border-border/60 px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">{t('rooms.hostSection')}</summary>
              <select
                value={hostPresetId}
                onChange={(event) => applyHostPreset(event.target.value)}
                aria-label={t('rooms.hostPreset')}
                className={cn(FIELD_CLASS, 'mt-2')}
              >
                <option value="">{t('rooms.hostPresetNone')}</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.displayName} · {preset.roleName}</option>
                ))}
              </select>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <input
                  value={hostDisplayName}
                  onChange={(event) => setHostDisplayName(event.target.value)}
                  placeholder={t('rooms.hostDisplayName')}
                  aria-label={t('rooms.hostDisplayName')}
                  className={FIELD_CLASS}
                  autoComplete="off"
                />
                <input
                  value={hostRoleName}
                  onChange={(event) => setHostRoleName(event.target.value)}
                  placeholder={t('rooms.hostRoleName')}
                  aria-label={t('rooms.hostRoleName')}
                  className={FIELD_CLASS}
                  autoComplete="off"
                />
              </div>
            </details>
          )}

          {showLeaderPick && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('rooms.leaderPick')}</span>
              <select
                value={effectiveLeaderName}
                onChange={(event) => setLeaderName(event.target.value)}
                aria-label={t('rooms.leaderPick')}
                className={FIELD_CLASS}
              >
                {/* 새 대화에는 남길 "내 세션" 이 없다. 고른 방장이 곧 이 세션이다. */}
                {!leaderIsHostSession && (
                  <option value="">
                    {firstCreatesRoom
                      ? t('rooms.leaderMySession', { name: hostDisplayName.trim() || 'Claude' })
                      : t('rooms.leaderKeep')}
                  </option>
                )}
                {leaderIsHostSession && leaderCandidates.length === 0 && (
                  <option value="">{t('rooms.leaderPickEmpty')}</option>
                )}
                {leaderCandidates.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {leaderIsHostSession ? t('rooms.leaderPickHintFresh') : t('rooms.leaderPickHint')}
              </p>
            </label>
          )}

          {errorMessage && (
            <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {errorMessage}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
              {t('rooms.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>
              {submitting ? t('rooms.inviting') : inviteCount > 1 ? t('rooms.inviteMany', { count: inviteCount }) : t('rooms.invite')}
            </Button>
          </div>
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
