-- =====================================================
-- 迁移 003：修正外部事件唯一索引
-- 循环事件（RRULE）的多个实例共享同一 UID，因此唯一键
-- 必须包含 start_at（实例时间），否则同一循环的后续
-- 实例会违反唯一约束。
-- =====================================================

DROP INDEX IF EXISTS idx_events_unique_ext;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique_ext
    ON calendar_events(source_id, external_uid, start_at)
    WHERE external_uid != '';
