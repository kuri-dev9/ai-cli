export { default as ChatInterface } from '@/modules/chat/ChatInterface';
export { getClaudeSettings } from '@/modules/chat/utils/chatStorage';
// Transcript building blocks reused by the rooms module to draw a running
// participant's live turn and answer its permission prompts the same way chat does.
export { default as MessageComponent } from '@/modules/chat/transcript/MessageComponent';
export { default as PermissionRequestsBanner } from '@/modules/chat/composer/PermissionRequestsBanner';
export { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
export { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
export { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
// The chat composer and the state behind it, reused by the rooms module so a
// team room's input is the same composer as a chat's; submitOverride routes the
// send to the room. The provider state, model menu, token summary and command
// result modal back the per-participant settings and the host's slash commands.
export { default as ChatComposer } from '@/modules/chat/composer/ChatComposer';
export { default as ComposerModelMenu } from '@/modules/chat/composer/ComposerModelMenu';
export { default as TokenUsageSummary } from '@/modules/chat/composer/TokenUsageSummary';
export { default as CommandResultModal } from '@/modules/chat/modals/CommandResultModal';
export { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
export { useChatProviderState } from '@/modules/chat/hooks/useChatProviderState';
// 예약 메시지. 룸도 원래 대화 세션 앞으로 예약을 걸고, 서버가 때가 되면 룸 메시지로 올린다.
export { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';
// 스트리밍 중 바닥 따라가기 판정. 룸 타임라인도 채팅과 같은 규칙으로 따라간다.
export { resolveFollowIntent, resolveScrolledUpAfterScroll } from '@/modules/chat/hooks/useChatSessionState';
export type { ScrollSample } from '@/modules/chat/hooks/useChatSessionState';
// 세션 설정. 워크스페이스 헤더가 단추 자리를 비워 두고, 룸 설정 창도 같은 자동 압축 슬라이더를 쓴다.
export { SESSION_SETTINGS_SLOT_ID } from '@/modules/chat/settings/sessionSettingsSlot';
export { default as AutoCompactFields } from '@/modules/chat/settings/AutoCompactFields';
