export { default as ChatInterface } from '@/modules/chat/ChatInterface';
export { getClaudeSettings } from '@/modules/chat/utils/chatStorage';
// Transcript building blocks reused by the rooms module to draw a running
// participant's live turn and answer its permission prompts the same way chat does.
export { default as MessageComponent } from '@/modules/chat/transcript/MessageComponent';
export { default as PermissionRequestsBanner } from '@/modules/chat/composer/PermissionRequestsBanner';
export { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
export { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
export { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
