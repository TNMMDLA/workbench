-- =====================================================
-- 迁移 001：日历聚合 / 文件暂存 / 通知中心 / 设置
-- 原则：只新增，不改动现有表。时间统一存 UTC。
-- =====================================================

-- 1. 日历来源（URL 订阅 / 上传的 ICS 文件）
CREATE TABLE IF NOT EXISTS calendar_sources (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'url',      -- url | file
    url             TEXT DEFAULT '',
    color           TEXT DEFAULT '#6366f1',
    enabled         INTEGER DEFAULT 1,
    sync_interval   INTEGER DEFAULT 30,               -- 分钟
    last_synced_at  TEXT,
    last_sync_status TEXT DEFAULT '',                 -- ok | error
    last_sync_error TEXT DEFAULT '',
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 2. 日历事件（本地事件 is_local=1；外部事件由同步写入）
CREATE TABLE IF NOT EXISTS calendar_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER DEFAULT 0,                    -- 0 = 本地
    external_uid TEXT DEFAULT '',                     -- ICS UID
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    location    TEXT DEFAULT '',
    start_at    TEXT,                                 -- UTC ISO
    end_at      TEXT,
    all_day     INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'confirmed',             -- confirmed | cancelled
    original_url TEXT DEFAULT '',
    is_local    INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 3. 日历提醒（提醒时间到后生成通知）
CREATE TABLE IF NOT EXISTS calendar_reminders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER NOT NULL,
    remind_at       TEXT NOT NULL,                    -- UTC
    status          TEXT DEFAULT 'pending',           -- pending | sent
    notification_id INTEGER,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 4. 暂存文件（磁盘存随机名，原始名只存数据库）
CREATE TABLE IF NOT EXISTS stored_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    storage_name    TEXT NOT NULL,                    -- 磁盘随机文件名
    original_name   TEXT NOT NULL,
    mime_type       TEXT DEFAULT '',
    size            INTEGER DEFAULT 0,
    path            TEXT NOT NULL,                    -- 相对上传目录的路径
    note            TEXT DEFAULT '',
    tags            TEXT DEFAULT '',                  -- 逗号分隔
    expires_at      TEXT,
    download_count  INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'active',            -- active | expired | deleted
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 5. 临时分享链接（只存令牌哈希）
CREATE TABLE IF NOT EXISTS file_share_tokens (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id         INTEGER NOT NULL,
    token_hash      TEXT NOT NULL,                    -- SHA-256(token)
    expires_at      TEXT,
    max_downloads   INTEGER DEFAULT -1,               -- -1 = 不限
    download_count  INTEGER DEFAULT 0,
    revoked_at      TEXT,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 6. 通知中心
CREATE TABLE IF NOT EXISTS notifications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT NOT NULL,
    content         TEXT DEFAULT '',
    source          TEXT DEFAULT 'system',            -- calendar|files|system|pwa
    level           TEXT DEFAULT 'info',              -- info|success|warning|error
    related_type    TEXT DEFAULT '',
    related_id      INTEGER,
    action_url      TEXT DEFAULT '',
    is_read         INTEGER DEFAULT 0,
    deduplication_key TEXT DEFAULT '',
    repeat_count    INTEGER DEFAULT 1,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    read_at         TEXT
);

-- 7. 后台任务记录
CREATE TABLE IF NOT EXISTS background_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name        TEXT NOT NULL,
    started_at      TEXT,
    finished_at     TEXT,
    status          TEXT DEFAULT 'running',           -- running|ok|error
    processed_count INTEGER DEFAULT 0,
    error_message   TEXT DEFAULT '',
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 8. 应用设置（key-value）
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT DEFAULT '',
    updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ================= 索引 =================
CREATE INDEX IF NOT EXISTS idx_events_start ON calendar_events(start_at);
CREATE INDEX IF NOT EXISTS idx_events_source_uid ON calendar_events(source_id, external_uid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique_ext ON calendar_events(source_id, external_uid) WHERE external_uid != '';
CREATE INDEX IF NOT EXISTS idx_reminders_at ON calendar_reminders(remind_at);
CREATE INDEX IF NOT EXISTS idx_files_expires ON stored_files(expires_at);
CREATE INDEX IF NOT EXISTS idx_files_status ON stored_files(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_hash ON file_share_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notif_dedup ON notifications(deduplication_key);
CREATE INDEX IF NOT EXISTS idx_jobs_name_status ON background_jobs(job_name, status);
