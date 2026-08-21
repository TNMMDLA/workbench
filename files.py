# -*- coding: utf-8 -*-
"""文件暂存模块

功能：
- 上传（大小/空文件/文件名/路径穿越/存储空间校验，随机磁盘名）
- 列表 / 编辑备注标签 / 删除 / 批量删除
- 私有下载（存在性/过期检查、安全响应头、记录次数）
- 临时分享链接（密码学令牌、只存哈希、有效期/次数限制、撤销）
- 过期清理（磁盘+记录+分享+通知）
- 存储统计
"""

import hashlib
import os
import re
import secrets
import shutil
import sqlite3
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from flask import jsonify, send_file

# ---------- 配置（环境变量可覆盖） ----------
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "500"))     # 单文件最大 500MB
STORAGE_LIMIT_MB = int(os.environ.get("STORAGE_LIMIT_MB", "5000"))  # 总存储上限 5GB
WARN_RATIO = 0.8                                              # 用量 80% 警告
MAX_FILENAME_LEN = 200

# 过期选项（小时）
EXPIRE_OPTIONS = {"1h": 1, "1d": 24, "7d": 24 * 7, "30d": 24 * 30}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads", "files")
DB_PATH = os.path.join(BASE_DIR, "data.db")

# 非法文件名模式（路径穿越等）
UNSAFE_NAME = re.compile(r"[/\\\x00-\x1f]|\.\.$|^\.\.")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def now_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure_dir():
    os.makedirs(UPLOAD_DIR, exist_ok=True)


def storage_usage_mb():
    conn = get_conn()
    row = conn.execute(
        "SELECT COALESCE(SUM(size), 0) AS s FROM stored_files WHERE status = 'active'"
    ).fetchone()
    conn.close()
    return row["s"] / (1024 * 1024)


def validate_filename(name):
    """校验文件名，返回错误信息或 None"""
    if not name:
        return "文件名不能为空"
    if len(name) > MAX_FILENAME_LEN:
        return "文件名过长（超过 200 字符）"
    if UNSAFE_NAME.search(name):
        return "文件名包含非法字符"
    if os.path.basename(name) != name:
        return "文件名包含路径，已拒绝"
    return None


def safe_disposition(original_name):
    """生成安全的 Content-Disposition（RFC 5987）"""
    return f"attachment; filename*=UTF-8''{quote(original_name)}"


# ---------- 上传 ----------
def save_upload(file_storage, note="", tags="", expire="never"):
    """保存一个上传文件，返回 (error, record)"""
    ensure_dir()

    # 空文件
    if not file_storage or not file_storage.filename:
        return "请选择文件", None

    original = file_storage.filename
    err = validate_filename(original)
    if err:
        return err, None

    # 大小限制
    max_bytes = MAX_UPLOAD_MB * 1024 * 1024
    # 流式读取并限制
    content = file_storage.read(max_bytes + 1)
    if len(content) == 0:
        return "文件内容为空", None
    if len(content) > max_bytes:
        return f"文件超过大小限制（{MAX_UPLOAD_MB}MB）", None

    # 存储空间检查
    new_size_mb = len(content) / (1024 * 1024)
    used = storage_usage_mb()
    if used + new_size_mb > STORAGE_LIMIT_MB:
        return f"存储空间不足（已用 {used:.0f}MB / 上限 {STORAGE_LIMIT_MB}MB）", None

    # 随机磁盘名（保留扩展名）
    ext = os.path.splitext(original)[1][:10]
    storage = secrets.token_hex(16) + ext
    full = os.path.join(UPLOAD_DIR, storage)
    with open(full, "wb") as f:
        f.write(content)

    # 过期时间
    expires_at = None
    if expire in EXPIRE_OPTIONS:
        hours = EXPIRE_OPTIONS[expire]
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")

    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO stored_files
           (storage_name, original_name, mime_type, size, path, note, tags, expires_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')""",
        (storage, original, (file_storage.mimetype or "application/octet-stream"),
         len(content), storage, (note or "").strip(), (tags or "").strip(), expires_at),
    )
    conn.commit()
    rec = conn.execute("SELECT * FROM stored_files WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return None, dict(rec)


# ---------- 下载 ----------
def download_file(file_id, count=True):
    """私有下载：检查存在性/过期，返回 (error, response)"""
    conn = get_conn()
    rec = conn.execute("SELECT * FROM stored_files WHERE id = ?", (file_id,)).fetchone()
    if not rec:
        conn.close()
        return "文件不存在", None
    if rec["status"] != "active":
        conn.close()
        return "文件已不可用", None
    if rec["expires_at"] and rec["expires_at"] < now_utc():
        conn.execute("UPDATE stored_files SET status = 'expired' WHERE id = ?", (file_id,))
        conn.commit()
        conn.close()
        return "文件已过期", None

    full = os.path.join(UPLOAD_DIR, rec["storage_name"])
    if not os.path.isfile(full):
        conn.close()
        return "文件在服务器上已丢失", None

    if count:
        conn.execute("UPDATE stored_files SET download_count = download_count + 1 WHERE id = ?", (file_id,))
        conn.commit()
    conn.close()

    resp = send_file(full, as_attachment=True, download_name=rec["original_name"])
    return None, resp


# ---------- 分享令牌 ----------
def create_share(file_id, hours=24, max_downloads=-1):
    """创建分享链接，返回完整 URL 或错误"""
    conn = get_conn()
    rec = conn.execute("SELECT * FROM stored_files WHERE id = ? AND status = 'active'", (file_id,)).fetchone()
    if not rec:
        conn.close()
        return "文件不存在或不可用", None

    token = secrets.token_urlsafe(32)          # 密码学安全随机数
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")

    conn.execute(
        """INSERT INTO file_share_tokens (file_id, token_hash, expires_at, max_downloads, download_count)
           VALUES (?, ?, ?, ?, 0)""",
        (file_id, token_hash, expires_at, int(max_downloads)),
    )
    conn.commit()
    conn.close()
    return None, token


def get_share_info(token):
    """按令牌查分享记录（不含哈希细节）"""
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    conn = get_conn()
    row = conn.execute(
        """SELECT t.id, t.file_id, t.expires_at, t.max_downloads, t.download_count,
                  t.revoked_at, t.created_at, f.original_name, f.status AS file_status
           FROM file_share_tokens t JOIN stored_files f ON f.id = t.file_id
           WHERE t.token_hash = ?""",
        (token_hash,),
    ).fetchone()
    conn.close()
    return row


def download_share(token):
    """通过分享令牌下载"""
    row = get_share_info(token)
    if not row:
        return "分享链接无效", None
    if row["revoked_at"]:
        return "分享链接已撤销", None
    if row["expires_at"] and row["expires_at"] < now_utc():
        return "分享链接已过期", None
    if row["max_downloads"] >= 0 and row["download_count"] >= row["max_downloads"]:
        return "分享链接已达下载次数上限", None

    err, resp = download_file(row["file_id"], count=True)
    if err:
        return err, None

    # 记录分享下载次数
    conn = get_conn()
    conn.execute("UPDATE file_share_tokens SET download_count = download_count + 1 WHERE id = ?", (row["id"],))
    conn.commit()
    conn.close()
    return None, resp


def revoke_share(token):
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    conn = get_conn()
    conn.execute("UPDATE file_share_tokens SET revoked_at = ? WHERE token_hash = ?", (now_utc(), token_hash))
    conn.commit()
    conn.close()
    return True


def list_shares(file_id):
    """列出某个文件的全部分享记录（元数据，不含令牌本身）"""
    conn = get_conn()
    rows = conn.execute(
        """SELECT id, file_id, expires_at, max_downloads, download_count,
                  revoked_at, created_at
           FROM file_share_tokens WHERE file_id = ? ORDER BY id DESC""",
        (file_id,),
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["status"] = "revoked" if d["revoked_at"] else (
            "expired" if d["expires_at"] and d["expires_at"] < now_utc() else (
                "exhausted" if d["max_downloads"] >= 0 and d["download_count"] >= d["max_downloads"] else "active"
            )
        )
        result.append(d)
    return result


def revoke_share_by_id(share_id):
    """管理端按记录 id 撤销分享"""
    conn = get_conn()
    conn.execute("UPDATE file_share_tokens SET revoked_at = ? WHERE id = ?", (now_utc(), share_id))
    conn.commit()
    conn.close()
    return True


# ---------- 过期清理 ----------
def cleanup_expired():
    """清理过期文件/分享/通知；返回处理统计"""
    ensure_dir()
    conn = get_conn()
    stats = {"files": 0, "shares": 0, "notifications": 0, "failed": 0}

    # 1. 过期文件
    expired = conn.execute(
        "SELECT * FROM stored_files WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?",
        (now_utc(),),
    ).fetchall()
    for f in expired:
        full = os.path.join(UPLOAD_DIR, f["storage_name"])
        try:
            if os.path.isfile(full):
                os.remove(full)
            conn.execute("UPDATE stored_files SET status = 'expired' WHERE id = ?", (f["id"],))
            conn.execute("DELETE FROM file_share_tokens WHERE file_id = ?", (f["id"],))
            # 通知（去重）
            conn.execute(
                """INSERT INTO notifications (title, content, source, level, related_type, related_id, deduplication_key)
                   SELECT '文件已过期清理', ?, 'files', 'info', 'file', ?, ?
                   WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE deduplication_key = ?)""",
                (f"「{f['original_name']}」已超过保留期，已自动删除",
                 f["id"], f"file-expired-{f['id']}", f"file-expired-{f['id']}"),
            )
            stats["files"] += 1
        except OSError as e:
            conn.execute(
                """INSERT INTO notifications (title, content, source, level, related_type, related_id, deduplication_key)
                   SELECT '文件清理失败', ?, 'files', 'error', 'file', ?, ?
                   WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE deduplication_key = ?)""",
                (f"「{f['original_name']}」清理失败：{str(e)[:150]}",
                 f["id"], f"file-clean-fail-{f['id']}", f"file-clean-fail-{f['id']}"),
            )
            stats["failed"] += 1

    # 2. 过期分享
    expired_shares = conn.execute(
        "SELECT id FROM file_share_tokens WHERE revoked_at IS NULL AND expires_at < ?",
        (now_utc(),),
    ).fetchall()
    for s in expired_shares:
        conn.execute("DELETE FROM file_share_tokens WHERE id = ?", (s["id"],))
        stats["shares"] += 1

    # 3. 过期通知（默认保留 90 天）
    conn.execute("DELETE FROM notifications WHERE created_at < datetime('now', '-90 days')")
    stats["notifications"] = conn.total_changes

    conn.commit()
    conn.close()
    return stats


# ---------- 统计 ----------
def storage_stats():
    ensure_dir()
    conn = get_conn()
    total = conn.execute("SELECT COUNT(*) AS c FROM stored_files WHERE status = 'active'").fetchone()["c"]
    used = conn.execute("SELECT COALESCE(SUM(size), 0) AS s FROM stored_files WHERE status = 'active'").fetchone()["s"]
    expiring = conn.execute(
        "SELECT COUNT(*) AS c FROM stored_files WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < datetime('now', '+7 days')"
    ).fetchone()["c"]
    failed = conn.execute(
        "SELECT COUNT(*) AS c FROM notifications WHERE source = 'files' AND level = 'error' AND is_read = 0"
    ).fetchone()["c"]
    conn.close()
    return {
        "file_count": total,
        "used_mb": round(used / (1024 * 1024), 1),
        "limit_mb": STORAGE_LIMIT_MB,
        "free_mb": round(STORAGE_LIMIT_MB - used / (1024 * 1024), 1),
        "expiring_count": expiring,
        "clean_failed_count": failed,
    }
