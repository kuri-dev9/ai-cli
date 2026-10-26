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
