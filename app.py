"""AQ 的工作台 · 后端

功能模块：
- 待办清单（一次性任务）
- 灵感便签
- 每日习惯 + 打卡记录（长期任务，按天打卡）
- 灵感导图（XMind 式思维导图）

启动方式：python app.py
然后浏览器打开 http://localhost:5000
"""

from flask import Flask, request, jsonify, render_template, send_file
import json
import sqlite3
import os
from datetime import date, datetime, timedelta

import ics  # ICS 日历同步模块（SSRF 防护/解析/同步）
import files  # 文件暂存模块（上传/下载/分享/清理）
import notifications  # 通知中心模块（增删改查/去重合并）

app = Flask(__name__)
DB = "data.db"  # 数据库文件，所有数据都存在这个文件里


# ---------- 数据库工具 ----------
def get_db():
    """连接数据库（文件不存在会自动创建）"""
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """第一次运行时创建数据表"""
    conn = get_db()

    # 一次性清理：快捷入口已不再使用
    conn.execute("DROP TABLE IF EXISTS links")

    # 待办清单表：id、内容、是否完成、创建时间
    conn.execute(
        """CREATE TABLE IF NOT EXISTS todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            done INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )"""
    )

    # 记事本表：只有一行（id=1）
    conn.execute(
        """CREATE TABLE IF NOT EXISTS note (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            content TEXT DEFAULT ''
        )"""
    )
    conn.execute("INSERT OR IGNORE INTO note (id, content) VALUES (1, '')")

    # 每日习惯表：name 名字、emoji 图标
    conn.execute(
        """CREATE TABLE IF NOT EXISTS habits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            emoji TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
        )"""
    )

    # 打卡记录表：哪个习惯、哪天打了卡（同一天同一习惯只能一条）
    conn.execute(
        """CREATE TABLE IF NOT EXISTS habit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            habit_id INTEGER NOT NULL,
            log_date TEXT NOT NULL,
            UNIQUE(habit_id, log_date)
        )"""
    )

    # 灵感导图节点表：parent_id=0 表示根节点，text 是节点文字
    conn.execute(
        """CREATE TABLE IF NOT EXISTS mind_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id INTEGER DEFAULT 0,
            text TEXT DEFAULT '',
            sort INTEGER DEFAULT 0
        )"""
    )
    # 默认给一个根节点"我的灵感"
    conn.execute(
        "INSERT OR IGNORE INTO mind_nodes (id, parent_id, text, sort) VALUES (1, 0, '我的灵感', 0)"
    )

    conn.commit()
    conn.close()


init_db()


def migrate():
    """给旧数据库补上新列（导图节点的位置/颜色/字号/尺寸/层级）"""
    conn = get_db()
    cols = [r[1] for r in conn.execute("PRAGMA table_info(mind_nodes)").fetchall()]
    if "x" not in cols:
        conn.execute("ALTER TABLE mind_nodes ADD COLUMN x REAL")
    if "y" not in cols:
        conn.execute("ALTER TABLE mind_nodes ADD COLUMN y REAL")
    if "color" not in cols:
        conn.execute("ALTER TABLE mind_nodes ADD COLUMN color TEXT DEFAULT ''")
    if "font_size" not in cols:
        conn.execute("ALTER TABLE mind_nodes ADD COLUMN font_size INTEGER DEFAULT 13")
    if "width" not in cols:
        conn.execute("ALTER TABLE mind_nodes ADD COLUMN width INTEGER DEFAULT 200")
    if "height" not in cols:
        conn.execute("ALTER TABLE mind_nodes ADD COLUMN height INTEGER DEFAULT 90")
    if "z_index" not in cols:
        conn.execute("ALTER TABLE mind_nodes ADD COLUMN z_index INTEGER DEFAULT 0")

    # 待办表补列：完成时间（UTC），用于"次日自动隐藏已完成项"
    tcols = [r[1] for r in conn.execute("PRAGMA table_info(todos)").fetchall()]
    if "completed_at" not in tcols:
        conn.execute("ALTER TABLE todos ADD COLUMN completed_at TEXT")
    if "sort_order" not in tcols:
        conn.execute("ALTER TABLE todos ADD COLUMN sort_order REAL")
        # 旧数据按 id 倒序（新的在前），用 -id 保持当前显示顺序
        conn.execute("UPDATE todos SET sort_order = -id WHERE sort_order IS NULL")
    # 旧数据的完成时间缺失时，用创建时间兜底（归档区可见）
    conn.execute(
        "UPDATE todos SET completed_at = created_at WHERE done = 1 AND completed_at IS NULL"
    )
    conn.commit()
    conn.close()


migrate()


# ---------- 数据保留与归档 ----------
_last_cleanup_key = None

# 可配置保留期：key → (默认值, 最小值, 最大值)
RETENTION_KEYS = {
    "done_retention_months": (2, 1, 24),          # 已完成任务保留月数
    "habit_log_retention_months": (6, 1, 120),    # 打卡记录保留月数
    "notification_retention_months": (3, 1, 120), # 通知保留月数
}


def _get_setting_int(key, default, lo=1, hi=120):
    """读取 app_settings 里的整数设置（带范围校验）"""
    conn = get_db()
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    try:
        val = int(row["value"]) if row and row["value"] else default
    except (TypeError, ValueError):
        val = default
    return val if lo <= val <= hi else default


def _retention_months():
    return _get_setting_int("done_retention_months", 2, 1, 24)


def _months_ago_start(now, months):
    """n 个月前那个月的 1 号 00:00:00（YYYY-MM-DD HH:MM:SS）"""
    y, m = now.year, now.month - months
    while m <= 0:
        m += 12
        y -= 1
    return datetime(y, m, 1, 0, 0, 0).strftime("%Y-%m-%d %H:%M:%S")


def _months_ago_iso(now, months):
    """n 个月前那个月的 1 号 00:00:00（UTC ISO 格式，用于 notifications/background_jobs）"""
    y, m = now.year, now.month - months
    while m <= 0:
        m += 12
        y -= 1
    return datetime(y, m, 1, 0, 0, 0).strftime("%Y-%m-%dT%H:%M:%SZ")


def _done_todos(cutoff):
    """保留期内的已完成任务（供日历叠加显示）"""
    conn = get_db()
    rows = conn.execute(
        "SELECT id, text, done, completed_at FROM todos "
        "WHERE done = 1 AND COALESCE(completed_at, created_at) >= ? "
        "ORDER BY COALESCE(completed_at, created_at) DESC",
        (cutoff,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _next_todo_sort(conn):
    """新待办排在最前：取当前最小 sort_order 再减 1"""
    row = conn.execute("SELECT COALESCE(MIN(sort_order), 0) FROM todos").fetchone()
    return row[0] - 1


def monthly_cleanup():
    """月度归档（每次 /api/data 跨月才执行）：
    - 已完成任务：超过保留期（默认 2 个月，可设置）→ 删除
    - 未完成任务：每月自动顺延到下个月
    - 打卡记录：超过保留期（默认 6 个月，可设置）→ 删除
    - 通知：超过保留期（默认 3 个月，可设置）→ 删除
    - 后台任务日志：超过 30 天 → 删除（内部自动）"""
    global _last_cleanup_key
    now = datetime.now()
    key = (now.year, now.month)
    if _last_cleanup_key == key:
        return
    _last_cleanup_key = key
    months = _retention_months()
    cutoff = _months_ago_start(now, months)
    month_start = now.replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    ).strftime("%Y-%m-%d %H:%M:%S")
    logs_cutoff = _months_ago_start(now, _get_setting_int("habit_log_retention_months", 6, 1, 120))[:10]
    notif_cutoff = _months_ago_iso(now, _get_setting_int("notification_retention_months", 3, 1, 120))
    jobs_cutoff = _months_ago_iso(now, 1)
    conn = get_db()
    # 已完成的旧任务：超过保留期才删除
    done_cur = conn.execute(
        "DELETE FROM todos WHERE done = 1 AND COALESCE(completed_at, created_at) < ?",
        (cutoff,),
    )
    # 未完成的旧任务：顺延到下个月（created_at 改成当月 1 号，留在列表里）
    todo_cur = conn.execute(
        "UPDATE todos SET created_at = ? WHERE created_at < ? AND done = 0",
        (month_start, month_start),
    )
    # 打卡记录：超过保留期删除
    logs_cur = conn.execute("DELETE FROM habit_logs WHERE log_date < ?", (logs_cutoff,))
    # 通知：超过保留期删除
    notif_cur = conn.execute(
        "DELETE FROM notifications WHERE created_at < ?", (notif_cutoff,)
    )
    # 后台任务日志：超过 30 天删除
    jobs_cur = conn.execute(
        "DELETE FROM background_jobs WHERE created_at < ?", (jobs_cutoff,)
    )
    conn.commit()
    conn.close()
    total = done_cur.rowcount + todo_cur.rowcount + logs_cur.rowcount + notif_cur.rowcount + jobs_cur.rowcount
    if total:
        print(
            f"[cleanup] 清理: 已完成{done_cur.rowcount} 顺延{todo_cur.rowcount} "
            f"打卡{logs_cur.rowcount} 通知{notif_cur.rowcount} 后台日志{jobs_cur.rowcount}"
        )


def run_migrations():
    """执行 migrations/ 目录下所有未应用的 .sql 迁移文件"""
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "migrations")
    if not os.path.isdir(base):
        return
    conn = get_db()
    # 记录已执行的迁移
    conn.execute(
        """CREATE TABLE IF NOT EXISTS schema_migrations (
            filename TEXT PRIMARY KEY,
            applied_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        )"""
    )
    applied = {r[0] for r in conn.execute("SELECT filename FROM schema_migrations").fetchall()}
    for fname in sorted(os.listdir(base)):
        if not fname.endswith(".sql") or fname in applied:
            continue
        path = os.path.join(base, fname)
        with open(path, "r", encoding="utf-8") as f:
            script = f.read()
        conn.executescript(script)
        conn.execute("INSERT INTO schema_migrations (filename) VALUES (?)", (fname,))
        print(f"[migrate] applied {fname}")
    conn.commit()
    conn.close()


run_migrations()


# ---------- 页面 ----------
@app.route("/")
def index():
    return render_template("index.html")


# ---------- 数据总接口 ----------
@app.route("/api/data")
def api_data():
    """一次性返回：待办 + 便签 + 习惯 + 打卡记录 + 导图节点"""
    monthly_cleanup()  # 跨月时自动清理上月数据
    conn = get_db()
    todos = conn.execute("SELECT * FROM todos ORDER BY sort_order ASC, id ASC").fetchall()
    note = conn.execute("SELECT content FROM note WHERE id = 1").fetchone()
    habits = conn.execute("SELECT * FROM habits ORDER BY id").fetchall()
    logs = conn.execute("SELECT habit_id, log_date FROM habit_logs").fetchall()
    mind = conn.execute("SELECT * FROM mind_nodes ORDER BY sort, id").fetchall()
    conn.close()
    return jsonify(
        {
            "todos": [dict(t) for t in todos],
            "note": note["content"] if note else "",
            "habits": [dict(h) for h in habits],
            "logs": [{"habit_id": l["habit_id"], "date": l["log_date"]} for l in logs],
            "mind": [dict(m) for m in mind],
        }
    )


@app.route("/api/overview")
def api_overview():
    """首页概览卡数据（今日日程/最近文件/未读通知）"""
    # 先处理到期提醒（懒检查，无需后台任务）
    process_due_reminders()

    conn = get_db()
    # 今日事件：Asia/Shanghai 今天 00:00~24:00 的 UTC 范围
    from datetime import datetime, timedelta, timezone
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("Asia/Shanghai")
    local_now = datetime.now(tz)
    day_start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1)
    start_utc = day_start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    end_utc = day_end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    today_rows = conn.execute(
        "SELECT * FROM calendar_events WHERE is_local=1 AND start_at >= ? AND start_at < ? ORDER BY start_at",
        (start_utc, end_utc),
    ).fetchall()

    # 最近文件
    recent = conn.execute(
        "SELECT id, original_name, size FROM stored_files WHERE status = 'active' ORDER BY id DESC LIMIT 3"
    ).fetchall()
    recent_files = [{"id": r["id"], "name": r["original_name"], "size": r["size"]} for r in recent]

    # 未读通知
    unread = conn.execute(
        "SELECT COUNT(*) AS c FROM notifications WHERE is_read = 0"
    ).fetchone()["c"]

    conn.close()

    return jsonify({
        "today_events": [
            {"id": e["id"], "title": e["title"], "start_at": e["start_at"],
             "end_at": e["end_at"], "all_day": e["all_day"], "color": e["color"]}
            for e in today_rows
        ],
        "recent_files": recent_files,
        "unread_notifications": unread,
    })


# ---------- 日历（本地事件） ----------
def utc_now_str():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def set_reminder(conn, event_id, start_at, remind):
    """根据提醒选项计算提醒时间并写入 calendar_reminders"""
    conn.execute("DELETE FROM calendar_reminders WHERE event_id = ?", (event_id,))
    if not remind or remind == "none":
        conn.commit()
        return
    from datetime import datetime, timedelta
    try:
        start = datetime.fromisoformat(start_at.replace("Z", "+00:00"))
    except ValueError:
        conn.commit()
        return
    offset = {
        "start": timedelta(0),
        "10m": timedelta(minutes=10),
        "30m": timedelta(minutes=30),
        "1h": timedelta(hours=1),
        "1d": timedelta(days=1),
    }.get(remind)
    if offset is None:
        conn.commit()
        return
    remind_at = (start - offset).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn.execute(
        "INSERT INTO calendar_reminders (event_id, remind_at) VALUES (?, ?)",
        (event_id, remind_at),
    )
    conn.commit()


def process_due_reminders():
    """懒检查：所有到期的待发送提醒 → 生成通知并标记已发送"""
    conn = get_db()
    due = conn.execute(
        """SELECT r.id, r.event_id, e.title FROM calendar_reminders r
           JOIN calendar_events e ON e.id = r.event_id
           WHERE r.status = 'pending' AND r.remind_at <= ?""",
        (utc_now_str(),),
    ).fetchall()
    for r in due:
        conn.execute(
            """INSERT INTO notifications (title, content, source, level, related_type, related_id, action_url, deduplication_key)
               VALUES (?, ?, 'calendar', 'info', 'calendar', ?, '#/calendar', ?)""",
            ("日历提醒", f"事件「{r['title']}」即将开始", r["event_id"], f"reminder-{r['event_id']}"),
        )
        conn.execute("UPDATE calendar_reminders SET status = 'sent' WHERE id = ?", (r["id"],))
    conn.commit()
    conn.close()
    return len(due)


def maybe_auto_sync():
    """懒检查：到期未同步的日历源自动同步（默认 30 分钟一次）"""
    conn = get_db()
    rows = conn.execute(
        """SELECT id FROM calendar_sources
           WHERE enabled = 1 AND (last_synced_at IS NULL
               OR last_synced_at < datetime('now', '-30 minutes'))"""
    ).fetchall()
    conn.close()
    for r in rows:
        try:
            sync_one_source(r["id"])
        except Exception:
            pass  # 失败已在 sync_one_source 中记录


def sync_one_source(sid):
    """同步单个日历源并记录状态；失败记录错误并生成通知"""
    conn = get_db()
    src = conn.execute("SELECT * FROM calendar_sources WHERE id = ?", (sid,)).fetchone()
    if not src or not src["enabled"]:
        conn.close()
        return 0
    try:
        n = ics.sync_source(conn, src)
        conn.execute(
            "UPDATE calendar_sources SET last_synced_at = ?, last_sync_status = 'ok', last_sync_error = '', updated_at = ? WHERE id = ?",
            (utc_now_str(), utc_now_str(), sid),
        )
        conn.commit()
        conn.close()
        return n
    except Exception as e:
        msg = str(e)[:500]
        conn.execute(
            "UPDATE calendar_sources SET last_synced_at = ?, last_sync_status = 'error', last_sync_error = ? WHERE id = ?",
            (utc_now_str(), msg, sid),
        )
        # 生成失败通知（1 小时内同一来源只生成一条，合并）
        conn.execute(
            """INSERT INTO notifications (title, content, source, level, related_type, related_id, action_url, deduplication_key)
               SELECT '日历同步失败', ?, 'calendar', 'error', 'calendar_source', ?, '#/calendar', ?
               WHERE NOT EXISTS (SELECT 1 FROM notifications
                                 WHERE deduplication_key = ? AND created_at > datetime('now', '-1 hour'))""",
            (f"「{src['name']}」同步失败：{msg[:200]}", sid, f"cal-sync-{sid}", f"cal-sync-{sid}"),
        )
        conn.commit()
        conn.close()
        raise


@app.route("/api/calendar")
def api_calendar():
    """按时间范围取事件（本地 + 外部聚合）：/api/calendar?start=...&end=..."""
    maybe_auto_sync()
    start = request.args.get("start", "")
    end = request.args.get("end", "")
    conn = get_db()
    if start and end:
        rows = conn.execute(
            "SELECT * FROM calendar_events WHERE start_at >= ? AND start_at < ? ORDER BY start_at",
            (start, end),
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM calendar_events ORDER BY start_at").fetchall()
    sources = {s["id"]: s for s in conn.execute("SELECT id, name, color FROM calendar_sources").fetchall()}
    conn.close()

    events = []
    for r in rows:
        ev = dict(r)
        if not ev["is_local"] and ev["source_id"] in sources:
            ev["color"] = sources[ev["source_id"]]["color"]
            ev["source_name"] = sources[ev["source_id"]]["name"]
        events.append(ev)
    # 附带保留期内的已完成任务（日历"已完成"按钮叠加显示）
    cutoff = _months_ago_start(datetime.now(), _retention_months())
    return jsonify({"events": events, "done_todos": _done_todos(cutoff)})


@app.route("/api/settings", methods=["GET"])
def get_settings():
    """读取全部保留期设置"""
    out = {}
    for k, (default, lo, hi) in RETENTION_KEYS.items():
        out[k] = _get_setting_int(k, default, lo, hi)
    return jsonify(out)


@app.route("/api/settings", methods=["PUT"])
def set_settings():
    """保存设置：可只传想改的 key，如 {done_retention_months: 6}"""
    data = request.get_json() or {}
    conn = get_db()
    updated = {}
    for k, (default, lo, hi) in RETENTION_KEYS.items():
        if k not in data:
            continue
        try:
            val = int(data[k])
        except (TypeError, ValueError):
            conn.close()
            return jsonify({"error": f"{k} 必须是数字"}), 400
        if not (lo <= val <= hi):
            conn.close()
            return jsonify({"error": f"{k} 范围 {lo}-{hi}"}), 400
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (k, str(val)),
        )
        updated[k] = val
    conn.commit()
    conn.close()
    return jsonify({"ok": True, **updated})


@app.route("/api/storage")
def api_storage():
    """存储占用统计：数据库 + 上传文件 + 各类数据条数"""
    db_size = os.path.getsize(DB) if os.path.exists(DB) else 0
    uploads_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
    uploads_size = 0
    upload_file_count = 0
    if os.path.isdir(uploads_dir):
        for root, _, files in os.walk(uploads_dir):
            for f in files:
                fp = os.path.join(root, f)
                try:
                    uploads_size += os.path.getsize(fp)
                except OSError:
                    pass
                upload_file_count += 1
    conn = get_db()
    counts = {
        "todos": conn.execute("SELECT COUNT(*) FROM todos").fetchone()[0],
        "habit_logs": conn.execute("SELECT COUNT(*) FROM habit_logs").fetchone()[0],
        "notifications": conn.execute("SELECT COUNT(*) FROM notifications").fetchone()[0],
        "calendar_events": conn.execute("SELECT COUNT(*) FROM calendar_events").fetchone()[0],
        "stored_files": conn.execute("SELECT COUNT(*) FROM stored_files").fetchone()[0],
        "background_jobs": conn.execute("SELECT COUNT(*) FROM background_jobs").fetchone()[0],
    }
    conn.close()
    return jsonify(
        {
            "db_size": db_size,
            "uploads_size": uploads_size,
            "upload_file_count": upload_file_count,
            "total": db_size + uploads_size,
            "counts": counts,
        }
    )


@app.route("/api/calendar/events", methods=["POST"])
def create_event():
    """创建本地事件"""
    data = request.get_json() or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "请填写事件标题"}), 400
    if not data.get("start_at"):
        return jsonify({"error": "请设置开始时间"}), 400

    conn = get_db()
    cur = conn.execute(
        """INSERT INTO calendar_events
           (source_id, title, description, location, start_at, end_at, all_day, color, is_local)
           VALUES (0, ?, ?, ?, ?, ?, ?, ?, 1)""",
        (
            title,
            (data.get("description") or "").strip(),
            (data.get("location") or "").strip(),
            data["start_at"],
            data.get("end_at") or data["start_at"],
            1 if data.get("all_day") else 0,
            data.get("color") or "#6366f1",
        ),
    )
    conn.commit()
    event_id = cur.lastrowid
    set_reminder(conn, event_id, data["start_at"], data.get("remind"))
    conn.close()
    return jsonify({"ok": True, "id": event_id})


@app.route("/api/calendar/events/<int:eid>", methods=["PATCH"])
def update_event(eid):
    """编辑本地事件"""
    data = request.get_json() or {}
    conn = get_db()
    event = conn.execute("SELECT * FROM calendar_events WHERE id = ?", (eid,)).fetchone()
    if not event:
        conn.close()
        return jsonify({"error": "事件不存在"}), 404

    fields = ["title", "description", "location", "start_at", "end_at", "all_day", "color"]
    sets, vals = [], []
    for f in fields:
        if f in data and data[f] is not None:
            sets.append(f"{f} = ?")
            vals.append(1 if f == "all_day" and data[f] else data[f])
    if "title" in data:
        if not (data.get("title") or "").strip():
            conn.close()
            return jsonify({"error": "标题不能为空"}), 400
    if sets:
        vals.append(eid)
        conn.execute(f"UPDATE calendar_events SET {', '.join(sets)} WHERE id = ?", vals)
    conn.commit()

    # 提醒：重新计算（如果传了 remind 或时间变了）
    if "remind" in data or "start_at" in data:
        fresh = conn.execute("SELECT * FROM calendar_events WHERE id = ?", (eid,)).fetchone()
        set_reminder(conn, eid, fresh["start_at"], data.get("remind") or "none" if "remind" in data else data.get("remind"))
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/calendar/events/<int:eid>", methods=["DELETE"])
def delete_event(eid):
    """删除本地事件（连带提醒）"""
    conn = get_db()
    conn.execute("DELETE FROM calendar_reminders WHERE event_id = ?", (eid,))
    conn.execute("DELETE FROM calendar_events WHERE id = ?", (eid,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- 日历来源（ICS 订阅） ----------
@app.route("/api/calendar/sources")
def api_calendar_sources():
    maybe_auto_sync()
    conn = get_db()
    rows = conn.execute("SELECT * FROM calendar_sources ORDER BY id").fetchall()
    conn.close()
    return jsonify({"sources": [dict(r) for r in rows]})


@app.route("/api/calendar/sources", methods=["POST"])
def add_calendar_source():
    """添加 ICS URL 订阅"""
    data = request.get_json() or {}
    url = (data.get("url") or "").strip()
    name = (data.get("name") or "").strip() or url
    if not url:
        return jsonify({"error": "请填写 ICS 订阅地址"}), 400
    # 添加前先做 SSRF 预检
    try:
        ics.check_url(url)
    except ics.ICSError as e:
        return jsonify({"error": str(e)}), 400

    conn = get_db()
    cur = conn.execute(
        "INSERT INTO calendar_sources (name, type, url, color) VALUES (?, 'url', ?, ?)",
        (name, url, data.get("color") or "#6366f1"),
    )
    conn.commit()
    sid = cur.lastrowid
    conn.close()

    # 添加后立即同步一次
    try:
        sync_one_source(sid)
        return jsonify({"ok": True, "id": sid})
    except Exception as e:
        return jsonify({"ok": True, "id": sid, "sync_error": str(e)})


@app.route("/api/calendar/sources/upload", methods=["POST"])
def upload_calendar_source():
    """上传 .ics 文件作为日历来源"""
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "请选择 .ics 文件"}), 400
    if not f.filename.lower().endswith(".ics"):
        return jsonify({"error": "只支持 .ics 文件"}), 400
    content = f.read(ics.MAX_ICS_SIZE + 1)
    if len(content) > ics.MAX_ICS_SIZE:
        return jsonify({"error": "文件超过大小限制（2MB）"}), 400
    # 校验可解析
    try:
        ics.parse_ics(content, 0)
    except ics.ICSError as e:
        return jsonify({"error": str(e)}), 400

    uploads_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads", "ics")
    os.makedirs(uploads_dir, exist_ok=True)
    import uuid as uuidlib
    storage = uuidlib.uuid4().hex + ".ics"
    with open(os.path.join(uploads_dir, storage), "wb") as fp:
        fp.write(content)

    name = (request.form.get("name") or "").strip() or (f.filename or "导入日历")
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO calendar_sources (name, type, url, color) VALUES (?, 'file', ?, ?)",
        (name, storage, request.form.get("color") or "#6366f1"),
    )
    conn.commit()
    sid = cur.lastrowid
    conn.close()
    try:
        sync_one_source(sid)
        return jsonify({"ok": True, "id": sid})
    except Exception as e:
        return jsonify({"ok": True, "id": sid, "sync_error": str(e)})


@app.route("/api/calendar/sources/<int:sid>", methods=["PATCH"])
def update_calendar_source(sid):
    """更新来源：名称/颜色/启用/同步间隔"""
    data = request.get_json() or {}
    conn = get_db()
    sets, vals = [], []
    for f in ("name", "color", "sync_interval"):
        if f in data and data[f] is not None:
            sets.append(f"{f} = ?")
            vals.append(data[f])
    if "enabled" in data:
        sets.append("enabled = ?")
        vals.append(1 if data["enabled"] else 0)
    if sets:
        vals.append(sid)
        conn.execute(f"UPDATE calendar_sources SET {', '.join(sets)} WHERE id = ?", vals)
        conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/calendar/sources/<int:sid>", methods=["DELETE"])
def delete_calendar_source(sid):
    conn = get_db()
    src = conn.execute("SELECT * FROM calendar_sources WHERE id = ?", (sid,)).fetchone()
    conn.execute("DELETE FROM calendar_events WHERE source_id = ?", (sid,))
    conn.execute("DELETE FROM calendar_sources WHERE id = ?", (sid,))
    conn.commit()
    conn.close()
    # 文件类型的来源：清理磁盘文件
    if src and src["type"] == "file":
        full = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads", "ics", src["url"])
        if os.path.isfile(full):
            try:
                os.remove(full)
            except OSError:
                pass
    return jsonify({"ok": True})


@app.route("/api/calendar/sources/<int:sid>/sync", methods=["POST"])
def sync_calendar_source(sid):
    """手动同步单个日历"""
    try:
        n = sync_one_source(sid)
        return jsonify({"ok": True, "processed": n})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@app.route("/api/calendar/sync-all", methods=["POST"])
def sync_all_calendars():
    """手动同步全部启用的日历；单个失败不中断其他"""
    conn = get_db()
    srcs = conn.execute("SELECT * FROM calendar_sources WHERE enabled = 1").fetchall()
    conn.close()
    results = []
    for s in srcs:
        try:
            n = sync_one_source(s["id"])
            results.append({"id": s["id"], "ok": True, "processed": n})
        except Exception as e:
            results.append({"id": s["id"], "ok": False, "error": str(e)})
    return jsonify({"ok": True, "results": results})


# ---------- 文件暂存 ----------
@app.route("/api/files")
def api_files():
    """文件列表：?search=&type=&sort=  （访问时先懒清理过期文件）"""
    files.cleanup_expired()
    search = request.args.get("search", "").strip()
    ftype = request.args.get("type", "").strip()
    sort = request.args.get("sort", "new")

    conn = get_db()
    q = "SELECT * FROM stored_files WHERE status != 'deleted'"
    args = []
    if search:
        q += " AND original_name LIKE ?"
        args.append(f"%{search}%")
    if ftype:
        q += " AND mime_type LIKE ?"
        args.append(f"{ftype}%")
    if sort == "new":
        q += " ORDER BY id DESC"
    elif sort == "old":
        q += " ORDER BY id ASC"
    elif sort == "expiring":
        q += " ORDER BY (expires_at IS NULL), expires_at ASC"
    elif sort == "size":
        q += " ORDER BY size DESC"
    rows = conn.execute(q, args).fetchall()
    shares = {
        r["file_id"]: r["c"]
        for r in conn.execute(
            "SELECT file_id, COUNT(*) AS c FROM file_share_tokens WHERE revoked_at IS NULL GROUP BY file_id"
        ).fetchall()
    }
    conn.close()
    return jsonify({"files": [dict(r) | {"active_shares": shares.get(r["id"], 0)} for r in rows]})


@app.route("/api/files/upload", methods=["POST"])
def upload_file_api():
    """上传文件（multipart）：file + note + tags + expire"""
    f = request.files.get("file")
    note = request.form.get("note", "")
    tags = request.form.get("tags", "")
    expire = request.form.get("expire", "never")
    err, rec = files.save_upload(f, note, tags, expire)
    if err:
        return jsonify({"error": err}), 400
    return jsonify({"ok": True, "file": rec})


@app.route("/api/files/<int:fid>/download")
def download_file_api(fid):
    err, resp = files.download_file(fid)
    if err:
        return jsonify({"error": err}), 404
    return resp


@app.route("/api/files/<int:fid>", methods=["PATCH"])
def update_file_api(fid):
    """改备注/标签/过期时间"""
    data = request.get_json() or {}
    conn = get_db()
    sets, vals = [], []
    for f in ("note", "tags"):
        if f in data:
            sets.append(f"{f} = ?")
            vals.append((data[f] or "").strip())
    if "expires_at" in data:
        sets.append("expires_at = ?")
        vals.append(data["expires_at"] or None)
    if sets:
        vals.append(fid)
        conn.execute(f"UPDATE stored_files SET {', '.join(sets)} WHERE id = ?", vals)
        conn.commit()
    conn.close()
    return jsonify({"ok": True})


def _delete_file_record(fid):
    """删除文件（磁盘 + 记录 + 分享）"""
    conn = get_db()
    rec = conn.execute("SELECT * FROM stored_files WHERE id = ?", (fid,)).fetchone()
    if rec:
        full = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads", "files", rec["storage_name"])
        if os.path.isfile(full):
            try:
                os.remove(full)
            except OSError:
                pass
        conn.execute("UPDATE stored_files SET status = 'deleted' WHERE id = ?", (fid,))
        conn.execute("DELETE FROM file_share_tokens WHERE file_id = ?", (fid,))
        conn.commit()
    conn.close()


@app.route("/api/files/<int:fid>", methods=["DELETE"])
def delete_file_api(fid):
    _delete_file_record(fid)
    return jsonify({"ok": True})


@app.route("/api/files/batch-delete", methods=["POST"])
def batch_delete_files_api():
    ids = (request.get_json() or {}).get("ids") or []
    for fid in ids:
        _delete_file_record(fid)
    return jsonify({"ok": True})


@app.route("/api/files/<int:fid>/share", methods=["POST"])
def create_file_share_api(fid):
    """创建分享链接：{hours: 24, max_downloads: -1}"""
    data = request.get_json() or {}
    hours = int(data.get("hours", 24))
    max_downloads = int(data.get("max_downloads", -1))
    err, token = files.create_share(fid, hours, max_downloads)
    if err:
        return jsonify({"error": err}), 400
    share_url = f"{request.host_url}share/{token}"
    return jsonify({"ok": True, "url": share_url, "token": token})


@app.route("/api/files/share/<token>", methods=["DELETE"])
def revoke_file_share_api(token):
    files.revoke_share(token)
    return jsonify({"ok": True})


@app.route("/api/files/<int:fid>/shares")
def list_file_shares_api(fid):
    """列出文件的全部分享记录（管理用）"""
    return jsonify({"shares": files.list_shares(fid)})


@app.route("/api/files/shares/<int:share_id>", methods=["DELETE"])
def revoke_share_by_id_api(share_id):
    """管理端按分享记录 id 撤销"""
    files.revoke_share_by_id(share_id)
    return jsonify({"ok": True})


@app.route("/api/files/stats")
def file_stats_api():
    files.cleanup_expired()
    return jsonify(files.storage_stats())


@app.route("/share/<token>")
def public_share(token):
    """公开分享下载（凭不可预测令牌访问）"""
    err, resp = files.download_share(token)
    if err:
        return jsonify({"error": err}), 404
    return resp


# ---------- 通知中心 ----------
@app.route("/api/notifications")
def api_notifications():
    """通知列表：?unread_only=1&source=&level=&limit= （访问时懒清理过期通知）"""
    notifications.cleanup_expired()
    unread_only = request.args.get("unread_only") == "1"
    source = request.args.get("source", "")
    level = request.args.get("level", "")
    limit = int(request.args.get("limit", 100))
    rows = notifications.list_notifications(unread_only, source, level, limit)
    return jsonify({"notifications": rows, "count": len(rows), "unread": notifications.unread_count()})


@app.route("/api/notifications/<int:nid>/read", methods=["POST"])
def notification_read(nid):
    notifications.set_read(nid, True)
    return jsonify({"ok": True})


@app.route("/api/notifications/<int:nid>/unread", methods=["POST"])
def notification_unread(nid):
    notifications.set_read(nid, False)
    return jsonify({"ok": True})


@app.route("/api/notifications/read-all", methods=["POST"])
def notification_read_all():
    notifications.read_all()
    return jsonify({"ok": True})


@app.route("/api/notifications/clear-read", methods=["POST"])
def notification_clear_read():
    notifications.clear_read()
    return jsonify({"ok": True})


@app.route("/api/notifications/<int:nid>", methods=["DELETE"])
def notification_delete(nid):
    notifications.delete_one(nid)
    return jsonify({"ok": True})


# ---------- PWA ----------
@app.route("/sw.js")
def sw_js():
    """Service Worker 必须在站点根路径（scope 覆盖全站）"""
    return send_file(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "sw.js"),
        mimetype="application/javascript",
    )


@app.route("/manifest.json")
def manifest_json():
    return send_file(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "manifest.json"),
        mimetype="application/manifest+json",
    )


@app.route("/offline.html")
def offline_page():
    return send_file(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "offline.html"),
        mimetype="text/html",
    )


# ---------- 待办 ----------
@app.route("/api/todos/reorder", methods=["PUT"])
def reorder_todos():
    """拖拽排序：ids 为新顺序（最前→最后），统一排到列表顶部，未参与的项保持在后面"""
    ids = (request.get_json() or {}).get("ids") or []
    try:
        ids = [int(x) for x in ids]
    except (TypeError, ValueError):
        return jsonify({"error": "ids 必须全是数字"}), 400
    if not ids:
        return jsonify({"error": "缺少 ids"}), 400
    conn = get_db()
    row = conn.execute("SELECT COALESCE(MIN(sort_order), 0) FROM todos").fetchone()
    base = row[0] - len(ids)
    for i, tid in enumerate(ids):
        conn.execute(
            "UPDATE todos SET sort_order = ? WHERE id = ?", (base + i, tid)
        )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/todos", methods=["POST"])
def add_todo():
    data = request.get_json()
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "内容不能为空"}), 400

    conn = get_db()
    cur = conn.execute(
        "INSERT INTO todos (text, sort_order) VALUES (?, ?)",
        (text, _next_todo_sort(conn)),
    )
    conn.commit()
    todo = conn.execute("SELECT * FROM todos WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(todo))


@app.route("/api/todos/<int:todo_id>/toggle", methods=["POST"])
def toggle_todo(todo_id):
    """勾选/取消完成：完成时记录完成时间（UTC），取消时清空"""
    conn = get_db()
    todo = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
    if not todo:
        conn.close()
        return jsonify({"error": "这条待办不存在"}), 404
    new_done = 1 - (todo["done"] or 0)
    if new_done:
        conn.execute(
            "UPDATE todos SET done = 1, completed_at = datetime('now','localtime') WHERE id = ?",
            (todo_id,),
        )
    else:
        conn.execute(
            "UPDATE todos SET done = 0, completed_at = NULL WHERE id = ?", (todo_id,)
        )
    conn.commit()
    updated = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
    conn.close()
    return jsonify(dict(updated))


@app.route("/api/todos/<int:todo_id>", methods=["DELETE"])
def delete_todo(todo_id):
    conn = get_db()
    conn.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/todos/<int:todo_id>", methods=["PUT", "PATCH"])
def update_todo(todo_id):
    """双击修改待办内容：{"text": "新文字"}"""
    data = request.get_json() or {}
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "内容不能为空"}), 400
    if len(text) > 500:
        return jsonify({"error": "内容过长（最多 500 字）"}), 400

    conn = get_db()
    todo = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
    if not todo:
        conn.close()
        return jsonify({"error": "这条待办不存在"}), 404
    conn.execute("UPDATE todos SET text = ? WHERE id = ?", (text, todo_id))
    conn.commit()
    updated = conn.execute("SELECT * FROM todos WHERE id = ?", (todo_id,)).fetchone()
    conn.close()
    return jsonify(dict(updated))


# ---------- 便签 ----------
@app.route("/api/note", methods=["POST"])
def save_note():
    data = request.get_json()
    conn = get_db()
    conn.execute("UPDATE note SET content = ? WHERE id = 1", (data.get("content") or "",))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- 大小周排班 ----------
_WEEK_NAMES = ["一", "二", "三", "四", "五", "六", "日"]


def _current_monday_str():
    """当前周的周一（YYYY-MM-DD），用于默认排班锚点"""
    now = datetime.now()
    return (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")


@app.route("/api/workdays", methods=["GET"])
def get_workdays():
    """读取大小周排班设置：{anchor_monday, anchor_type}
    未设置时默认：本周（当前周）为大周"""
    conn = get_db()
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = 'work_schedule'"
    ).fetchone()
    conn.close()
    if row and row["value"]:
        try:
            v = json.loads(row["value"])
            if v.get("anchor_monday") and v.get("anchor_type") in ("big", "small"):
                return jsonify(v)
        except Exception:
            pass
    return jsonify({"anchor_monday": _current_monday_str(), "anchor_type": "big"})


@app.route("/api/workdays", methods=["PUT"])
def set_workdays():
    """保存大小周排班：{anchor_monday: "2026-08-03"(周一), anchor_type: "big"|"small"}"""
    data = request.get_json() or {}
    anchor_monday = (data.get("anchor_monday") or "").strip()
    anchor_type = data.get("anchor_type")
    if anchor_type not in ("big", "small"):
        return jsonify({"error": "anchor_type 必须是 big（大周6天）或 small（小周5天）"}), 400
    try:
        d = datetime.strptime(anchor_monday, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "anchor_monday 格式应为 YYYY-MM-DD"}), 400
    if d.weekday() != 0:
        return jsonify({"error": "anchor_monday 必须是周一"}), 400
    value = json.dumps(
        {"anchor_monday": anchor_monday, "anchor_type": anchor_type},
        ensure_ascii=False,
    )
    conn = get_db()
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('work_schedule', ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (value,),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "anchor_monday": anchor_monday, "anchor_type": anchor_type})


# ---------- 每日习惯 ----------
@app.route("/api/habits", methods=["POST"])
def add_habit():
    """添加一个长期任务（习惯）"""
    data = request.get_json()
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "名字不能为空"}), 400

    conn = get_db()
    cur = conn.execute("INSERT INTO habits (name, emoji) VALUES (?, ?)", (name, (data.get("emoji") or "").strip()))
    conn.commit()
    habit = conn.execute("SELECT * FROM habits WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(habit))


@app.route("/api/habits/<int:habit_id>", methods=["DELETE"])
def delete_habit(habit_id):
    """删除一个习惯（连带删掉它的所有打卡记录）"""
    conn = get_db()
    conn.execute("DELETE FROM habits WHERE id = ?", (habit_id,))
    conn.execute("DELETE FROM habit_logs WHERE habit_id = ?", (habit_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/habits/<int:habit_id>/toggle", methods=["POST"])
def toggle_habit(habit_id):
    """打卡/取消打卡。默认操作"今天"；也可以传 {"date": "YYYY-MM-DD"}"""
    data = request.get_json() or {}
    day = data.get("date") or date.today().isoformat()

    conn = get_db()
    # 查一下今天是否已打卡
    exists = conn.execute(
        "SELECT id FROM habit_logs WHERE habit_id = ? AND log_date = ?", (habit_id, day)
    ).fetchone()

    if exists:
        conn.execute("DELETE FROM habit_logs WHERE id = ?", (exists["id"],))
        checked = False
    else:
        conn.execute("INSERT OR IGNORE INTO habit_logs (habit_id, log_date) VALUES (?, ?)", (habit_id, day))
        checked = True

    conn.commit()
    conn.close()
    return jsonify({"habit_id": habit_id, "date": day, "checked": checked})


# ---------- 灵感导图 ----------
@app.route("/api/mind", methods=["POST"])
def add_mind_node():
    """添加导图节点：{"parent_id": 1, "text": "..."}"""
    data = request.get_json()
    text = (data.get("text") or "").strip()
    if not text:
        return jsonify({"error": "内容不能为空"}), 400
    parent_id = int(data.get("parent_id") or 0)

    conn = get_db()
    # 算一下这个父节点下有几个子节点，用来排位置
    n = conn.execute("SELECT COUNT(*) AS c FROM mind_nodes WHERE parent_id = ?", (parent_id,)).fetchone()
    cur = conn.execute(
        "INSERT INTO mind_nodes (parent_id, text, sort) VALUES (?, ?, ?)",
        (parent_id, text, n["c"]),
    )
    conn.commit()
    node = conn.execute("SELECT * FROM mind_nodes WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(node))


@app.route("/api/mind/cards", methods=["POST"])
def create_mind_card():
    """创建自由卡片（画布坐标）：{"x":..,"y":..,"title":..,"content":..,"width":..,"height":..}"""
    data = request.get_json() or {}
    text = (data.get("title") or data.get("text") or "新灵感").strip()
    x = float(data.get("x") or 0)
    y = float(data.get("y") or 0)
    parent_id = int(data.get("parent_id") or 1)
    width = int(data.get("width") or 200)
    height = int(data.get("height") or 90)

    conn = get_db()
    n = conn.execute("SELECT COALESCE(MAX(z_index), 0) AS m FROM mind_nodes").fetchone()
    cur = conn.execute(
        """INSERT INTO mind_nodes (parent_id, text, sort, x, y, width, height, z_index)
           VALUES (?, ?, 0, ?, ?, ?, ?, ?)""",
        (parent_id, text, x, y, width, height, n["m"] + 1),
    )
    conn.commit()
    node = conn.execute("SELECT * FROM mind_nodes WHERE id = ?", (cur.lastrowid,)).fetchone()
    conn.close()
    return jsonify(dict(node))


@app.route("/api/mind/batch", methods=["POST"])
def batch_update_mind():
    """批量更新节点：{"updates": [{"id":1,"x":..,"y":..,"width":..,"height":..,"z_index":..,"color":..,"font_size":..,"text":..}]}"""
    data = request.get_json() or {}
    updates = data.get("updates") or []
    if not updates:
        return jsonify({"error": "没有可更新的内容"}), 400

    conn = get_db()
    for u in updates:
        sets, vals = [], []
        for key in ("x", "y", "width", "height", "z_index", "font_size"):
            if key in u and u[key] is not None:
                sets.append(f"{key} = ?")
                vals.append(int(u[key]) if key in ("width", "height", "z_index", "font_size") else float(u[key]))
        for key in ("text", "color"):
            if key in u and u[key] is not None:
                sets.append(f"{key} = ?")
                vals.append(str(u[key]))
        if sets:
            vals.append(int(u["id"]))
            conn.execute(f"UPDATE mind_nodes SET {', '.join(sets)} WHERE id = ?", vals)
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/mind/batch-delete", methods=["POST"])
def batch_delete_mind():
    """批量删除节点（连带子孙，根节点除外）"""
    data = request.get_json() or {}
    ids = [int(i) for i in (data.get("ids") or [])]
    if not ids or 1 in ids:
        return jsonify({"error": "无效的删除请求"}), 400

    conn = get_db()
    to_delete = set(ids)
    queue = list(ids)
    while queue:
        pid = queue.pop(0)
        kids = conn.execute("SELECT id FROM mind_nodes WHERE parent_id = ?", (pid,)).fetchall()
        for k in kids:
            if k["id"] not in to_delete:
                to_delete.add(k["id"])
                queue.append(k["id"])

    for nid in to_delete:
        conn.execute("DELETE FROM mind_nodes WHERE id = ?", (nid,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/mind/duplicate", methods=["POST"])
def duplicate_mind():
    """复制节点（连带子孙）：{"ids":[..], "dx":20, "dy":20} → 返回新数据"""
    data = request.get_json() or {}
    ids = [int(i) for i in (data.get("ids") or [])]
    dx = float(data.get("dx") or 20)
    dy = float(data.get("dy") or 20)
    if not ids:
        return jsonify({"error": "没有可复制的节点"}), 400

    conn = get_db()
    id_map = {}
    new_ids = []
    queue = list(ids)
    while queue:
        sid = queue.pop(0)
        if sid in id_map or sid == 1:
            continue
        node = conn.execute("SELECT * FROM mind_nodes WHERE id = ?", (sid,)).fetchone()
        if not node:
            continue
        new_parent = id_map.get(node["parent_id"], node["parent_id"])
        n = conn.execute("SELECT COALESCE(MAX(z_index), 0) AS m FROM mind_nodes").fetchone()
        cur = conn.execute(
            """INSERT INTO mind_nodes (parent_id, text, sort, x, y, width, height, z_index, color, font_size)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                new_parent,
                node["text"],
                node["sort"],
                (node["x"] or 0) + dx,
                (node["y"] or 0) + dy,
                node["width"] or 200,
                node["height"] or 90,
                n["m"] + 1,
                node["color"] or "",
                node["font_size"] or 13,
            ),
        )
        id_map[sid] = cur.lastrowid
        new_ids.append(cur.lastrowid)
        kids = conn.execute("SELECT id FROM mind_nodes WHERE parent_id = ?", (sid,)).fetchall()
        for k in kids:
            queue.append(k["id"])

    conn.commit()
    nodes = conn.execute("SELECT * FROM mind_nodes ORDER BY z_index, id").fetchall()
    conn.close()
    return jsonify({"new_ids": new_ids, "mind": [dict(nn) for nn in nodes]})


@app.route("/api/mind/<int:node_id>", methods=["PATCH"])
def update_mind_node(node_id):
    """更新节点：可以改 text / x / y / color / font_size"""
    data = request.get_json() or {}
    sets = []
    vals = []
    if "text" in data:
        t = (data.get("text") or "").strip()
        if t:
            sets.append("text = ?")
            vals.append(t)
    if "x" in data:
        sets.append("x = ?")
        vals.append(float(data["x"]))
    if "y" in data:
        sets.append("y = ?")
        vals.append(float(data["y"]))
    if "color" in data:
        sets.append("color = ?")
        vals.append(str(data["color"] or ""))
    if "font_size" in data:
        sets.append("font_size = ?")
        vals.append(int(data["font_size"]))
    if not sets:
        return jsonify({"error": "没有可更新的内容"}), 400

    vals.append(node_id)
    conn = get_db()
    conn.execute(f"UPDATE mind_nodes SET {', '.join(sets)} WHERE id = ?", vals)
    conn.commit()
    node = conn.execute("SELECT * FROM mind_nodes WHERE id = ?", (node_id,)).fetchone()
    conn.close()
    if not node:
        return jsonify({"error": "节点不存在"}), 404
    return jsonify(dict(node))


@app.route("/api/mind/clear", methods=["POST"])
def clear_mind():
    """清空导图：删除除根节点外的所有节点"""
    conn = get_db()
    conn.execute("DELETE FROM mind_nodes WHERE id != 1")
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/mind/<int:node_id>", methods=["DELETE"])
def delete_mind_node(node_id):
    """删除节点（连带删除它的所有子孙节点）"""
    conn = get_db()

    # 收集要删的所有节点 id（先子后孙，广度收集）
    to_delete = [node_id]
    queue = [node_id]
    while queue:
        pid = queue.pop(0)
        children = conn.execute(
            "SELECT id FROM mind_nodes WHERE parent_id = ?", (pid,)
        ).fetchall()
        for c in children:
            to_delete.append(c["id"])
            queue.append(c["id"])

    # 注意：永远不能删掉根节点 id=1
    if 1 in to_delete:
        conn.close()
        return jsonify({"error": "根节点不能删除"}), 400

    for nid in to_delete:
        conn.execute("DELETE FROM mind_nodes WHERE id = ?", (nid,))

    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- 启动 ----------
if __name__ == "__main__":
    # host="0.0.0.0" 让其他设备也能访问（部署到 VPS 后更是必须的）
    # debug 模式：本地开发时设 FLASK_DEBUG=1 打开，线上默认关闭
    import os

    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=5000, debug=debug)
