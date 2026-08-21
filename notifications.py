# -*- coding: utf-8 -*-
"""通知中心模块

功能：
- 统一 add()：添加通知，支持去重合并（1 小时内同 key → 重复次数+1）
- 已读/未读、删除、全部已读、清空已读
- 过期清理（默认保留 90 天）
- 等级：info / success / warning / error
"""

import os
import sqlite3
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data.db")
RETENTION_DAYS = 90           # 默认保留 90 天（设置页可改）
DEDUP_WINDOW_HOURS = 1        # 去重合并窗口：1 小时内同 key 合并


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def now_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def add(title, content="", source="system", level="info",
        related_type="", related_id=None, action_url="", dedup_key=""):
    """添加通知；相同 dedup_key 在窗口内重复时合并（repeat_count+1）"""
    conn = get_conn()
    if dedup_key:
        row = conn.execute(
            """SELECT id, repeat_count FROM notifications
               WHERE deduplication_key = ? AND created_at > datetime('now', ?)""",
            (dedup_key, f"-{DEDUP_WINDOW_HOURS} hours"),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE notifications SET repeat_count = repeat_count + 1, is_read = 0, read_at = NULL WHERE id = ?",
                (row["id"],),
            )
            conn.commit()
            conn.close()
            return row["id"]
    cur = conn.execute(
        """INSERT INTO notifications
           (title, content, source, level, related_type, related_id, action_url, deduplication_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (title, content, source, level, related_type, related_id, action_url, dedup_key),
    )
    conn.commit()
    nid = cur.lastrowid
    conn.close()
    return nid


def list_notifications(unread_only=False, source="", level="", limit=100):
    conn = get_conn()
    q = "SELECT * FROM notifications WHERE 1=1"
    args = []
    if unread_only:
        q += " AND is_read = 0"
    if source:
        q += " AND source = ?"
        args.append(source)
    if level:
        q += " AND level = ?"
        args.append(level)
    q += " ORDER BY id DESC LIMIT ?"
    args.append(min(limit, 200))
    rows = conn.execute(q, args).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_read(nid, read=True):
    conn = get_conn()
    if read:
        conn.execute("UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ?", (now_utc(), nid))
    else:
        conn.execute("UPDATE notifications SET is_read = 0, read_at = NULL WHERE id = ?", (nid,))
    conn.commit()
    conn.close()


def read_all():
    conn = get_conn()
    conn.execute("UPDATE notifications SET is_read = 1, read_at = ? WHERE is_read = 0", (now_utc(),))
    conn.commit()
    conn.close()


def delete_one(nid):
    conn = get_conn()
    conn.execute("DELETE FROM notifications WHERE id = ?", (nid,))
    conn.commit()
    conn.close()


def clear_read():
    """清空已读通知"""
    conn = get_conn()
    conn.execute("DELETE FROM notifications WHERE is_read = 1")
    conn.commit()
    conn.close()


def cleanup_expired():
    """清理超过保留天数的通知"""
    conn = get_conn()
    n = conn.execute(
        "DELETE FROM notifications WHERE created_at < datetime('now', ?)",
        (f"-{RETENTION_DAYS} days",),
    ).rowcount
    conn.commit()
    conn.close()
    return n


def unread_count():
    conn = get_conn()
    c = conn.execute("SELECT COUNT(*) AS c FROM notifications WHERE is_read = 0").fetchone()["c"]
    conn.close()
    return c
