export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';

// resolveContextWindow: used by Commands so /cost can report how much of the
// context window is left, which needs the model's real window rather than the
// one-size-fits-all CONTEXT_WINDOW setting.
export { resolveContextWindow } from './services/context-window.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read, and
// by the Telegram bridge to allocate a session for `/new`.
export { sessionsService } from './services/sessions.service.js';

// providerAuthService: used by the Telegram bridge so `/new` only offers the
// agents that are installed and signed in on this machine.
export { providerAuthService } from './services/provider-auth.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
