/* =====================================================
   NOTIFICATIONS · 通知中心（阶段 6）
   功能：列表（只看未读/来源/等级筛选）、已读/未读、
        单条删除、全部已读、清空已读、相对时间、跳转
   ===================================================== */

window.Notifications = (function () {
  "use strict";

  async function api(url, options = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    return res.json();
  }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // 相对时间
  function relTime(iso) {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 3600 * 1000) return Math.floor(diff / 60000) + " 分钟前";
    if (diff < 24 * 3600 * 1000) return Math.floor(diff / 3600000) + " 小时前";
    if (diff < 7 * 24 * 3600 * 1000) return Math.floor(diff / 86400000) + " 天前";
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  const LEVEL_META = {
    info: { icon: "ℹ️", cls: "lv-info" },
    success: { icon: "✅", cls: "lv-success" },
    warning: { icon: "⚠️", cls: "lv-warning" },
    error: { icon: "❌", cls: "lv-error" },
  };
  const SOURCE_NAME = { calendar: "日历", files: "文件", system: "系统", pwa: "PWA" };

  async function loadList() {
    const unread = document.getElementById("notif-unread-only").checked ? "1" : "";
    const source = document.getElementById("notif-source").value;
    const level = document.getElementById("notif-level").value;
    const q = new URLSearchParams();
    if (unread) q.set("unread_only", unread);
    if (source) q.set("source", source);
    if (level) q.set("level", level);
    const data = await api(`/api/notifications?${q}`);
    renderList(data.notifications || []);
    updateBellBadge(data.unread || 0);
  }

  function renderList(items) {
    const box = document.getElementById("notif-list");
    if (!items.length) {
      box.innerHTML = '<div class="notif-empty">暂无通知</div>';
      return;
    }
    box.innerHTML = items
      .map((n) => {
        const meta = LEVEL_META[n.level] || LEVEL_META.info;
        const unreadCls = n.is_read ? "" : " unread";
        const repeat = n.repeat_count > 1 ? `<span class="notif-repeat">×${n.repeat_count}</span>` : "";
        return `<div class="notif-item${unreadCls}" data-id="${n.id}">
          <span class="notif-icon ${meta.cls}">${meta.icon}</span>
          <div class="notif-body">
            <div class="notif-title">${escapeHtml(n.title)} ${repeat}
              <span class="notif-source">${SOURCE_NAME[n.source] || n.source}</span>
            </div>
            ${n.content ? `<div class="notif-content">${escapeHtml(n.content)}</div>` : ""}
            <div class="notif-time">${relTime(n.created_at)}</div>
          </div>
          <div class="notif-actions">
            ${n.is_read ? `<button class="notif-btn" data-act="unread" title="标为未读">◌</button>` : `<button class="notif-btn" data-act="read" title="标为已读">✓</button>`}
            <button class="notif-btn" data-act="delete" title="删除">✕</button>
          </div>
        </div>`;
      })
      .join("");
  }

  // 顶部铃铛角标
  function updateBellBadge(unread) {
    const badge = document.getElementById("bell-count");
    if (unread > 0) {
      badge.textContent = unread > 99 ? "99+" : unread;
      badge.style.display = "flex";
    } else {
      badge.style.display = "none";
    }
  }

  function wire() {
    document.getElementById("notif-unread-only").addEventListener("change", loadList);
    document.getElementById("notif-source").addEventListener("change", loadList);
    document.getElementById("notif-level").addEventListener("change", loadList);

    document.getElementById("notif-read-all").addEventListener("click", async () => {
      await api("/api/notifications/read-all", { method: "POST" });
      loadList();
    });
    document.getElementById("notif-clear-read").addEventListener("click", async () => {
      if (!confirm("确定清空所有已读通知吗？")) return;
      await api("/api/notifications/clear-read", { method: "POST" });
      loadList();
    });

    // 列表操作
    document.getElementById("notif-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      const item = e.target.closest(".notif-item");
      if (!item) return;
      const id = Number(item.dataset.id);

      if (btn) {
        const act = btn.dataset.act;
        if (act === "read") await api(`/api/notifications/${id}/read`, { method: "POST" });
        else if (act === "unread") await api(`/api/notifications/${id}/unread`, { method: "POST" });
        else if (act === "delete") await api(`/api/notifications/${id}`, { method: "DELETE" });
        loadList();
        return;
      }
      // 点击主体：标记已读 + 跳转相关页面
      if (!item.classList.contains("unread")) return;
      await api(`/api/notifications/${id}/read`, { method: "POST" });
      loadList();
      // action_url 通过 data 属性获取（简化：重新查太重，直接按 related 猜测）
      const title = item.querySelector(".notif-title").textContent;
      if (title.includes("日历")) location.hash = "#/calendar";
      else if (title.includes("文件")) location.hash = "#/files";
    });
  }

  function init() {
    wire();
    window.addEventListener("hashchange", () => {
      if (location.hash === "#/notifications") loadList();
    });
  }

  return { init, loadList, updateBellBadge };
})();
