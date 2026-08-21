/* =====================================================
   CALENDAR · 本地日历（阶段 2）
   功能：月/周/今日/列表视图、事件创建/编辑/删除（二次确认）、
        提醒设置、颜色、全天事件
   时间约定：前端本地时区 ⇄ 后端 UTC ISO
   ===================================================== */

window.Calendar = (function () {
  "use strict";

  /* ---------- 状态 ---------- */
  let currentView = "month";     // month | week | day | list
  let anchor = new Date();       // 当前视图锚点（月=该月，周=该周，日=当天）
  let events = [];               // 当前范围事件
  let sources = [];              // 日历来源
  let filter = "all";            // all | local | 来源 id
  let editingId = null;          // 正在编辑的事件 id（null = 新建）
  let selectedColor = "#6366f1";
  let selectedSourceColor = "#6366f1";
  let workdays = null;           // 大小周排班 {anchor_monday, anchor_type}
  let showDone = localStorage.getItem("cal-show-done") === "1"; // 是否叠加显示已完成任务
  let doneTodos = [];            // 保留期内已完成任务列表
  let detailDate = null;         // 当日详情浮层当前日期

  /* ---------- 工具 ---------- */
  async function api(url, options = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    return res.json();
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  // Date → "YYYY-MM-DD"
  function ymd(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Date → 本地 datetime-local 值
  function toLocalInput(d) {
    return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Date → UTC ISO（存储）
  function toUTC(d) {
    return d.toISOString();
  }

  // UTC ISO → 本地 Date
  function fromUTC(s) {
    return new Date(s);
  }

  // UTC ISO → 本地显示 "8月6日 周四 10:00"
  function fmtDate(s, withTime) {
    if (!s) return "";
    const d = fromUTC(s);
    const wd = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
    const base = `${d.getMonth() + 1}月${d.getDate()}日 周${wd}`;
    if (withTime === false) return base;
    return `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // 周起始（周一为一周开始）
  function mondayOf(d) {
    const r = new Date(d);
    const day = (r.getDay() + 6) % 7; // 周一=0
    r.setDate(r.getDate() - day);
    r.setHours(0, 0, 0, 0);
    return r;
  }

  /* ---------- 大小周排班 ---------- */
  // 某天所在周的类型："big"(大周6天) | "small"(小周5天) | null(未设置)
  function weekType(d) {
    if (!workdays || !workdays.anchor_monday) return null;
    const anchor = new Date(workdays.anchor_monday + "T00:00:00");
    if (isNaN(anchor)) return null;
    const m = mondayOf(d);
    const weeksDiff = Math.round((m - anchor) / (7 * 86400000));
    const anchorBig = workdays.anchor_type === "big";
    return weeksDiff % 2 === 0 ? (anchorBig ? "big" : "small") : (anchorBig ? "small" : "big");
  }

  // 某天是否工作日：true/false（null = 未设置排班）
  // 大周：周一~周六上班，休周日；小周：周一~周五上班，休周六、周日
  function isWorkday(d) {
    const type = weekType(d);
    if (!type) return null;
    const dow = d.getDay(); // 0=周日
    if (type === "big") return dow !== 0;
    return dow !== 0 && dow !== 6;
  }

  // 已完成任务的完成时间（UTC 字符串 "YYYY-MM-DD HH:MM:SS"）→ 本地 Date
  function doneDate(dtStr) {
    if (!dtStr) return null;
    const d = new Date(String(dtStr).replace(" ", "T") + "Z");
    return isNaN(d) ? null : d;
  }

  // 某天保留期内的已完成任务
  function doneOfDay(day) {
    if (!showDone || !doneTodos.length) return [];
    const key = ymd(day);
    return doneTodos.filter((t) => {
      const d = doneDate(t.completed_at);
      return d && ymd(d) === key;
    });
  }

  function rangeOf(view) {
    if (view === "month") {
      const s = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const e = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
      return { start: s, end: e, title: `${anchor.getFullYear()}年${anchor.getMonth() + 1}月` };
    }
    if (view === "week") {
      const s = mondayOf(anchor);
      const e = new Date(s);
      e.setDate(e.getDate() + 7);
      return { start: s, end: e, title: `${s.getMonth() + 1}月${s.getDate()}日 - ${e.getMonth() + 1}月${e.getDate()}日` };
    }
    if (view === "day") {
      const s = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      const e = new Date(s);
      e.setDate(e.getDate() + 1);
      return { start: s, end: e, title: `${s.getMonth() + 1}月${s.getDate()}日 今日` };
    }
    // list：前后 30 天
    const s = new Date();
    s.setDate(s.getDate() - 2);
    const e = new Date();
    e.setDate(e.getDate() + 60);
    return { start: s, end: e, title: "日程列表" };
  }

  function navigate(dir) {
    if (currentView === "month") {
      anchor = new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
    } else if (currentView === "week") {
      anchor.setDate(anchor.getDate() + dir * 7);
    } else if (currentView === "day") {
      anchor.setDate(anchor.getDate() + dir);
    } else {
      anchor = new Date();
    }
    load();
  }

  /* ---------- 数据加载 ---------- */
  async function loadSources() {
    try {
      const data = await api("/api/calendar/sources");
      sources = data.sources || [];
      renderFilterOptions();
    } catch (e) {
      sources = [];
    }
  }

  function renderFilterOptions() {
    const sel = document.getElementById("cal-filter");
    const cur = sel.value;
    sel.innerHTML = '<option value="all">全部日历</option><option value="local">本地事件</option>';
    sources.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = String(s.id);
      opt.textContent = `${s.color ? "● " : ""}${s.name}${s.enabled ? "" : "（停用）"}`;
      sel.appendChild(opt);
    });
    sel.value = sources.some((s) => String(s.id) === cur) ? cur : "all";
  }

  async function load() {
    const r = rangeOf(currentView);
    document.getElementById("cal-title").textContent = r.title;
    await loadSources();
    try {
      workdays = await api("/api/workdays");
    } catch (e) {
      workdays = null;
    }
    updateWorkdayUI();
    const data = await api(`/api/calendar?start=${toUTC(r.start)}&end=${toUTC(r.end)}`);
    doneTodos = data.done_todos || [];
    updateDoneBtn();
    events = (data.events || []).filter((e) => {
      if (filter === "all") return true;
      if (filter === "local") return e.is_local === 1;
      return e.source_id === Number(filter);
    });
    render();
  }

  /* ---------- 渲染 ---------- */
  function render() {
    const box = document.getElementById("cal-view");
    if (currentView === "month") box.innerHTML = renderMonth();
    else if (currentView === "week") box.innerHTML = renderWeek();
    else if (currentView === "day") box.innerHTML = renderDay();
    else box.innerHTML = renderList();
    wireViewEvents(box);
  }

  function eventsOfDay(day) {
    const key = ymd(day);
    return events.filter((e) => ymd(fromUTC(e.start_at)) === key);
  }

  function eventHtml(e, short) {
    const color = e.color || "#6366f1";
    const t = fromUTC(e.start_at);
    const label = e.all_day ? "全天" : `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    return `<div class="cal-event" data-id="${e.id}" style="border-left:3px solid ${color}">
      <span class="cal-event-time">${label}</span>
      <span class="cal-event-title">${escapeHtml(e.title)}</span>
    </div>`;
  }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderMonth() {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const startGrid = mondayOf(first);
    const todayKey = ymd(new Date());
    let html = '<div class="cal-month">';
    ["一", "二", "三", "四", "五", "六", "日"].forEach((w) => {
      html += `<div class="cal-month-head">${w}</div>`;
    });
    for (let i = 0; i < 42; i++) {
      const d = new Date(startGrid);
      d.setDate(d.getDate() + i);
      const inMonth = d.getMonth() === anchor.getMonth();
      const isToday = ymd(d) === todayKey;
      const evs = eventsOfDay(d);
      const wd = isWorkday(d);
      const wkCls = wd === false ? " off" : wd === true ? " on" : "";
      const wkTag = wd === false ? "<span class='wk-tag off'>休</span>" : wd === true ? "<span class='wk-tag on'>班</span>" : "";
      const dones = doneOfDay(d);
      const doneHtml = showDone && dones.length
        ? `<div class="cal-done-block">${dones.slice(0, 3).map((x) => `<div class="cal-done">✅ ${escapeHtml(x.text)}</div>`).join("")}${dones.length > 3 ? `<div class="cal-done-more">+${dones.length - 3} 已完成</div>` : ""}</div>`
        : "";
      html += `<div class="cal-month-cell${inMonth ? "" : " out"}${wkCls}" data-date="${ymd(d)}">
        <div class="cal-day-num${isToday ? " today" : ""}">${d.getDate()}${wkTag}</div>
        ${evs.slice(0, 3).map((e) => eventHtml(e, true)).join("")}
        ${doneHtml}
        ${evs.length > 3 ? `<div class="cal-more">+${evs.length - 3} 更多</div>` : ""}
      </div>`;
    }
    return html + "</div>";
  }

  function renderWeek() {
    const s = mondayOf(anchor);
    const todayKey = ymd(new Date());
    let html = '<div class="cal-week">';
    for (let i = 0; i < 7; i++) {
      const d = new Date(s);
      d.setDate(d.getDate() + i);
      const isToday = ymd(d) === todayKey;
      const wd = isWorkday(d);
      const wkCls = wd === false ? " off" : wd === true ? " on" : "";
      const wkTag = wd === false ? "<span class='wk-tag off'>休</span>" : wd === true ? "<span class='wk-tag on'>班</span>" : "";
      const dones = doneOfDay(d);
      const doneHtml = showDone && dones.length
        ? `<div class="cal-done-block">${dones.map((x) => `<div class="cal-done">✅ ${escapeHtml(x.text)}</div>`).join("")}</div>`
        : "";
      html += `<div class="cal-week-col${wkCls}">
        <div class="cal-week-head${isToday ? " today" : ""}">
          ${["一", "二", "三", "四", "五", "六", "日"][i]} ${d.getDate()}${wkTag}
        </div>
        <div class="cal-week-body" data-date="${ymd(d)}">
          ${eventsOfDay(d).map((e) => eventHtml(e)).join("")}
          ${doneHtml}
        </div>
      </div>`;
    }
    return html + "</div>";
  }

  function renderDay() {
    const key = ymd(anchor);
    const evs = events.filter((e) => ymd(fromUTC(e.start_at)) === key);
    const dones = doneOfDay(anchor);
    const todayKey = ymd(new Date());
    const isToday = key === todayKey ? " today" : "";
    const doneHtml =
      showDone && dones.length
        ? `<div class="cal-day-done"><div class="cal-day-done-title">✅ 当天完成</div>${dones
            .map((x) => `<div class="cal-done">${escapeHtml(x.text)}</div>`)
            .join("")}</div>`
        : "";
    if (!evs.length && !dones.length) {
      return `<div class="cal-empty" data-date="${key}">今天没有日程，点击「＋ 新建事件」或点击空白处查看当日详情</div>`;
    }
    return `<div class="cal-day-list">${evs.map((e) => {
      const t = fromUTC(e.start_at);
      return `<div class="cal-day-item" data-date="${key}">
        <span class="cal-day-time">${e.all_day ? "全天" : `${pad(t.getHours())}:${pad(t.getMinutes())}`}</span>
        <span class="cal-day-dot" style="background:${e.color || "#6366f1"}"></span>
        <span class="cal-day-title">${escapeHtml(e.title)}</span>
      </div>`;
    }).join("")}${doneHtml}</div>`;
  }

  function renderList() {
    const sorted = [...events].sort((a, b) => (a.start_at > b.start_at ? 1 : -1));
    if (!sorted.length) {
      return '<div class="cal-empty">未来 60 天暂无日程</div>';
    }
    let lastKey = "";
    let html = '<div class="cal-list">';
    sorted.forEach((e) => {
      const d = fromUTC(e.start_at);
      const key = ymd(d);
      if (key !== lastKey) {
        lastKey = key;
        html += `<div class="cal-list-date">${d.getMonth() + 1}月${d.getDate()}日 周${["日", "一", "二", "三", "四", "五", "六"][d.getDay()]}</div>`;
      }
      html += `<div class="cal-day-item" data-date="${key}">
        <span class="cal-day-time">${e.all_day ? "全天" : `${pad(d.getHours())}:${pad(d.getMinutes())}`}</span>
        <span class="cal-day-dot" style="background:${e.color || "#6366f1"}"></span>
        <span class="cal-day-title">${escapeHtml(e.title)}</span>
      </div>`;
    });
    return html + "</div>";
  }

  /* ---------- 视图内事件绑定 ---------- */
  function wireViewEvents(box) {
    // 点击事件 → 详情
    box.querySelectorAll(".cal-event, .cal-day-item").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = el.dataset.id;
        if (id) showDetail(Number(id));
      });
    });
    // 点击日期空白 → 打开「当日详情」（过去日期回看已完成任务，今天/未来可新建）
    box.querySelectorAll("[data-date]").forEach((el) => {
      if (el.classList.contains("cal-event") || el.classList.contains("cal-day-item")) return;
      el.addEventListener("click", () => {
        const d = new Date(el.dataset.date + "T00:00:00");
        openDayDetail(d);
      });
    });
  }

  /* ---------- 当日详情浮层 ---------- */
  function openDayDetail(d) {
    detailDate = d;
    const key = ymd(d);
    document.getElementById("day-modal-title").textContent =
      `${d.getMonth() + 1}月${d.getDate()}日 周${["日", "一", "二", "三", "四", "五", "六"][d.getDay()]}`;

    // 当天完成的任务
    const dones = doneTodos.filter((t) => {
      const dd = doneDate(t.completed_at);
      return dd && ymd(dd) === key;
    });
    const doneSec = document.getElementById("day-done-section");
    const doneList = document.getElementById("day-done-list");
    if (dones.length) {
      doneSec.style.display = "";
      doneList.innerHTML = dones
        .map((t) => {
          const dd = doneDate(t.completed_at);
          const tm = dd ? `${pad(dd.getHours())}:${pad(dd.getMinutes())}` : "--:--";
          return `<div class="cal-done"><span class="cal-done-time">${tm}</span> ${escapeHtml(t.text)}</div>`;
        })
        .join("");
    } else {
      doneSec.style.display = "none";
    }

    // 当天已有事件
    const evs = events.filter((e) => ymd(fromUTC(e.start_at)) === key);
    const evList = document.getElementById("day-events-list");
    evList.innerHTML = evs.length
      ? evs
          .map((e) => {
            const t = fromUTC(e.start_at);
            return `<div class="cal-day-item" data-id="${e.id}">
              <span class="cal-day-time">${e.all_day ? "全天" : `${pad(t.getHours())}:${pad(t.getMinutes())}`}</span>
              <span class="cal-day-dot" style="background:${e.color || "#6366f1"}"></span>
              <span class="cal-day-title">${escapeHtml(e.title)}</span>
            </div>`;
          })
          .join("")
      : '<div class="cal-empty">当天没有事件</div>';
    evList.querySelectorAll("[data-id]").forEach((el) => {
      el.addEventListener("click", () => {
        closeDayDetail();
        showDetail(Number(el.dataset.id));
      });
    });

    // 过去日期：只读；今天/未来：可新建
    const isPast = key < ymd(new Date());
    document.getElementById("day-new-event").style.display = isPast ? "none" : "";
    document.getElementById("day-past-hint").style.display = isPast ? "" : "none";
    document.getElementById("day-modal").style.display = "flex";
  }

  function closeDayDetail() {
    document.getElementById("day-modal").style.display = "none";
    detailDate = null;
  }

  /* ---------- 详情浮层 ---------- */
  function showDetail(id) {
    const e = events.find((x) => x.id === id);
    if (!e) return;
    document.getElementById("ed-title").textContent = e.title;
    const d = fromUTC(e.start_at);
    let html = "";
    html += `<p>🕐 ${e.all_day ? "全天" : fmtDate(e.start_at)}${e.end_at && e.end_at !== e.start_at ? " ～ " + fmtDate(e.end_at) : ""}</p>`;
    if (e.location) html += `<p>📍 ${escapeHtml(e.location)}</p>`;
    if (e.description) html += `<p>📝 ${escapeHtml(e.description)}</p>`;
    html += `<p><span class="cal-dot" style="background:${e.color || "#6366f1"}"></span> ${e.is_local ? "本地事件" : `来自日历「${escapeHtml(e.source_name || "外部日历")}」`}</p>`;
    document.getElementById("ed-body").innerHTML = html;
    document.getElementById("event-detail").style.display = "flex";

    const editBtn = document.getElementById("ed-edit");
    if (e.is_local) {
      editBtn.style.display = "inline-block";
      editBtn.onclick = () => {
        closeDetail();
        openForm(e);
      };
    } else {
      // 外部事件只读
      editBtn.style.display = "none";
    }
    document.getElementById("ed-close").onclick = closeDetail;
    document.getElementById("event-detail").onclick = (ev) => {
      if (ev.target === document.getElementById("event-detail")) closeDetail();
    };
  }

  function closeDetail() {
    document.getElementById("event-detail").style.display = "none";
  }

  /* ---------- 编辑表单 ---------- */
  function openForm(event, prefillDate) {
    editingId = event ? event.id : null;
    document.getElementById("event-modal-title").textContent = event ? "编辑事件" : "新建事件";
    const form = document.getElementById("event-form");
    form.reset();

    if (event) {
      document.getElementById("ev-title").value = event.title;
      const s = fromUTC(event.start_at);
      const e2 = event.end_at ? fromUTC(event.end_at) : s;
      document.getElementById("ev-start").value = toLocalInput(s);
      document.getElementById("ev-end").value = toLocalInput(e2);
      document.getElementById("ev-allday").checked = !!event.all_day;
      document.getElementById("ev-location").value = event.location || "";
      document.getElementById("ev-desc").value = event.description || "";
      selectedColor = event.color || "#6366f1";
      document.getElementById("ev-delete").style.display = "inline-block";
      document.getElementById("ev-delete").onclick = () => {
        if (confirm(`确定删除事件「${event.title}」吗？`)) {
          api(`/api/calendar/events/${event.id}`, { method: "DELETE" }).then(() => {
            closeForm();
            load();
          });
        }
      };
    } else {
      document.getElementById("ev-delete").style.display = "none";
      const d = prefillDate || new Date();
      const end = new Date(d);
      end.setHours(d.getHours() + 1);
      document.getElementById("ev-start").value = toLocalInput(d);
      document.getElementById("ev-end").value = toLocalInput(end);
    }

    // 色板
    document.querySelectorAll("#ev-palette i").forEach((dot) => {
      dot.classList.toggle("sel", dot.dataset.c === selectedColor);
      dot.onclick = () => {
        selectedColor = dot.dataset.c;
        document.querySelectorAll("#ev-palette i").forEach((x) => x.classList.toggle("sel", x === dot));
      };
    });

    document.getElementById("event-modal").style.display = "flex";
  }

  function closeForm() {
    document.getElementById("event-modal").style.display = "none";
  }

  function submitForm() {
    const title = document.getElementById("ev-title").value.trim();
    if (!title) {
      alert("请填写事件标题");
      return;
    }
    const startVal = document.getElementById("ev-start").value;
    if (!startVal) {
      alert("请设置开始时间");
      return;
    }
    const body = {
      title,
      start_at: toUTC(new Date(startVal)),
      end_at: toUTC(new Date(document.getElementById("ev-end").value || startVal)),
      all_day: document.getElementById("ev-allday").checked,
      location: document.getElementById("ev-location").value.trim(),
      description: document.getElementById("ev-desc").value.trim(),
      color: selectedColor,
      remind: document.getElementById("ev-remind").value,
    };

    const req = editingId
      ? api(`/api/calendar/events/${editingId}`, { method: "PATCH", body: JSON.stringify(body) })
      : api("/api/calendar/events", { method: "POST", body: JSON.stringify(body) });

    req.then((res) => {
      if (res.error) {
        alert(res.error);
        return;
      }
      closeForm();
      load();
    });
  }

  /* ---------- 订阅面板 ---------- */
  function openSourcesModal() {
    document.getElementById("sources-modal").style.display = "flex";
    renderSourcesList();
  }

  function closeSourcesModal() {
    document.getElementById("sources-modal").style.display = "none";
    load();
  }

  function renderSourcesList() {
    const box = document.getElementById("sources-list");
    if (!sources.length) {
      box.innerHTML = '<div class="sources-empty">还没有订阅任何日历。可以添加 ICS 链接，或上传 .ics 文件。</div>';
      return;
    }
    box.innerHTML = sources
      .map((s) => {
        const time = s.last_synced_at
          ? new Date(s.last_synced_at).toLocaleString("zh-CN", { hour12: false })
          : "从未同步";
        const status =
          s.last_sync_status === "ok"
            ? '<span class="src-ok">✓ 正常</span>'
            : s.last_sync_status === "error"
            ? `<span class="src-err" title="${escapeHtml(s.last_sync_error || "")}">✗ 同步失败</span>`
            : '<span class="src-dim">未同步</span>';
        return `<div class="source-item" data-id="${s.id}">
          <span class="src-color" style="background:${s.color || "#6366f1"}"></span>
          <div class="src-info">
            <div class="src-name">${escapeHtml(s.name)}
              <button class="src-toggle ${s.enabled ? "on" : ""}" data-action="toggle">${s.enabled ? "已启用" : "已停用"}</button>
            </div>
            <div class="src-meta">${s.type === "file" ? "上传文件" : "链接"} · 最后同步：${time} ${status}</div>
          </div>
          <div class="src-actions">
            <button class="btn-plain small" data-action="sync">同步</button>
            <button class="btn-danger small" data-action="delete">删除</button>
          </div>
        </div>`;
      })
      .join("");
  }

  function wireSources() {
    document.getElementById("cal-sources-btn").addEventListener("click", openSourcesModal);
    document.getElementById("src-close").addEventListener("click", closeSourcesModal);
    document.getElementById("sources-modal").addEventListener("click", (e) => {
      if (e.target === document.getElementById("sources-modal")) closeSourcesModal();
    });

    // 标签切换
    document.querySelectorAll(".src-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".src-tab").forEach((t) => t.classList.toggle("active", t === tab));
        const isUrl = tab.dataset.tab === "url";
        document.getElementById("src-url-form").style.display = isUrl ? "" : "none";
        document.getElementById("src-file-form").style.display = isUrl ? "none" : "";
      });
    });

    // 添加 URL 订阅
    document.getElementById("src-url-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const url = document.getElementById("src-url").value.trim();
      const name = document.getElementById("src-url-name").value.trim();
      if (!url) {
        alert("请填写 ICS 订阅地址");
        return;
      }
      const res = await api("/api/calendar/sources", {
        method: "POST",
        body: JSON.stringify({ url, name, color: selectedSourceColor }),
      });
      if (res.error) {
        alert(res.error);
        return;
      }
      document.getElementById("src-url").value = "";
      document.getElementById("src-url-name").value = "";
      await loadSources();
      renderSourcesList();
      if (res.sync_error) alert(`已添加，但首次同步失败：${res.sync_error}`);
      else alert("✓ 添加成功并已同步");
      load();
    });

    // 上传 .ics
    document.getElementById("src-file-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = document.getElementById("src-file").files[0];
      if (!file) {
        alert("请选择 .ics 文件");
        return;
      }
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", document.getElementById("src-file-name").value.trim());
      const res = await fetch("/api/calendar/sources/upload", { method: "POST", body: fd });
      const j = await res.json();
      if (j.error) {
        alert(j.error);
        return;
      }
      document.getElementById("src-file").value = "";
      document.getElementById("src-file-name").value = "";
      await loadSources();
      renderSourcesList();
      if (j.sync_error) alert(`已导入，但同步失败：${j.sync_error}`);
      else alert("✓ 导入成功");
      load();
    });

    // 来源列表操作（启用/同步/删除）
    document.getElementById("sources-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const item = e.target.closest(".source-item");
      const sid = Number(item.dataset.id);
      const action = btn.dataset.action;

      if (action === "toggle") {
        const src = sources.find((s) => s.id === sid);
        await api(`/api/calendar/sources/${sid}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: !src.enabled }),
        });
        await loadSources();
        renderSourcesList();
      } else if (action === "sync") {
        btn.textContent = "同步中…";
        const res = await api(`/api/calendar/sources/${sid}/sync`, { method: "POST" });
        btn.textContent = "同步";
        alert(res.ok ? "✓ 同步完成" : `同步失败：${res.error || "未知错误"}`);
        await loadSources();
        renderSourcesList();
        load();
      } else if (action === "delete") {
        const src = sources.find((s) => s.id === sid);
        if (!confirm(`确定删除日历「${src.name}」吗？它的事件也会被移除。`)) return;
        await api(`/api/calendar/sources/${sid}`, { method: "DELETE" });
        await loadSources();
        renderSourcesList();
        load();
      }
    });

    // 同步全部
    document.getElementById("src-sync-all").addEventListener("click", async () => {
      const btn = document.getElementById("src-sync-all");
      btn.textContent = "同步中…";
      const res = await api("/api/calendar/sync-all", { method: "POST" });
      btn.textContent = "🔄 同步全部";
      const okCount = res.results ? res.results.filter((r) => r.ok).length : 0;
      const failCount = res.results ? res.results.length - okCount : 0;
      alert(`同步完成：成功 ${okCount} 个${failCount ? `，失败 ${failCount} 个` : ""}`);
      await loadSources();
      renderSourcesList();
      load();
    });

    // 筛选
    document.getElementById("cal-filter").addEventListener("change", (e) => {
      filter = e.target.value;
      load();
    });
  }

  /* ---------- 大小周设置 UI ---------- */
  function updateWorkdayUI() {
    const bigBtn = document.getElementById("wk-big");
    const smallBtn = document.getElementById("wk-small");
    const status = document.getElementById("wk-status");
    if (!bigBtn || !smallBtn) return;
    const isBig = workdays && workdays.anchor_type === "big";
    bigBtn.classList.toggle("active", isBig);
    smallBtn.classList.toggle("active", !isBig);
    if (status) {
      status.textContent =
        workdays && workdays.anchor_monday
          ? `${workdays.anchor_monday.slice(5).replace("-", "月")}日起为${
              isBig ? "大周" : "小周"
            }，之后每周自动交替`
          : "";
    }
  }

  /* ---------- 已完成任务切换按钮 ---------- */
  function updateDoneBtn() {
    const btn = document.getElementById("cal-done-toggle");
    if (btn) btn.classList.toggle("active", showDone);
  }

  async function setWorkdayType(type) {
    if (!workdays || !workdays.anchor_monday) return;
    workdays = await api("/api/workdays", {
      method: "PUT",
      body: JSON.stringify({ anchor_monday: workdays.anchor_monday, anchor_type: type }),
    });
    updateWorkdayUI();
    render();
  }

  /* ---------- 初始化 ---------- */
  function init() {
    // 视图切换
    document.querySelectorAll(".cal-view-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentView = btn.dataset.view;
        document.querySelectorAll(".cal-view-btn").forEach((b) => b.classList.toggle("active", b === btn));
        if (currentView === "list") anchor = new Date();
        load();
      });
    });

    document.getElementById("cal-prev").addEventListener("click", () => navigate(-1));
    document.getElementById("cal-next").addEventListener("click", () => navigate(1));
    document.getElementById("cal-today").addEventListener("click", () => {
      anchor = new Date();
      load();
    });
    document.getElementById("cal-add").addEventListener("click", () => openForm(null));
    document.getElementById("ev-cancel").addEventListener("click", closeForm);
    document.getElementById("event-form").addEventListener("submit", (e) => {
      e.preventDefault();
      submitForm();
    });

    // 大小周排班切换
    const wkBig = document.getElementById("wk-big");
    const wkSmall = document.getElementById("wk-small");
    if (wkBig) wkBig.addEventListener("click", () => setWorkdayType("big"));
    if (wkSmall) wkSmall.addEventListener("click", () => setWorkdayType("small"));

    // 已完成任务叠加显示切换
    const doneBtn = document.getElementById("cal-done-toggle");
    if (doneBtn) {
      doneBtn.addEventListener("click", () => {
        showDone = !showDone;
        localStorage.setItem("cal-show-done", showDone ? "1" : "0");
        updateDoneBtn();
        render();
      });
    }
    updateDoneBtn();

    // 当日详情浮层
    document.getElementById("day-modal-close").addEventListener("click", closeDayDetail);
    document.getElementById("day-modal").addEventListener("click", (e) => {
      if (e.target.id === "day-modal") closeDayDetail();
    });
    document.getElementById("day-new-event").addEventListener("click", () => {
      closeDayDetail();
      if (detailDate) openForm(null, detailDate);
    });

    // 订阅面板色板
    selectedSourceColor = "#6366f1";
    document.querySelectorAll("#src-palette i").forEach((dot) => {
      dot.classList.toggle("sel", dot.dataset.c === selectedSourceColor);
      dot.onclick = () => {
        selectedSourceColor = dot.dataset.c;
        document.querySelectorAll("#src-palette i").forEach((x) => x.classList.toggle("sel", x === dot));
      };
    });

    wireSources();

    // 路由到日历页时刷新
    window.addEventListener("hashchange", () => {
      if (location.hash === "#/calendar") load();
    });

    load();
  }

  return { init };
})();
