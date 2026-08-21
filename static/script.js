/* =====================================================
   AQ WORKBENCH · 交互脚本 v3
   功能：问候/时钟/主题 / 待办（含今日习惯合并） / 便签 /
        番茄钟 / 每日习惯（7天/30天/12月视图+页内添加） /
        灵感导图（无限画布：平移/缩放/节点拖拽/工具栏）
   ===================================================== */

/* ---------- 小工具 ---------- */
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

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 服务器存储的时间是 UTC（如 "2026-08-06 09:30:00"），转成用户本地日期
function toLocalDateStr(utcStr) {
  if (!utcStr) return "";
  const d = new Date(utcStr.replace(" ", "T") + "Z");
  if (isNaN(d)) return "";
  return toDateStr(d);
}

/* ---------- 页面元素 ---------- */
const helloText = document.getElementById("hello-text");
const dateLine = document.getElementById("date-line");
const clock = document.getElementById("clock");
const themeToggle = document.getElementById("theme-toggle");

const todoForm = document.getElementById("todo-form");
const todoText = document.getElementById("todo-text");
const todoList = document.getElementById("todo-list");
const todoCountLabel = document.getElementById("todo-count-label");
const progressLabel = document.getElementById("progress-label");
const progressFill = document.getElementById("progress-fill");

const archiveBlock = document.getElementById("archive-block");
const archiveToggle = document.getElementById("archive-toggle");
const archiveCount = document.getElementById("archive-count");
const archiveList = document.getElementById("archive-list");

const note = document.getElementById("note");
const noteStatus = document.getElementById("note-status");

const timerDisplay = document.getElementById("timer-display");
const pomoStart = document.getElementById("pomo-start");
const pomoPause = document.getElementById("pomo-pause");
const pomoReset = document.getElementById("pomo-reset");

const habitBoard = document.getElementById("habit-board");
const habitForm = document.getElementById("habit-form");
const habitText = document.getElementById("habit-text");
const habitCountLabel = document.getElementById("habit-count-label");
const rangeSwitch = document.getElementById("range-switch");

const mindSvg = document.getElementById("mind-svg");
const mindWorld = document.getElementById("mind-world");
const mindContainer = document.getElementById("mind-container");

/* ================= 1) 主题切换 ================= */
let theme = localStorage.getItem("workbench-theme") || "dark";
applyTheme(theme);

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  themeToggle.textContent = t === "dark" ? "☀️ 浅色" : "🌙 深色";
}

themeToggle.addEventListener("click", () => {
  theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("workbench-theme", theme);
  applyTheme(theme);
});

/* ================= 主题色（强调色） ================= */
let accent = localStorage.getItem("workbench-accent") || "indigo";
applyAccent(accent);

function applyAccent(a) {
  document.documentElement.dataset.accent = a;
  document.querySelectorAll(".accent-dot").forEach((d) =>
    d.classList.toggle("active", d.dataset.accent === a)
  );
}

/* ================= 2) 时间 / 日期 / 问候 ================= */
function updateClock() {
  const now = new Date();
  clock.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}
setInterval(updateClock, 1000);
updateClock();

function updateDateLine() {
  const now = new Date();
  const wd = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const start = new Date(now.getFullYear(), 0, 1);
  const week = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
  dateLine.textContent = `${now.getMonth() + 1}月${now.getDate()}日 · 周${wd} · 第 ${week} 周`;
}
updateDateLine();

function updateHello() {
  const h = new Date().getHours();
  const hello = h < 6 ? "夜深了" : h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
  helloText.innerHTML = `${hello}，<span class="name">AQ</span>`;
}
updateHello();

/* ================= 3) 数据加载 ================= */
let state = { todos: [], habits: [], logs: [], mind: [] };
let habitRange = localStorage.getItem("workbench-habit-range") || "7";

async function loadData() {
  state = await api("/api/data");
  renderTodoArea();
  note.value = state.note;
  renderHabits();
  renderArchive();
  updateProgress();
}

/* ================= 4) 待办（含今日习惯合并） ================= */
function renderTodoArea() {
  todoList.innerHTML = "";
  const today = toDateStr(new Date());

  // 今日习惯 → 作为"习惯待办"显示在最上面
  const habitItems = state.habits.map((h) => {
    const checked = state.logs.some((l) => l.habit_id === h.id && l.date === today);
    return { id: h.id, text: `${h.emoji || "🔁"} ${h.name}`, done: checked, isHabit: true };
  });

  // 只显示：未完成 + 今天完成的。昨天及更早完成的自动隐藏（数据仍保留）
  const todayStr = toDateStr(new Date());
  const todoItems = state.todos
    .filter((t) => !t.done || (t.completed_at && toLocalDateStr(t.completed_at) === todayStr))
    .map((t) => ({ id: t.id, text: t.text, done: t.done, isHabit: false }));

  const all = [...habitItems, ...todoItems];

  if (all.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-hint";
    empty.textContent = "暂无待办，先记一件小事吧";
    todoList.appendChild(empty);
    return;
  }

  all.forEach((item) => {
    const div = document.createElement("div");
    div.className = "todo-item" + (item.isHabit ? " is-habit" : "");

    const check = document.createElement("span");
    check.className = "check" + (item.done ? " done" : "");
    check.addEventListener("click", async () => {
      if (item.isHabit) {
        await api(`/api/habits/${item.id}/toggle`, {
          method: "POST",
          body: JSON.stringify({ date: today }),
        });
      } else {
        await api(`/api/todos/${item.id}/toggle`, { method: "POST" });
      }
      await loadData();
    });

    const span = document.createElement("span");
    span.className = "t-text" + (item.done ? " done" : "");
    span.textContent = item.text;
    span.title = "双击修改内容";

    // 双击待办进入行内编辑（习惯不可编辑）
    if (!item.isHabit) {
      span.addEventListener("dblclick", () => {
        const input = document.createElement("input");
        input.className = "t-edit";
        input.value = item.text;
        input.maxLength = 500;
        div.replaceChild(input, span);
        input.focus();
        input.select();

        let finished = false;
        const finish = async (save) => {
          if (finished) return;
          finished = true;
          const val = input.value.trim();
          if (save && val && val !== item.text) {
            try {
              await api(`/api/todos/${item.id}`, {
                method: "PUT",
                body: JSON.stringify({ text: val }),
              });
            } catch (e) {
              /* 保存失败则保留原标题 */
            }
          }
          await loadData();
        };

        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            finish(false);
          }
        });
        input.addEventListener("blur", () => finish(true));
      });
    }

    const del = document.createElement("button");
    del.className = "delete-btn";
    del.textContent = "✕";
    del.title = item.isHabit ? "删除这个习惯" : "删除";
    del.addEventListener("click", async () => {
      if (item.isHabit) {
        if (!confirm(`确定删除习惯「${item.text}」吗？`)) return;
        await api(`/api/habits/${item.id}`, { method: "DELETE" });
      } else {
        await api(`/api/todos/${item.id}`, { method: "DELETE" });
      }
      await loadData();
    });

    div.append(check, span, del);
    div.dataset.todoId = item.isHabit ? "" : String(item.id);
    todoList.appendChild(div);
  });

  // 长按拖拽排序（仅待办项，不含习惯）
  setupTodoDrag();
}

/* ================= 待办拖拽排序（长按拖动） ================= */
let dragState = null;

function setupTodoDrag() {
  const items = todoList.querySelectorAll(".todo-item:not(.is-habit)");
  items.forEach((el) => {
    el.addEventListener("pointerdown", onTodoDragDown);
    el.addEventListener("pointermove", onTodoDragMove);
    el.addEventListener("pointerup", onTodoDragUp);
    el.addEventListener("pointercancel", onTodoDragUp);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

function onTodoDragDown(e) {
  if (e.target.closest(".check, .delete-btn, .t-edit")) return;
  if (e.button !== undefined && e.button !== 0) return; // 仅左键/主指针
  if (dragState) return;
  const el = e.currentTarget;
  const meta = { timer: null, startX: e.clientX, startY: e.clientY, activated: false };
  el._dragMeta = meta;
  meta.timer = setTimeout(() => {
    meta.activated = true;
    startTodoDrag(el, e.pointerId, e.clientY);
  }, 400);
}

function onTodoDragMove(e) {
  const meta = e.currentTarget._dragMeta;
  if (!meta) return;
  if (!meta.activated) {
    // 未激活：手指移动超过阈值 → 取消长按，把滚动让给页面
    if (Math.hypot(e.clientX - meta.startX, e.clientY - meta.startY) > 10) {
      if (meta.timer) { clearTimeout(meta.timer); meta.timer = null; }
    }
    return;
  }
  moveTodoDrag(e.clientY);
}

function onTodoDragUp(e) {
  const el = e.currentTarget;
  const meta = el._dragMeta;
  if (meta && meta.timer) { clearTimeout(meta.timer); meta.timer = null; }
  delete el._dragMeta;
  if (dragState && dragState.el === el) {
    if (e.type === "pointercancel") cancelTodoDrag();
    else endTodoDrag();
  }
}

function startTodoDrag(el, pointerId, startY) {
  dragState = { el, startY, insertBeforeEl: null };
  el.classList.add("dragging");
  el.style.touchAction = "none";
  if (el.setPointerCapture) { try { el.setPointerCapture(pointerId); } catch (err) {} }
  moveTodoDrag(startY);
}

function moveTodoDrag(clientY) {
  if (!dragState) return;
  const { el, startY } = dragState;
  // 被拖项视觉跟随手指
  el.style.transform = `translateY(${clientY - startY}px)`;
  // 按手指当前位置找插入位置（排除被拖项自身，它的 rect 已随 transform 变化）
  const items = [...todoList.querySelectorAll(".todo-item:not(.is-habit):not(.dragging)")];
  let insertBeforeEl = null;
  for (const it of items) {
    const r = it.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) { insertBeforeEl = it; break; }
  }
  todoList.querySelectorAll(".todo-item").forEach((it) => it.classList.remove("drag-over"));
  if (insertBeforeEl) insertBeforeEl.classList.add("drag-over");
  dragState.insertBeforeEl = insertBeforeEl;
}

function endTodoDrag() {
  if (!dragState) return;
  const { el, insertBeforeEl } = dragState;
  el.classList.remove("dragging");
  el.style.transform = "";
  el.style.touchAction = "";
  todoList.querySelectorAll(".todo-item").forEach((it) => it.classList.remove("drag-over"));
  if (insertBeforeEl && insertBeforeEl !== el && insertBeforeEl.parentNode === todoList) {
    todoList.insertBefore(el, insertBeforeEl);
  }
  persistTodoOrder().then(() => loadData()).catch(() => loadData());
  dragState = null;
}

function cancelTodoDrag() {
  if (!dragState) return;
  const { el } = dragState;
  el.classList.remove("dragging");
  el.style.transform = "";
  el.style.touchAction = "";
  todoList.querySelectorAll(".todo-item").forEach((it) => it.classList.remove("drag-over"));
  dragState = null;
  loadData(); // 重渲染恢复原位
}

function persistTodoOrder() {
  const ids = [...todoList.querySelectorAll(".todo-item:not(.is-habit)")]
    .map((el) => Number(el.dataset.todoId))
    .filter((id) => id);
  if (!ids.length) return Promise.resolve();
  return api("/api/todos/reorder", { method: "PUT", body: JSON.stringify({ ids }) });
}

/* 本月已完成折叠区：查看今天之前完成的任务（自动隐藏的那些） */
function renderArchive() {
  if (!archiveBlock) return;
  const today = toDateStr(new Date());
  const doneHidden = state.todos.filter((t) => {
    if (!t.done) return false;
    const cd = toLocalDateStr(t.completed_at);
    return cd !== today;
  });
  archiveCount.textContent = doneHidden.length;
  archiveList.innerHTML = "";
  if (doneHidden.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-hint";
    empty.textContent = "暂无已完成任务（今天完成的任务会在明天自动归档到这里）";
    archiveList.appendChild(empty);
  } else {
    doneHidden.forEach((t) => {
      const div = document.createElement("div");
      div.className = "archive-item";
      const date = document.createElement("span");
      date.className = "archive-date";
      const cd = toLocalDateStr(t.completed_at);
      date.textContent = cd ? cd.slice(5) : "--"; // MM-DD
      const text = document.createElement("span");
      text.className = "archive-text";
      text.textContent = t.text;
      div.append(date, text);
      archiveList.appendChild(div);
    });
  }
}

if (archiveToggle) {
  archiveToggle.addEventListener("click", () => {
    archiveList.classList.toggle("open");
    archiveToggle.classList.toggle("open");
  });
}

/* 今日日程（loadOverview 填充，供今日进度计算） */
let todayEvents = [];

function updateProgress() {
  const today = toDateStr(new Date());
  // 今日待办 = 今天创建的待办 ∪ 今天完成的待办
  // （当天勾选完成的任务，无论创建于何时，都计入今日进度）
  const todayTodos = state.todos.filter((t) => {
    if (toLocalDateStr(t.created_at) === today) return true;
    return t.done && toLocalDateStr(t.completed_at) === today;
  });
  const doneTodos = todayTodos.filter(
    (t) => t.done && toLocalDateStr(t.completed_at) === today
  ).length;
  // 今日习惯：全部习惯为每天任务，完成 = 今天已打卡
  const doneHabits = state.habits.filter((h) =>
    state.logs.some((l) => l.habit_id === h.id && l.date === today)
  ).length;
  // 今日日程：今天已结束的算完成
  const now = new Date();
  const doneEvents = todayEvents.filter((e) => e.end_at && new Date(e.end_at) <= now).length;
  const total = todayTodos.length + state.habits.length + todayEvents.length;
  const done = doneTodos + doneHabits + doneEvents;
  todoCountLabel.textContent = `待办 ${doneTodos}/${todayTodos.length}`;
  progressLabel.textContent = `已完成 ${done}/${total}`;
  progressFill.style.width = (total === 0 ? 0 : Math.round((done / total) * 100)) + "%";
}

todoForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = todoText.value.trim();
  if (!text) return;
  await api("/api/todos", { method: "POST", body: JSON.stringify({ text }) });
  todoText.value = "";
  todoText.focus();
  await loadData();
});

/* ================= 5) 便签（自动保存） ================= */
async function saveNote() {
  await api("/api/note", { method: "POST", body: JSON.stringify({ content: note.value }) });
  noteStatus.textContent = "✓ 已保存";
  noteStatus.className = "saved";
}

let noteTimer = null;
note.addEventListener("input", () => {
  noteStatus.textContent = "输入中…";
  noteStatus.className = "";
  clearTimeout(noteTimer);
  noteTimer = setTimeout(saveNote, 1000);
});

/* ================= 6) 番茄钟 ================= */
const POMO_SECONDS = 25 * 60;
let remaining = POMO_SECONDS;
let pomoTimer = null;
let running = false;

function renderTimer() {
  const m = String(Math.floor(remaining / 60)).padStart(2, "0");
  const s = String(remaining % 60).padStart(2, "0");
  timerDisplay.innerHTML = `${m}<span class="colon">:</span>${s}`;
}

function pomoStop() {
  clearInterval(pomoTimer);
  pomoTimer = null;
  running = false;
  pomoStart.disabled = false;
  pomoStart.textContent = "继续";
}

pomoStart.addEventListener("click", () => {
  if (running) return;
  running = true;
  pomoStart.disabled = true;
  pomoPause.disabled = false;
  pomoTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      remaining = 0;
      renderTimer();
      pomoStop();
      pomoStart.textContent = "开始";
      pomoPause.disabled = true;
      timerDisplay.innerHTML = `<span class="colon">⏰ 时间到！</span>`;
      return;
    }
    renderTimer();
  }, 1000);
});

pomoPause.addEventListener("click", () => {
  pomoStop();
  pomoPause.disabled = true;
});

pomoReset.addEventListener("click", () => {
  pomoStop();
  remaining = POMO_SECONDS;
  renderTimer();
  pomoStart.textContent = "开始";
  pomoPause.disabled = true;
});

renderTimer();

/* ================= 7) 每日习惯 ================= */

// 连续坚持天数
function calcStreak(habitId, logs) {
  const set = new Set(logs.filter((l) => l.habit_id === habitId).map((l) => l.date));
  let streak = 0;
  const d = new Date();
  if (!set.has(toDateStr(d))) d.setDate(d.getDate() - 1);
  while (set.has(toDateStr(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

// 最近 N 天日期（今天在最后）
function lastNDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d);
  }
  return days;
}

// 打卡格子（所有日期都可点，方便补卡）
function makeCell(checked, dateStr, habitId, clickable) {
  const cell = document.createElement("div");
  cell.className = "habit-cell";
  if (checked) {
    cell.classList.add("done");
    cell.textContent = "✓";
  } else {
    cell.textContent = "·";
  }
  if (clickable) {
    cell.style.cursor = "pointer";
    cell.addEventListener("click", async () => {
      await api(`/api/habits/${habitId}/toggle`, {
        method: "POST",
        body: JSON.stringify({ date: dateStr }),
      });
      await loadData();
    });
  }
  return cell;
}

// 表格视图（7 天 / 30 天）
function renderHabitTable(days) {
  const todayStr = toDateStr(new Date());
  const tight = days.length > 7;

  const table = document.createElement("table");
  table.className = "habit-table" + (tight ? " tight" : "");

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const nameTh = document.createElement("th");
  nameTh.textContent = "习惯";
  nameTh.style.textAlign = "left";
  headRow.appendChild(nameTh);
  days.forEach((d) => {
    const th = document.createElement("th");
    const wd = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
    th.textContent = tight ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getMonth() + 1}/${d.getDate()} ${wd}`;
    if (toDateStr(d) === todayStr) th.className = "today-col";
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  state.habits.forEach((habit) => {
    const set = new Set(state.logs.filter((l) => l.habit_id === habit.id).map((l) => l.date));
    const streak = calcStreak(habit.id, state.logs);

    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    nameTd.className = "habit-name";
    nameTd.innerHTML = `${habit.emoji || "🔁"} ${habit.name} <span class="streak">🔥${streak}</span>`;
    const del = document.createElement("span");
    del.className = "del-habit";
    del.textContent = "✕";
    del.title = "删除";
    del.addEventListener("click", async () => {
      if (!confirm(`确定删除习惯「${habit.name}」吗？`)) return;
      await api(`/api/habits/${habit.id}`, { method: "DELETE" });
      await loadData();
    });
    nameTd.appendChild(del);
    tr.appendChild(nameTd);

    days.forEach((d) => {
      const dateStr = toDateStr(d);
      const td = document.createElement("td");
      const isToday = dateStr === todayStr;
      if (isToday) td.className = "today-cell";
      td.appendChild(makeCell(set.has(dateStr), dateStr, habit.id, true));
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  habitBoard.appendChild(table);
}

// 月度总览（最近 12 个月）
function renderHabitYear() {
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  // 每个习惯每个月的打卡次数
  const countMap = {}; // habit_id -> { "YYYY-MM": n }
  state.logs.forEach((l) => {
    const ym = l.date.slice(0, 7);
    if (!countMap[l.habit_id]) countMap[l.habit_id] = {};
    countMap[l.habit_id][ym] = (countMap[l.habit_id][ym] || 0) + 1;
  });

  const grid = document.createElement("div");
  grid.className = "month-grid";

  // 表头行
  const headRow = document.createElement("div");
  headRow.className = "month-row";
  const headName = document.createElement("span");
  headName.className = "month-name";
  headName.textContent = "习惯";
  headRow.appendChild(headName);
  months.forEach((m) => {
    const c = document.createElement("span");
    c.className = "month-cell";
    c.textContent = `${m.month}月`;
    c.style.fontWeight = "600";
    headRow.appendChild(c);
  });
  grid.appendChild(headRow);

  // 每个习惯一行
  state.habits.forEach((habit) => {
    const streak = calcStreak(habit.id, state.logs);
    const row = document.createElement("div");
    row.className = "month-row";

    const name = document.createElement("span");
    name.className = "month-name";
    name.innerHTML = `${habit.emoji || "🔁"} ${habit.name} <span class="streak">🔥${streak}</span>`;
    const del = document.createElement("span");
    del.className = "del-habit";
    del.textContent = "✕";
    del.addEventListener("click", async () => {
      if (!confirm(`确定删除习惯「${habit.name}」吗？`)) return;
      await api(`/api/habits/${habit.id}`, { method: "DELETE" });
      await loadData();
    });
    name.appendChild(del);
    row.appendChild(name);

    const habitCounts = countMap[habit.id] || {};
    months.forEach((m) => {
      const ym = `${m.year}-${String(m.month).padStart(2, "0")}`;
      const n = habitCounts[ym] || 0;
      // 该月天数（当月取已过天数）
      let totalDays;
      if (m.year === now.getFullYear() && m.month === now.getMonth() + 1) {
        totalDays = now.getDate();
      } else {
        totalDays = new Date(m.year, m.month, 0).getDate();
      }
      const ratio = totalDays === 0 ? 0 : n / totalDays;

      const cell = document.createElement("span");
      cell.className = "month-cell" + (ratio >= 0.8 ? " lv3" : ratio >= 0.45 ? " lv2" : ratio > 0 ? " lv1" : "");
      cell.textContent = `${n}天`;
      cell.title = `${m.year}年${m.month}月：打卡 ${n}/${totalDays} 天`;
      row.appendChild(cell);
    });

    grid.appendChild(row);
  });

  habitBoard.appendChild(grid);
}

function renderHabits() {
  habitCountLabel.textContent = `${state.habits.length} 项长期任务`;
  habitBoard.innerHTML = "";

  if (state.habits.length === 0) {
    const hint = document.createElement("div");
    hint.className = "habit-empty";
    hint.textContent = "还没有每日习惯，在下方输入框添加一个吧（如：📖 每天学英语）";
    habitBoard.appendChild(hint);
    return;
  }

  // 同步切换按钮状态
  document.querySelectorAll(".range-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.range === habitRange);
  });

  if (habitRange === "year") {
    renderHabitYear();
  } else {
    renderHabitTable(lastNDays(Number(habitRange)));
  }
}

// 范围切换
rangeSwitch.addEventListener("click", (e) => {
  const btn = e.target.closest(".range-btn");
  if (!btn) return;
  habitRange = btn.dataset.range;
  localStorage.setItem("workbench-habit-range", habitRange);
  renderHabits();
});

// 页面内添加习惯（不弹窗）
habitForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = habitText.value.trim();
  if (!raw) return;

  // 自动识别开头的 emoji（如 "📖 每天学英语"）
  const emojiMatch = raw.match(/\p{Extended_Pictographic}/u);
  let emoji = emojiMatch ? emojiMatch[0] : "🔁";
  const name = raw.replace(emoji, "").trim();
  if (!name) return;

  await api("/api/habits", {
    method: "POST",
    body: JSON.stringify({ name, emoji }),
  });
  habitText.value = "";
  habitText.focus();
  await loadData();
});

/* ================= 8) 灵感导图 ================= */
/* ================= 启动 ================= */
loadData();
Calendar.init();
Files.init();
Notifications.init();

/* ================= 阶段 1：hash 路由 ================= */
const PAGES = ["dashboard", "calendar", "files", "notifications", "settings"];

function showPage(name) {
  document.querySelectorAll(".page").forEach((p) => (p.style.display = "none"));
  const el = document.getElementById("page-" + name);
  if (el) {
    el.style.display = "block";
    // 重新播放切换动画
    el.classList.remove("page-anim");
    void el.offsetWidth;
    el.classList.add("page-anim");
  }
  document.querySelectorAll("#nav-links a").forEach((a) =>
    a.classList.toggle("active", a.dataset.page === name)
  );
  if (name === "dashboard") {
    loadOverview();
    loadData();
  }
  if (name === "settings") loadSettings();
}

/* ================= 设置页 ================= */
function fmtSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(2) + " MB";
  return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

async function loadSettings() {
  // 1) 保留期下拉
  document.querySelectorAll(".setting-select[data-key]").forEach((sel) => {
    if (!sel.dataset.bound) {
      sel.dataset.bound = "1";
      sel.addEventListener("change", async () => {
        const hint = document.getElementById("settings-save-hint");
        const name = sel.options[sel.selectedIndex].text;
        if (hint) hint.textContent = "保存中…";
        try {
          await api("/api/settings", {
            method: "PUT",
            body: JSON.stringify({ [sel.dataset.key]: Number(sel.value) }),
          });
          if (hint) {
            hint.textContent = `✅ 已保存：${name}`;
            setTimeout(() => (hint.textContent = ""), 3500);
          }
        } catch (e) {
          if (hint) hint.textContent = "❌ 保存失败，请重试";
        }
      });
    }
  });
  try {
    const s = await api("/api/settings");
    document.querySelectorAll(".setting-select[data-key]").forEach((sel) => {
      const v = s[sel.dataset.key];
      if (v != null) sel.value = String(v);
    });
  } catch (e) {
    /* 离线时保持当前值 */
  }

  // 2) 存储占用
  try {
    const st = await api("/api/storage");
    document.getElementById("storage-total").textContent = fmtSize(st.total);
    document.getElementById("storage-detail").textContent =
      `数据库 ${fmtSize(st.db_size)} ＋ 上传文件 ${fmtSize(st.uploads_size)}（${st.upload_file_count} 个）`;
    const rows = [
      ["📋", "待办", st.counts.todos],
      ["🔁", "打卡记录", st.counts.habit_logs],
      ["🔔", "通知", st.counts.notifications],
      ["📅", "日历事件", st.counts.calendar_events],
      ["📁", "暂存文件", st.counts.stored_files],
      ["⚙️", "后台任务", st.counts.background_jobs],
    ];
    document.getElementById("storage-list").innerHTML = rows
      .map(
        ([e, n, c]) =>
          `<div class="storage-row"><span class="storage-name">${e} ${n}</span><span class="storage-count">${c} 条</span></div>`
      )
      .join("");
  } catch (e) {
    document.getElementById("storage-total").textContent = "统计失败";
  }

  // 3) 主题色选择
  const picker = document.getElementById("accent-picker");
  if (picker && !picker.dataset.bound) {
    picker.dataset.bound = "1";
    picker.addEventListener("click", (e) => {
      const btn = e.target.closest(".accent-dot");
      if (!btn) return;
      accent = btn.dataset.accent;
      localStorage.setItem("workbench-accent", accent);
      applyAccent(accent);
    });
  }
  applyAccent(accent);
}

function route() {
  const hash = location.hash.replace(/^#\/?/, "") || "dashboard";
  showPage(PAGES.includes(hash) ? hash : "dashboard");
}

window.addEventListener("hashchange", route);
route();

/* ================= 在线/离线状态 ================= */
const offlineBar = document.getElementById("offline-bar");

function updateNetStatus() {
  const el = document.getElementById("net-status");
  const on = navigator.onLine;
  el.textContent = on ? "● 在线" : "○ 离线";
  el.classList.toggle("offline", !on);
  if (on) {
    if (offlineBar.style.display !== "none") {
      offlineBar.textContent = "✅ 网络已恢复，正在刷新数据";
      offlineBar.classList.add("ok");
      setTimeout(() => {
        offlineBar.style.display = "none";
        offlineBar.classList.remove("ok");
      }, 2500);
      loadData();
    }
  } else {
    offlineBar.textContent = "当前处于离线模式，显示的是最近缓存的数据。";
    offlineBar.classList.remove("ok");
    offlineBar.style.display = "block";
  }
}
window.addEventListener("online", updateNetStatus);
window.addEventListener("offline", updateNetStatus);
updateNetStatus();

/* ================= PWA：注册 / 更新 / 安装 ================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // 新版本检测
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            // 有已激活的旧 SW + 新 SW 安装完成 → 提示更新
            document.getElementById("update-bar").style.display = "flex";
          }
        });
      });
    });
  });
}

// 更新横幅按钮
document.getElementById("update-now").addEventListener("click", async () => {
  document.getElementById("update-bar").style.display = "none";
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg && reg.waiting) {
    reg.waiting.postMessage({ type: "SKIP_WAITING" });
  }
});
document.getElementById("update-later").addEventListener("click", () => {
  document.getElementById("update-bar").style.display = "none";
});

// SW 收到 SKIP_WAITING 后激活并刷新
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "SKIP_WAITING") {
      // 由 sw.js 内的 message 监听完成 skipWaiting，这里等 controllerchange
    }
  });
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

/* ---------- 安装提示（Android/桌面） ---------- */
let deferredPrompt = null;
const installBtn = document.getElementById("install-btn");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.style.display = "inline-block";
});
installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  if (choice.outcome === "accepted") {
    installBtn.style.display = "none";
  }
  deferredPrompt = null;
});
// 已安装则隐藏
window.addEventListener("appinstalled", () => {
  installBtn.style.display = "none";
});

/* ---------- iOS 添加到主屏幕提示 ---------- */
(function iosHint() {
  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const standalone = window.navigator.standalone === true;
  if (isIOS && !standalone) {
    // 首次访问显示提示（记住）
    if (!localStorage.getItem("ios-hint-shown")) {
      setTimeout(() => {
        if (confirm("📱 点击底部「分享」按钮，选择「添加到主屏幕」，即可像 App 一样使用工作台！")) {
          localStorage.setItem("ios-hint-shown", "1");
        }
      }, 1500);
    }
  }
})();

/* ================= 首页概览卡 ================= */
async function loadOverview() {
  try {
    const data = await api("/api/overview");
    todayEvents = data.today_events || [];

    // 今日日程
    const todayEl = document.getElementById("overview-today");
    if (data.today_events && data.today_events.length) {
      todayEl.innerHTML = data.today_events
        .slice(0, 3)
        .map((e) => {
          const t = new Date(e.start_at);
          const time = e.all_day
            ? "全天"
            : `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
          return `<div class="overview-event"><span class="t">${e.title}</span><span class="time">${time}</span></div>`;
        })
        .join("");
    } else {
      todayEl.textContent = "今天还没有日程";
    }

    // 最近文件
    const filesEl = document.getElementById("overview-files");
    if (data.recent_files && data.recent_files.length) {
      filesEl.innerHTML = data.recent_files
        .slice(0, 3)
        .map((f) => `<div class="overview-file"><span class="t">${f.name}</span></div>`)
        .join("");
    } else {
      filesEl.textContent = "暂无文件";
    }

    // 未读通知
    const notifEl = document.getElementById("overview-notifications");
    const unread = data.unread_notifications || 0;
    notifEl.textContent = unread > 0 ? `有 ${unread} 条未读通知` : "暂无通知";
    const bellCount = document.getElementById("bell-count");
    if (unread > 0) {
      bellCount.textContent = unread > 99 ? "99+" : unread;
      bellCount.style.display = "flex";
    } else {
      bellCount.style.display = "none";
    }
  } catch (e) {
    // 概览失败不影响主功能
  }
  // 今日日程数据就绪后，刷新今日进度（含日程部分）
  updateProgress();
}

// 铃铛浮层（显示最近通知）
const bellBtn = document.getElementById("bell-btn");
const bellPopup = document.getElementById("bell-popup");
bellBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const show = bellPopup.style.display === "none";
  bellPopup.style.display = show ? "block" : "none";
  if (show) loadBellPopup();
});
document.addEventListener("click", () => {
  bellPopup.style.display = "none";
});

async function loadBellPopup() {
  try {
    const data = await api("/api/notifications?limit=5");
    const body = document.getElementById("bell-popup-body");
    const items = data.notifications || [];
    body.innerHTML = items.length
      ? items
          .map((n) => {
            const meta = n.level === "error" ? "❌" : n.level === "warning" ? "⚠️" : n.level === "success" ? "✅" : "ℹ️";
            return `<div class="bell-popup-item${n.is_read ? "" : " unread"}">${meta} ${escapeHtml(n.title)}</div>`;
          })
          .join("")
      : "暂无通知";
    if (window.Notifications) Notifications.updateBellBadge(data.unread || 0);
  } catch (e) {
    document.getElementById("bell-popup-body").textContent = "加载失败";
  }
}
