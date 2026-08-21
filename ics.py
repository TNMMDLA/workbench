# -*- coding: utf-8 -*-
"""ICS 日历同步模块

功能：
- SSRF 防护（拒绝内网/本机/元数据地址，DNS 解析后检查，重定向后重查）
- 抓取 ICS（超时 + 大小限制）
- 解析 ICS（UID 去重、循环事件展开、全天事件、时区、取消事件）
- 同步逻辑（增量更新、失败隔离、记录状态）

依赖：icalendar、python-dateutil
"""

import ipaddress
import os
import re
import socket
import urllib.parse
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone

try:
    from icalendar import Calendar
    from dateutil.rrule import rrulestr
    HAS_ICAL = True
except ImportError:
    HAS_ICAL = False

# ---------- 配置 ----------
MAX_ICS_SIZE = 2 * 1024 * 1024      # 单个 ICS 最大 2MB
FETCH_TIMEOUT = 10                  # 网络超时秒数
MAX_REDIRECTS = 5
EXPAND_DAYS = 365                   # 循环事件展开未来天数
USER_AGENT = "AQ-Workbench/1.0 (+calendar)"

# 禁止访问的网段（SSRF）
BLOCKED_NETS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("::1"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("::ffff:127.0.0.0/104"),
    ipaddress.ip_network("::ffff:10.0.0.0/104"),
    ipaddress.ip_network("::ffff:172.16.0.0/108"),
    ipaddress.ip_network("::ffff:192.168.0.0/112"),
]

# 云元数据地址特征（多种云）
METADATA_HOSTS = {
    "metadata.google.internal",
    "metadata.google.com",
    "169.254.169.254",
    "100.100.100.200",   # 阿里云
    "metadata.tencentyun.com",  # 腾讯云
}


class ICSError(Exception):
    """ICS 同步过程中的可预期错误（提示给用户）"""


def is_blocked_ip(ip_str):
    """判断 IP 是否属于禁止访问的内网/元数据范围"""
    try:
        addr = ipaddress.ip_address(ip_str.split("%")[0])
    except ValueError:
        return True
    for net in BLOCKED_NETS:
        if addr in net:
            return True
    return False


def check_url(url):
    """SSRF 防护：校验协议 + 域名/IP（含 DNS 解析后检查）"""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ICSError("日历地址只允许 http/https 协议")
    host = parsed.hostname
    if not host:
        raise ICSError("日历地址格式不正确")
    if host.lower() in METADATA_HOSTS:
        raise ICSError("该地址是云元数据服务地址，已拒绝")

    # 主机名本身是 IP 的情况
    try:
        ip = ipaddress.ip_address(host)
        if is_blocked_ip(str(ip)):
            raise ICSError("该地址指向内网或本机，已拒绝")
        return
    except ValueError:
        pass

    # 域名 → DNS 解析后检查所有结果
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise ICSError("域名无法解析")
    for info in infos:
        ip_str = info[4][0]
        if is_blocked_ip(ip_str):
            raise ICSError(f"域名 {host} 解析到内网地址 {ip_str}，已拒绝")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """禁用自动重定向（手动逐跳检查 SSRF）"""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_ics(url):
    """安全抓取 ICS：SSRF 检查（含重定向后重查）+ 超时 + 大小限制"""
    current = url
    opener = urllib.request.build_opener(NoRedirect)
    for _ in range(MAX_REDIRECTS + 1):
        check_url(current)
        req = urllib.request.Request(current, headers={"User-Agent": USER_AGENT})
        try:
            resp = opener.open(req, timeout=FETCH_TIMEOUT)
        except urllib.error.HTTPError as e:
            raise ICSError(f"服务器返回错误：HTTP {e.code}")
        except (urllib.error.URLError, socket.timeout, OSError) as e:
            raise ICSError(f"网络请求失败：{e.reason if hasattr(e, 'reason') else e}")

        if resp.status in (301, 302, 303, 307, 308):
            loc = resp.headers.get("Location")
            if not loc:
                raise ICSError("重定向缺少目标地址")
            current = urllib.parse.urljoin(current, loc)
            continue
        if resp.status != 200:
            raise ICSError(f"服务器返回 HTTP {resp.status}")

        # 大小限制（先看 Content-Length，再限制实际读取）
        clen = resp.headers.get("Content-Length")
        if clen and clen.isdigit() and int(clen) > MAX_ICS_SIZE:
            raise ICSError("日历文件超过大小限制（2MB）")
        data = resp.read(MAX_ICS_SIZE + 1)
        if len(data) > MAX_ICS_SIZE:
            raise ICSError("日历文件超过大小限制（2MB）")
        return data
    raise ICSError("重定向次数过多")


# ---------- ICS 解析 ----------

def _to_utc(dt_value, tzid=None):
    """把 ICS 的日期时间转成 UTC ISO 字符串；全天事件返回日期字符串"""
    if isinstance(dt_value, datetime):
        if dt_value.tzinfo is None:
            # naive：按 TZID 或视为 UTC
            if tzid:
                try:
                    from zoneinfo import ZoneInfo
                    dt_value = dt_value.replace(tzinfo=ZoneInfo(tzid))
                except Exception:
                    dt_value = dt_value.replace(tzinfo=timezone.utc)
            else:
                dt_value = dt_value.replace(tzinfo=timezone.utc)
        dt_value = dt_value.astimezone(timezone.utc)
        return dt_value.strftime("%Y-%m-%dT%H:%M:%SZ")
    if isinstance(dt_value, date):
        return dt_value.strftime("%Y-%m-%d")
    return None


def _expand_rrule(start, rrule_str, until):
    """展开循环事件，返回未来实例（until 之前的 datetime 列表）"""
    try:
        rule = rrulestr(rrule_str, dtstart=start)
        return list(rule.between(start, until, inc=True))
    except Exception:
        return [start]


def parse_ics(content, source_id):
    """解析 ICS 文本 → 事件列表（已展开循环、UTC 标准化）"""
    if not HAS_ICAL:
        raise ICSError("服务器缺少 icalendar 库")
    try:
        cal = Calendar.from_ical(content)
    except Exception as e:
        raise ICSError(f"ICS 文件解析失败：{e}")

    events = []
    until = datetime.now(timezone.utc) + timedelta(days=EXPAND_DAYS)
    seen = set()

    for comp in cal.walk("VEVENT"):
        uid = str(comp.get("UID") or str(uuid.uuid4()))
        summary = str(comp.get("SUMMARY") or "(无标题)")
        description = str(comp.get("DESCRIPTION") or "")
        location = str(comp.get("LOCATION") or "")
        status = str(comp.get("STATUS") or "CONFIRMED").upper()

        dtstart = comp.get("DTSTART")
        if dtstart is None:
            continue
        tzid = dtstart.params.get("TZID")
        start_value = dtstart.dt
        is_all_day = isinstance(start_value, date) and not isinstance(start_value, datetime)

        # 结束时间：DTEND 优先，否则 DURATION，否则开始
        dtend = comp.get("DTEND")
        if dtend is not None:
            end_value = dtend.dt
        elif comp.get("DURATION"):
            end_value = start_value + comp.get("DURATION").dt
        else:
            end_value = start_value

        # 循环事件展开
        rrule = comp.get("RRULE")
        if rrule is not None:
            rrule_str = rrule.to_ical().decode()  # 标准 RRULE 字符串，如 "FREQ=WEEKLY;COUNT=3"
            base_start = _to_utc(start_value, tzid)
            start_dt = start_value if isinstance(start_value, datetime) else datetime.combine(start_value, datetime.min.time())
            if start_dt.tzinfo is None:
                if tzid:
                    try:
                        from zoneinfo import ZoneInfo
                        start_dt = start_dt.replace(tzinfo=ZoneInfo(tzid))
                    except Exception:
                        start_dt = start_dt.replace(tzinfo=timezone.utc)
                else:
                    start_dt = start_dt.replace(tzinfo=timezone.utc)
            for inst in _expand_rrule(start_dt, rrule_str, until):
                inst_utc = inst.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                key = (uid, inst_utc)
                if key in seen:
                    continue
                seen.add(key)
                events.append({
                    "external_uid": uid,
                    "title": summary,
                    "description": description,
                    "location": location,
                    "start_at": inst_utc,
                    "end_at": inst_utc,
                    "all_day": is_all_day,
                    "status": "cancelled" if status == "CANCELLED" else "confirmed",
                })
        else:
            start_utc = _to_utc(start_value, tzid)
            end_utc = _to_utc(end_value, tzid)
            if start_utc is None:
                continue
            key = (uid, start_utc)
            if key in seen:
                continue
            seen.add(key)
            events.append({
                "external_uid": uid,
                "title": summary,
                "description": description,
                "location": location,
                "start_at": start_utc,
                "end_at": end_utc or start_utc,
                "all_day": is_all_day,
                "status": "cancelled" if status == "CANCELLED" else "confirmed",
            })

    return events


# ---------- 同步执行 ----------

def sync_source(conn, source):
    """同步单个日历来源（返回处理数量）；失败抛 ICSError 由调用方记录"""
    if source["type"] == "url":
        content = fetch_ics(source["url"])
    else:
        # file 类型：从本地目录读取
        fpath = source["url"]  # 存的是相对路径
        full = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads", "ics", fpath)
        if not os.path.isfile(full):
            raise ICSError("日历文件不存在，可能已被清理")
        with open(full, "rb") as f:
            content = f.read(MAX_ICS_SIZE + 1)
        if len(content) > MAX_ICS_SIZE:
            raise ICSError("日历文件超过大小限制")

    parsed = parse_ics(content, source["id"])

    # 与数据库现有事件对比（该来源）
    existing = conn.execute(
        "SELECT * FROM calendar_events WHERE source_id = ? AND is_local = 0",
        (source["id"],),
    ).fetchall()
    existing_by_key = {}
    for e in existing:
        key = (e["external_uid"], e["start_at"])
        existing_by_key[key] = e

    new_keys = set()
    processed = 0
    for ev in parsed:
        key = (ev["external_uid"], ev["start_at"])
        new_keys.add(key)
        if ev["status"] == "cancelled":
            # 取消的事件：删除数据库记录
            if key in existing_by_key:
                conn.execute("DELETE FROM calendar_events WHERE id = ?", (existing_by_key[key]["id"],))
                conn.execute("DELETE FROM calendar_reminders WHERE event_id = ?", (existing_by_key[key]["id"],))
                processed += 1
            continue
        row = existing_by_key.get(key)
        changed = False
        if row is None:
            conn.execute(
                """INSERT INTO calendar_events
                   (source_id, external_uid, title, description, location, start_at, end_at, all_day, status, original_url, is_local)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)""",
                (source["id"], ev["external_uid"], ev["title"], ev["description"],
                 ev["location"], ev["start_at"], ev["end_at"], 1 if ev["all_day"] else 0,
                 ev["status"], source["url"]),
            )
            processed += 1
        else:
            # 已存在：内容变化则更新
            if (row["title"] != ev["title"] or row["description"] != ev["description"]
                    or row["location"] != ev["location"] or row["end_at"] != ev["end_at"]
                    or bool(row["all_day"]) != ev["all_day"] or row["status"] != ev["status"]):
                conn.execute(
                    """UPDATE calendar_events SET title=?, description=?, location=?, end_at=?,
                       all_day=?, status=? WHERE id=?""",
                    (ev["title"], ev["description"], ev["location"], ev["end_at"],
                     1 if ev["all_day"] else 0, ev["status"], row["id"]),
                )
                processed += 1

    # 本地存在但远端已移除的事件 → 删除（处理取消）
    for key, row in existing_by_key.items():
        if key not in new_keys and row["status"] != "cancelled":
            conn.execute("DELETE FROM calendar_events WHERE id = ?", (row["id"],))
            conn.execute("DELETE FROM calendar_reminders WHERE event_id = ?", (row["id"],))
            processed += 1

    conn.commit()
    return processed
