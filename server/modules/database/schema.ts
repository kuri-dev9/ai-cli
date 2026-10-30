const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_channel_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    label TEXT,
    metadata_json TEXT,
    enabled BOOLEAN DEFAULT 1,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel, endpoint_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0
);
`;

export const SCHEDULED_MESSAGES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    -- Composer preferences (model, effort, permission mode, attachments) as
    -- they were when the message was scheduled, so it runs the way the user
    -- set it up rather than however the session is configured hours later.
    options TEXT NOT NULL DEFAULT '{}',
    -- UTC. The client sends an absolute instant so the schedule does not move
    -- when the user changes time zone between scheduling and firing.
    scheduled_for DATETIME NOT NULL,
    -- pending | sent | failed | cancelled
    status TEXT NOT NULL DEFAULT 'pending',
    -- Why a failed one failed, shown next to it in the composer.
    failure_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    -- The session id used by the provider CLI/SDK on disk (JSONL file name,
    -- store.db folder, sqlite row id, ...). \`session_id\` is the stable
    -- app-facing id that the frontend uses for the whole session lifetime;
    -- \`provider_session_id\` is filled in once the provider announces its own
    -- id mid-run, or equals \`session_id\` for sessions discovered on disk.
    provider_session_id TEXT,
    custom_name TEXT,
    project_path TEXT,
    jsonl_path TEXT,
    -- Model and reasoning effort this session runs with. Written when the user
    -- changes either selection and on every send, so reopening a session
    -- restores its exact runtime configuration instead of provider defaults.
    model TEXT,
    effort TEXT,
    -- The app session this one was branched from, NULL for sessions created
    -- normally. Informational only: a fork is a fully independent provider
    -- session, and deleting the source does not affect it.
    forked_from_session_id TEXT,
    isArchived BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

/**
 * Persistent custom-model library used by the Providers module.
 *
 * Only user-created models are stored here. Predefined models remain source-
 * controlled in each provider's `-models.provider.ts` adapter so they can be
 * updated without migrating application data. `model_id` is unique only within
 * a provider because different CLIs can accept the same identifier.
 */
export const PROVIDER_MODELS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL CHECK (provider IN ('claude', 'cursor', 'codex', 'opencode')),
    model_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, model_id)
);
`;

/**
 * Per-user application preferences that used to live in browser localStorage.
 *
 * One row per (user, key); `preference_value` is always a JSON document so a
 * key can hold a scalar (`"dark"`), a flag (`false`) or a whole settings blob
 * without the schema having to know which. Keeping them server-side is what
 * makes a preference follow the user from one device to another.
 */
export const USER_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER NOT NULL,
    preference_key TEXT NOT NULL,
    preference_value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, preference_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * Unsent composer text and queued messages, per user and per chat scope.
 *
 * `draft_scope` is a session id, or `project:<projectId>` for a chat that has
 * not been sent yet and therefore has no session. Storing this server-side is
 * what lets a message typed on a laptop be finished on a phone.
 */
export const SESSION_DRAFTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_drafts (
    user_id INTEGER NOT NULL,
    draft_scope TEXT NOT NULL,
    draft_text TEXT NOT NULL DEFAULT '',
    queued_message TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, draft_scope),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * Provider sessions an app session has moved off, and must never move back to.
 *
 * Editing a message on a provider that cannot resume a transcript partway
 * (Codex) is done by branching: the conversation is copied up to the edited
 * turn and the app session follows the copy. The original transcript is left
 * on disk untouched — nothing is deleted — but it is no longer the session's,
 * and the indexer would otherwise rediscover it on its next full scan and hand
 * the session back to the version the user edited away from.
 */
/**
 * 어느 메시지가 앱 바깥(지금은 텔레그램)에서 들어왔는지.
 *
 * 세션 기록의 실체는 Claude CLI 가 쓰는 `.jsonl` 이라 우리가 거기에 필드를
 * 끼워 넣을 수 없다. 그렇다고 프롬프트 본문에 표시를 섞으면 모델이 읽는
 * 글이 사용자가 친 것과 달라진다. 그래서 출처만 이 표에 따로 두고, 기록을
 * 내려줄 때 붙인다.
 *
 * `content_hash` 로 맞춘다 — 턴을 시작하는 시점에는 CLI 가 만들 메시지
 * uuid 를 알 수 없기 때문이다. 한 번 맞춘 뒤에는 그 uuid 를
 * `transcript_anchor_id` 에 적어 고정한다. 같은 글을 나중에 브라우저에서
 * 또 보내도 이미 고정된 표시가 옮겨 붙지 않는다.
 */
export const MESSAGE_SOURCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS message_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL,
    transcript_anchor_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const SUPERSEDED_PROVIDER_SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS superseded_provider_sessions (
    provider_session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    -- The transcript the session left behind. Recorded because the session row
    -- stops pointing at it, and "delete this conversation from disk" has to
    -- reach every file the conversation ever lived in.
    jsonl_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (provider_session_id, provider)
);
`;

/**
 * 팀 룸. 한 대화에 여러 모델 세션이 참가해 같이 일하는 자리다.
 *
 * 참가자의 대화 기록은 각 프로바이더의 파일(Claude `.jsonl` 등)에 따로 남고,
 * 거기에는 다른 모델의 발언을 끼워 넣을 수 없다. 그래서 룸 타임라인은
 * `room_messages` 에 따로 둔다.
 *
 * `host_session_id` 는 룸으로 바뀐 원래 대화다. 그 세션이 지워지면 룸도 같이
 * 사라진다.
 */
export const ROOMS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    host_session_id TEXT NOT NULL UNIQUE,
    project_path TEXT NOT NULL,
    -- ask | read | full. 텔레그램 턴과 같은 뜻이다.
    permission_mode TEXT NOT NULL DEFAULT 'ask',
    -- 사용자 메시지 하나에 참가자끼리 자동으로 주고받는 최대 턴 수.
    max_auto_turns INTEGER NOT NULL DEFAULT 6,
    -- 1 이면 리더가 일을 나눠 맡기고, 맡은 참가자들이 동시에 일한다.
    split_work INTEGER NOT NULL DEFAULT 1,
    -- 1 이면 한 참가자의 답마다 나머지가 짧게 의견을 낸다.
    discussion INTEGER NOT NULL DEFAULT 1,
    -- 1 이면 방장(호스트)이 부른 참가자만 답하고, 답이 끝나면 방장에게 돌아간다.
    host_led INTEGER NOT NULL DEFAULT 1,
    -- 1 이면 참가자 세션의 맥락이 많이 차면 그 차례 전에 스스로 줄인다.
    auto_compact INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (host_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`;

export const ROOM_PARTICIPANTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS room_participants (
    participant_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    -- 아직 한 번도 불리지 않은 명단 멤버는 NULL 이다. 처음 불릴 때 세션이 생긴다.
    session_id TEXT,
    provider TEXT NOT NULL,
    model TEXT,
    display_name TEXT NOT NULL,
    role_name TEXT NOT NULL,
    role_prompt TEXT NOT NULL DEFAULT '',
    -- 말투와 태도. 역할(무엇을 하는가)과 따로 둔다.
    persona TEXT NOT NULL DEFAULT '',
    -- 1 이면 역할이 바뀐 뒤 아직 본인에게 알리지 않았다는 뜻. 다음 차례에 역할
    -- 안내를 다시 보내고 0 으로 되돌린다.
    role_dirty INTEGER NOT NULL DEFAULT 0,
    -- active | standby. 대기 중인 멤버는 차례도 의견도 받지 않고, 불리면 돌아온다.
    status TEXT NOT NULL DEFAULT 'active',
    position INTEGER NOT NULL,
    -- 이 참가자가 마지막으로 읽은 룸 메시지. 다음 차례에는 그 뒤의 것만 보낸다.
    last_seen_message_id INTEGER NOT NULL DEFAULT 0,
    -- ask | read | full. NULL 이면 룸의 permission_mode 를 따른다.
    permission_mode TEXT,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    -- 퇴장한 시각. 행은 남겨 두어 타임라인의 지난 발언이 누구 것인지 보이게 한다.
    left_at DATETIME,
    UNIQUE (room_id, display_name),
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`;

export const ROOM_MESSAGES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS room_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    -- 'user' 또는 participant_id
    speaker TEXT NOT NULL,
    text TEXT NOT NULL,
    -- complete | aborted | error
    status TEXT NOT NULL DEFAULT 'complete',
    -- 이 답을 낸 참가자 세션. 사용자 메시지는 NULL.
    session_id TEXT,
    -- 사용자가 함께 올린 첨부 파일 설명(JSON 배열). 없으면 NULL.
    attachments TEXT,
    -- 참가자 답의 마지막 말(결론). text 는 작업 중에 남긴 말까지 다 이은 것이다.
    final_text TEXT,
    -- 답이 남긴 넘김 표시: done | pass | mention:<participant_id>. 없으면 NULL.
    handoff TEXT,
    -- 답의 종류: reply | plan | task | comment | summary. 사용자 글과 예전 행은 NULL.
    turn_kind TEXT,
    -- 맡은 일({"text","canEdit"} JSON). task 답에만 있다.
    task TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);
`;

/** 룸 표에 붙는 색인. 처음 만들 때와 기존 설치를 올릴 때 같이 쓴다. */
export const ROOM_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_room_participants_room ON room_participants(room_id, position);
CREATE INDEX IF NOT EXISTS idx_room_participants_session ON room_participants(session_id);
CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id, id);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${API_KEYS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel);
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

${PROVIDER_MODELS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_provider_models_provider_order
ON provider_models(provider, sort_order, id);

${USER_PREFERENCES_TABLE_SCHEMA_SQL}

${SESSION_DRAFTS_TABLE_SCHEMA_SQL}

${MESSAGE_SOURCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_message_sources_session ON message_sources(session_id);

${SUPERSEDED_PROVIDER_SESSIONS_TABLE_SCHEMA_SQL}

${ROOMS_TABLE_SCHEMA_SQL}
${ROOM_PARTICIPANTS_TABLE_SCHEMA_SQL}
${ROOM_MESSAGES_TABLE_SCHEMA_SQL}
${ROOM_INDEXES_SQL}
`;
