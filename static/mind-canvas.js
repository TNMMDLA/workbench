/* =====================================================
   MIND CANVAS · 灵感画布交互层（原生 JS 版）
   -----------------------------------------------------
   设计目标（对应重构需求）：
   - 统一交互状态机 CanvasMode，任何时刻只有一个主状态
   - 全部使用 Pointer Events + setPointerCapture，鼠标/触摸统一
   - 屏幕坐标 ⇄ 画布世界坐标 严格分离，统一转换函数
   - 选择/多选/框选、拖动、缩放、创建、编辑、复制粘贴、
     撤销重做、自动保存、快捷键、层级、触摸双指缩放
   ===================================================== */

window.MindCanvas = (function () {
  "use strict";

  /* ================= 常量 ================= */
  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 2.5;
  const DRAG_THRESHOLD = 4;      // 像素：小于此距离视为"点击"
  const SAVE_DEBOUNCE = 800;     // 文字编辑防抖保存 ms
  const STEP = 1;                // 方向键移动像素（画布坐标）
  const STEP_BIG = 10;

  /* ================= 状态 ================= */
  const state = {
    mode: "idle",               // idle|panning|selecting|dragging|editing
    viewport: { x: 200, y: 100, zoom: 1 },
    selectedIds: new Set(),
    activeCardId: null,
    editingCardId: null,
    dragStart: null,            // {x, y} 屏幕坐标
    selectionBox: null,         // {startX,startY,endX,endY} 屏幕坐标
    spaceDown: false,
    // 临时交互数据（禁止保存到后端）
    pointerId: null,
    pointerType: null,
    panStart: null,             // 平移起始（viewport + 指针屏幕坐标）
    dragCards: null,            // [{id, startX, startY}]
    moved: false,
    pinch: null,                // 双指 {dist, zoom, cx, cy}
    saveStatus: "saved",        // saved|saving|error
    saveTimer: null,
  };

  let cards = [];               // 画布节点（含连线拓扑）
  let clipboard = null;         // 内部剪贴板（复制粘贴）
  let pasteOffset = 0;          // 连续粘贴偏移累加
  let history = [];             // 撤销栈（快照）
  let historyIndex = -1;        // 当前历史位置
  let maxHistory = 60;

  /* ================= DOM ================= */
  let container = null;
  let svg = null;
  let world = null;
  let rootEl = null;            // 放编辑框/框选框的容器
  let editorEl = null;          // 文字编辑框
  let boxEl = null;             // 框选框
  let saveStatusEl = null;

  /* ================= 坐标转换 ================= */
  function screenToCanvas(sx, sy) {
    const rect = svg.getBoundingClientRect();
    return {
      x: (sx - rect.left - state.viewport.x) / state.viewport.zoom,
      y: (sy - rect.top - state.viewport.y) / state.viewport.zoom,
    };
  }
  function canvasToScreen(cx, cy) {
    const rect = svg.getBoundingClientRect();
    return {
      x: cx * state.viewport.zoom + state.viewport.x + rect.left,
      y: cy * state.viewport.zoom + state.viewport.y + rect.top,
    };
  }

  /* ================= 数据访问 ================= */
  function getCard(id) {
    return cards.find((c) => c.id === id);
  }
  function childrenOf(id) {
    return cards.filter((c) => c.parent_id === id);
  }
  function isTextInput(target) {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  /* ================= 自动保存 ================= */
  async function api(url, options = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    return res.json();
  }

  function setSaveStatus(s) {
    state.saveStatus = s;
    if (saveStatusEl) {
      saveStatusEl.textContent =
        s === "saved" ? "✓ 已保存" : s === "saving" ? "保存中…" : "⚠ 保存失败";
      saveStatusEl.className = "save-status " + s;
    }
  }

  // 操作结束后的批量保存（拖动/缩放/层级/删除/复制等）
  async function persist() {
    setSaveStatus("saving");
    try {
      await api("/api/mind/batch", {
        method: "POST",
        body: JSON.stringify({ updates: cards.map((c) => ({
          id: c.id, x: c.x, y: c.y, width: c.width, height: c.height,
          z_index: c.z_index, color: c.color || "", font_size: c.font_size || 13,
        })) }),
      });
      setSaveStatus("saved");
    } catch (e) {
      setSaveStatus("error");
    }
  }

  /* ================= 历史（撤销/重做） ================= */
  function snapshot() {
    return JSON.stringify(cards.map((c) => ({ ...c })));
  }
  function pushHistory() {
    // 丢弃当前历史位置之后的记录
    history = history.slice(0, historyIndex + 1);
    history.push(snapshot());
    if (history.length > maxHistory) history.shift();
    historyIndex = history.length - 1;
  }
  function applySnapshot(snap) {
    const data = JSON.parse(snap);
    cards = data;
    render();
    persist();
  }
  function undo() {
    if (historyIndex > 0) {
      historyIndex--;
      applySnapshot(history[historyIndex]);
    }
  }
  function redo() {
    if (historyIndex < history.length - 1) {
      historyIndex++;
      applySnapshot(history[historyIndex]);
    }
  }

  /* ================= 渲染 ================= */
  function render() {
    if (!world) return;

    // 排序：z_index 越高画得越靠后（视觉在最上层）
    const sorted = [...cards].sort((a, b) => (a.z_index || 0) - (b.z_index || 0));

    // 连线（画在节点下面）
    let htmlEdges = "";
    cards.forEach((c) => {
      if (c.parent_id === 0 || !getCard(c.parent_id)) return;
      const p = getCard(c.parent_id);
      const mx = (p.x + c.x) / 2;
      htmlEdges += `<path class="mind-edge" d="M ${p.x} ${p.y} C ${mx} ${p.y}, ${mx} ${c.y}, ${c.x} ${c.y}"/>`;
    });

    // 节点
    let htmlNodes = "";
    sorted.forEach((c) => {
      const w = c.width || 200;
      const h = c.height || 90;
      const fs = c.font_size || 13;
      const selected = state.selectedIds.has(c.id) ? " selected" : "";
      const isActive = state.activeCardId === c.id ? " active" : "";
      const fill = c.color || (c.id === 1 ? "url(#nodeGrad)" : undefined);
      const fillAttr = fill ? ` fill="${fill}"` : "";
      const strokeAttr = c.id === 1 && !c.color ? ' stroke="var(--accent)"' : "";
      htmlNodes += `
        <g class="mind-node${selected}${isActive}" data-id="${c.id}" data-z="${c.z_index || 0}">
          <rect x="${c.x - w / 2}" y="${c.y - h / 2}" width="${w}" height="${h}" rx="10"${fillAttr}${strokeAttr}/>
          <text x="${c.x}" y="${c.y + fs / 2.5}" text-anchor="middle" font-size="${fs}">${escapeXml(c.text || "")}</text>
          <text class="mind-btn btn-add" x="${c.x + w / 2 + 16}" y="${c.y - 6}">＋</text>
          ${c.id !== 1 ? `<text class="mind-btn btn-del" x="${c.x - w / 2 - 16}" y="${c.y + 5}">✕</text>` : ""}
        </g>`;
    });

    world.innerHTML = htmlEdges + htmlNodes;
    updateWorldTransform();

    // 悬停按钮显示
    world.querySelectorAll(".mind-node").forEach((g) => {
      const add = g.querySelector(".btn-add");
      const del = g.querySelector(".btn-del");
      g.addEventListener("mouseenter", () => {
        if (state.mode === "editing") return;
        add.style.opacity = "1";
        if (del) del.style.opacity = "1";
      });
      g.addEventListener("mouseleave", () => {
        add.style.opacity = "0";
        if (del) del.style.opacity = "0";
      });
    });
  }

  function updateWorldTransform() {
    world.setAttribute(
      "transform",
      `translate(${state.viewport.x}, ${state.viewport.y}) scale(${state.viewport.zoom})`
    );
  }

  function escapeXml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ================= 视图（平移/缩放） ================= */
  function panBy(dx, dy) {
    state.viewport.x += dx;
    state.viewport.y += dy;
    updateWorldTransform();
  }

  function zoomAt(sx, sy, factor) {
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.viewport.zoom * factor));
    const rect = svg.getBoundingClientRect();
    const px = sx - rect.left;
    const py = sy - rect.top;
    const canvas = screenToCanvas(sx, sy);
    state.viewport.zoom = newZoom;
    state.viewport.x = px - canvas.x * newZoom;
    state.viewport.y = py - canvas.y * newZoom;
    updateWorldTransform();
  }

  function resetView() {
    state.viewport = { x: 200, y: 100, zoom: 1 };
    updateWorldTransform();
  }

  /* ================= 选择 ================= */
  function selectOnly(id) {
    state.selectedIds = new Set([id]);
    state.activeCardId = id;
  }
  function toggleSelect(id) {
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
    state.activeCardId = id;
  }
  function clearSelection() {
    state.selectedIds = new Set();
    state.activeCardId = null;
  }

  /* ================= 框选 ================= */
  function renderSelectionBox() {
    if (!state.selectionBox) {
      boxEl.style.display = "none";
      return;
    }
    const b = state.selectionBox;
    const left = Math.min(b.startX, b.endX);
    const top = Math.min(b.startY, b.endY);
    const w = Math.abs(b.endX - b.startX);
    const h = Math.abs(b.endY - b.startY);
    const rect = svg.getBoundingClientRect();
    boxEl.style.display = "block";
    boxEl.style.left = left - rect.left + "px";
    boxEl.style.top = top - rect.top + "px";
    boxEl.style.width = w + "px";
    boxEl.style.height = h + "px";
  }

  function applySelectionBox(shift, ctrl) {
    const b = state.selectionBox;
    if (!b) return;
    const rect = svg.getBoundingClientRect();
    const c1 = screenToCanvas(b.startX, b.startY);
    const c2 = screenToCanvas(b.endX, b.endY);
    const left = Math.min(c1.x, c2.x);
    const right = Math.max(c1.x, c2.x);
    const top = Math.min(c1.y, c2.y);
    const bottom = Math.max(c1.y, c2.y);

    const hit = cards.filter((c) => {
      const w = (c.width || 200) / 2;
      const h = (c.height || 90) / 2;
      return c.x + w >= left && c.x - w <= right && c.y + h >= top && c.y - h <= bottom;
    });

    if (ctrl) {
      hit.forEach((c) => toggleSelect(c.id));
    } else if (shift) {
      hit.forEach((c) => state.selectedIds.add(c.id));
      if (hit.length) state.activeCardId = hit[hit.length - 1].id;
    } else {
      state.selectedIds = new Set(hit.map((c) => c.id));
      if (hit.length) state.activeCardId = hit[hit.length - 1].id;
    }
  }

  /* ================= 编辑卡片 ================= */
  function startEditing(id) {
    if (state.mode === "editing") commitEditing();
    const card = getCard(id);
    if (!card) return;
    state.mode = "editing";
    state.editingCardId = id;
    state.selectedIds = new Set([id]);
    state.activeCardId = id;

    // 在节点位置放一个 HTML 编辑框
    const rect = svg.getBoundingClientRect();
    const sp = canvasToScreen(card.x, card.y);
    const w = (card.width || 200) * state.viewport.zoom;
    const h = (card.height || 90) * state.viewport.zoom;

    editorEl.style.display = "block";
    editorEl.style.left = sp.x - rect.left - w / 2 + "px";
    editorEl.style.top = sp.y - rect.top - h / 2 + "px";
    editorEl.style.width = w + "px";
    editorEl.style.height = h + "px";
    editorEl.style.fontSize = Math.max(12, (card.font_size || 13) * state.viewport.zoom) + "px";
    editorEl.value = card.text || "";
    editorEl.focus();
    editorEl.select();
    render();
  }

  function commitEditing() {
    if (state.mode !== "editing" || state.editingCardId == null) return;
    const id = state.editingCardId;
    const card = getCard(id);
    const newText = editorEl.value.trim();
    const oldText = card.text;
    if (newText && newText !== oldText) {
      card.text = newText;
      pushHistory();
      persist();
    } else if (!newText) {
      // 空内容：保持原文字
      editorEl.value = card.text || "";
    }
    editorEl.style.display = "none";
    state.editingCardId = null;
    state.mode = "idle";
    render();
  }

  function cancelEditing() {
    editorEl.style.display = "none";
    state.editingCardId = null;
    state.mode = "idle";
    render();
  }

  /* ================= 创建卡片 ================= */
  async function createCard(cx, cy) {
    const res = await api("/api/mind/cards", {
      method: "POST",
      body: JSON.stringify({ x: Math.round(cx), y: Math.round(cy), parent_id: 1 }),
    });
    pushHistory();
    await reloadData();
    selectOnly(res.id);
    startEditing(res.id);
  }

  /* ================= 删除 ================= */
  async function deleteSelected() {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    pushHistory();
    await api("/api/mind/batch-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    clearSelection();
    await reloadData();
  }

  /* ================= 复制 / 粘贴 ================= */
  function copySelection() {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    const cardsData = ids
      .map((id) => getCard(id))
      .filter(Boolean)
      .map((c) => ({ ...c }));
    // 记录相对中心的位置
    const cx = cardsData.reduce((s, c) => s + c.x, 0) / cardsData.length;
    const cy = cardsData.reduce((s, c) => s + c.y, 0) / cardsData.length;
    clipboard = cardsData.map((c) => ({ ...c, relX: c.x - cx, relY: c.y - cy }));
    pasteOffset = 0;
  }

  async function pasteClipboard() {
    if (!clipboard || !clipboard.length) return;
    pasteOffset += 20;
    const ids = clipboard.map((c) => c.id);
    const dx = pasteOffset;
    const dy = pasteOffset;
    const res = await api("/api/mind/duplicate", {
      method: "POST",
      body: JSON.stringify({ ids, dx, dy }),
    });
    pushHistory();
    state.selectedIds = new Set(res.new_ids);
    if (res.new_ids.length) state.activeCardId = res.new_ids[res.new_ids.length - 1];
    await reloadData();
  }

  async function quickDuplicate() {
    if (!state.selectedIds.size) return;
    const ids = [...state.selectedIds];
    const res = await api("/api/mind/duplicate", {
      method: "POST",
      body: JSON.stringify({ ids, dx: 20, dy: 20 }),
    });
    pushHistory();
    state.selectedIds = new Set(res.new_ids);
    if (res.new_ids.length) state.activeCardId = res.new_ids[res.new_ids.length - 1];
    await reloadData();
  }

  /* ================= 层级 ================= */
  async function changeZ(ids, mode) {
    const sorted = [...cards].sort((a, b) => (a.z_index || 0) - (b.z_index || 0));
    const maxZ = cards.reduce((m, c) => Math.max(m, c.z_index || 0), 0);
    const minZ = cards.reduce((m, c) => Math.min(m, c.z_index || 0), 0);
    const idSet = new Set(ids);

    if (mode === "top") {
      sorted.forEach((c, i) => { if (idSet.has(c.id)) c.z_index = maxZ + 1 + i; });
    } else if (mode === "bottom") {
      let j = 0;
      sorted.forEach((c, i) => { if (idSet.has(c.id)) { c.z_index = minZ - 1 - j; j++; } });
    } else if (mode === "up") {
      sorted.forEach((c) => { if (idSet.has(c.id)) c.z_index = (c.z_index || 0) + 1; });
    } else if (mode === "down") {
      sorted.forEach((c) => { if (idSet.has(c.id)) c.z_index = (c.z_index || 0) - 1; });
    }
    pushHistory();
    persist();
    render();
  }

  /* ================= 数据加载 ================= */
  async function reloadData() {
    const data = await api("/api/data");
    cards = (data.mind || []).map((n) => ({
      id: n.id,
      parent_id: n.parent_id,
      text: n.text,
      x: n.x != null ? n.x : 0,
      y: n.y != null ? n.y : 0,
      width: n.width || 200,
      height: n.height || 90,
      color: n.color || "",
      font_size: n.font_size || 13,
      z_index: n.z_index || 0,
    }));
    render();
  }

  /* ================= 指针事件 ================= */
  function handlePointerDown(e) {
    if (state.mode === "editing") {
      // 点击编辑框外部 → 提交并退出编辑
      if (e.target === container || e.target === svg || e.target.closest(".mind-node")) {
        commitEditing();
      }
      return;
    }

    // 优先级：卡片内部按钮 → 卡片 → 空白
    const addBtn = e.target.closest ? e.target.closest(".btn-add") : null;
    const delBtn = e.target.closest ? e.target.closest(".btn-del") : null;

    // 中键 或 空格+左键 → 平移
    if (e.button === 1 || (e.button === 0 && state.spaceDown)) {
      e.preventDefault();
      beginPan(e);
      return;
    }

    const nodeG = e.target.closest ? e.target.closest(".mind-node") : null;

    if (nodeG && !addBtn && !delBtn) {
      const id = Number(nodeG.dataset.id);
      const card = getCard(id);
      // 左键按下卡片：准备拖动/选择
      state.pointerId = e.pointerId;
      state.pointerType = e.pointerType;
      state.dragStart = { x: e.clientX, y: e.clientY };
      state.moved = false;

      // 选中逻辑（在 pointerup 时按移动距离决定点击还是拖动）
      if (!state.selectedIds.has(id)) {
        if (e.ctrlKey || e.metaKey) {
          toggleSelect(id);
        } else if (e.shiftKey) {
          state.selectedIds.add(id);
          state.activeCardId = id;
        } else {
          selectOnly(id);
        }
      } else if (e.ctrlKey || e.metaKey) {
        toggleSelect(id);
      } else {
        state.activeCardId = id;
      }

      // 记录待拖动卡片的初始位置
      state.dragCards = [...state.selectedIds]
        .map((sid) => {
          const c = getCard(sid);
          return c ? { id: sid, startX: c.x, startY: c.y } : null;
        })
        .filter(Boolean);

      // 捕获指针，防止移出画布后丢失
      try { container.setPointerCapture(e.pointerId); } catch (err) {}
      render();
      return;
    }

    // 空白区域：平移或框选（pointerup 时按距离区分）
    if (!addBtn && !delBtn) {
      state.pointerId = e.pointerId;
      state.pointerType = e.pointerType;
      state.dragStart = { x: e.clientX, y: e.clientY };
      state.moved = false;
      state.panStart = { vx: state.viewport.x, vy: state.viewport.y, px: e.clientX, py: e.clientY };
      try { container.setPointerCapture(e.pointerId); } catch (err) {}
    }
  }

  function beginPan(e) {
    state.mode = "panning";
    state.pointerId = e.pointerId;
    state.pointerType = e.pointerType;
    state.panStart = { vx: state.viewport.x, vy: state.viewport.y, px: e.clientX, py: e.clientY };
    container.classList.add("panning");
    try { container.setPointerCapture(e.pointerId); } catch (err) {}
    render();
  }

  function handlePointerMove(e) {
    if (state.mode === "editing") return;

    // 双指手势（触摸）
    if (e.pointerType === "touch" && state.pointerId != null && e.pointerId !== state.pointerId) {
      handlePinch(e);
      return;
    }

    if (state.pointerId == null || e.pointerId !== state.pointerId) return;
    const dx = e.clientX - state.dragStart.x;
    const dy = e.clientY - state.dragStart.y;
    if (!state.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
      state.moved = true;
    }

    if (state.mode === "panning") {
      state.viewport.x = state.panStart.vx + (e.clientX - state.panStart.px);
      state.viewport.y = state.panStart.vy + (e.clientY - state.panStart.py);
      updateWorldTransform();
      return;
    }

    if (!state.moved) return;

    if (state.dragCards) {
      // 拖动卡片（多选一起动）
      if (state.mode !== "dragging") {
        state.mode = "dragging";
        render();
      }
      const cdx = dx / state.viewport.zoom;
      const cdy = dy / state.viewport.zoom;
      state.dragCards.forEach((d) => {
        const c = getCard(d.id);
        if (c) {
          c.x = Math.round(d.startX + cdx);
          c.y = Math.round(d.startY + cdy);
        }
      });
      render();
    } else if (state.panStart && e.button !== 1) {
      // 空白拖动 → 框选（不改变视图）
      if (state.mode !== "selecting") state.mode = "selecting";
      state.selectionBox = {
        startX: state.dragStart.x,
        startY: state.dragStart.y,
        endX: e.clientX,
        endY: e.clientY,
      };
      renderSelectionBox();
    }
  }

  function handlePinch(e) {
    // 第二个手指按下：进入捏合缩放
    if (!state.pinch) {
      const p1 = { x: state.dragStart.x, y: state.dragStart.y };
      const p2 = { x: e.clientX, y: e.clientY };
      state.pinch = {
        dist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
        zoom: state.viewport.zoom,
        cx: (p1.x + p2.x) / 2,
        cy: (p1.y + p2.y) / 2,
      };
      state.mode = "panning";
      state.dragCards = null;
      state.selectionBox = null;
      boxEl.style.display = "none";
      return;
    }
    const p1 = { x: state.dragStart.x, y: state.dragStart.y };
    const p2 = { x: e.clientX, y: e.clientY };
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (state.pinch.dist > 0) {
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, state.pinch.zoom * (dist / state.pinch.dist)));
      const rect = svg.getBoundingClientRect();
      const px = state.pinch.cx - rect.left;
      const py = state.pinch.cy - rect.top;
      const canvas = screenToCanvas(state.pinch.cx, state.pinch.cy);
      state.viewport.zoom = newZoom;
      state.viewport.x = px - canvas.x * newZoom;
      state.viewport.y = py - canvas.y * newZoom;
      updateWorldTransform();
    }
  }

  function handlePointerUp(e) {
    if (state.pointerId == null || e.pointerId !== state.pointerId) return;

    const wasEditing = state.mode === "editing";
    const wasPanning = state.mode === "panning";
    const wasSelecting = state.mode === "selecting";
    const wasDragging = state.mode === "dragging";

    // 拖动结束 → 保存 + 历史
    if (wasDragging && state.dragCards) {
      pushHistory();
      persist();
    }
    // 框选结束 → 应用选择
    if (wasSelecting && state.selectionBox) {
      applySelectionBox(e.shiftKey, e.ctrlKey || e.metaKey);
    }
    // 普通点击空白（未移动）→ 清除选择
    if (!state.moved && !state.dragCards && !wasPanning && !wasSelecting && !wasEditing) {
      clearSelection();
      render();
    }

    // 清理临时状态
    state.mode = "idle";
    state.pointerId = null;
    state.pointerType = null;
    state.dragStart = null;
    state.panStart = null;
    state.dragCards = null;
    state.selectionBox = null;
    state.pinch = null;
    boxEl.style.display = "none";
    container.classList.remove("panning");
    render();
  }

  function handlePointerCancel(e) {
    // 指针丢失（窗口失焦/系统接管）→ 强制清理，避免卡死
    if (state.pointerId == null || e.pointerId !== state.pointerId) return;
    if (state.mode === "dragging" && state.dragCards) {
      // 拖动被取消：不保存位置
    }
    state.mode = "idle";
    state.pointerId = null;
    state.dragStart = null;
    state.panStart = null;
    state.dragCards = null;
    state.selectionBox = null;
    state.pinch = null;
    boxEl.style.display = "none";
    container.classList.remove("panning");
    render();
  }

  /* ================= 滚轮 ================= */
  function handleWheel(e) {
    // 编辑文字时不响应
    if (state.mode === "editing") return;

    // Ctrl/Cmd + 滚轮 → 缩放（以鼠标为锚点）
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
      return;
    }
    // 普通滚轮 → 平移画布（垂直；Shift → 水平）
    e.preventDefault();
    const dx = e.shiftKey ? e.deltaY : 0;
    const dy = e.shiftKey ? 0 : e.deltaY;
    state.viewport.x -= dx;
    state.viewport.y -= dy;
    updateWorldTransform();
  }

  /* ================= 键盘 ================= */
  function handleKeyDown(e) {
    // 输入框内：交给输入框
    if (isTextInput(e.target)) return;
    // 中文输入法合成期间：不触发快捷键
    if (e.isComposing) return;

    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((ctrl && e.key.toLowerCase() === "z" && e.shiftKey) || (ctrl && e.key.toLowerCase() === "y")) { e.preventDefault(); redo(); return; }
    if (ctrl && e.key.toLowerCase() === "c") { e.preventDefault(); copySelection(); return; }
    if (ctrl && e.key.toLowerCase() === "v") { e.preventDefault(); pasteClipboard(); return; }
    if (ctrl && e.key.toLowerCase() === "d") { e.preventDefault(); quickDuplicate(); return; }
    if (ctrl && e.key.toLowerCase() === "a") { e.preventDefault(); state.selectedIds = new Set(cards.map((c) => c.id)); render(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); return; }
    if (e.key === "Escape") { handleEscape(); return; }
    if (e.key === "Enter") {
      if (state.activeCardId != null) { e.preventDefault(); startEditing(state.activeCardId); }
      return;
    }
    if (e.key.toLowerCase() === "n") { e.preventDefault(); createCard(state.viewport.x / state.viewport.zoom + 400, state.viewport.y / state.viewport.zoom + 300); return; }
    // 方向键微调
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      if (!state.selectedIds.size) return;
      const step = e.shiftKey ? STEP_BIG : STEP;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      state.selectedIds.forEach((id) => {
        const c = getCard(id);
        if (c) { c.x += dx; c.y += dy; }
      });
      pushHistory();
      render();
      // 防抖保存
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(persist, SAVE_DEBOUNCE);
      return;
    }
  }

  function handleKeyUp(e) {
    if (e.code === "Space") state.spaceDown = false;
  }

  function handleEscape() {
    if (state.mode === "editing") { cancelEditing(); return; }
    if (state.mode === "selecting" || state.mode === "dragging") {
      state.mode = "idle";
      state.dragCards = null;
      state.selectionBox = null;
      boxEl.style.display = "none";
      render();
      return;
    }
    if (state.selectedIds.size) { clearSelection(); render(); }
  }

  /* ================= 工具栏动作 ================= */
  function wireToolbar() {
    const $ = (id) => document.getElementById(id);

    // 新建
    $("t-new").addEventListener("click", () => {
      const rect = svg.getBoundingClientRect();
      const c = screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
      createCard(c.x, c.y);
    });

    // 删除所选
    $("t-del").addEventListener("click", () => deleteSelected());

    // 层级
    $("t-top").addEventListener("click", () => changeZ([...state.selectedIds], "top"));
    $("t-bottom").addEventListener("click", () => changeZ([...state.selectedIds], "bottom"));
    $("t-up").addEventListener("click", () => changeZ([...state.selectedIds], "up"));
    $("t-down").addEventListener("click", () => changeZ([...state.selectedIds], "down"));

    // 撤销 / 重做
    $("t-undo").addEventListener("click", () => undo());
    $("t-redo").addEventListener("click", () => redo());

    // 缩放
    $("t-zoom-in").addEventListener("click", () => {
      const rect = svg.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.1);
    });
    $("t-zoom-out").addEventListener("click", () => {
      const rect = svg.getBoundingClientRect();
      zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.1);
    });
    $("t-reset").addEventListener("click", () => resetView());

    // 字号 / 颜色（作用于选中卡片）
    $("t-font-up").addEventListener("click", async () => {
      if (!state.selectedIds.size) return alert("请先选中卡片");
      const updates = [...state.selectedIds].map((id) => ({
        id, font_size: Math.min(30, (getCard(id).font_size || 13) + 2),
      }));
      updates.forEach((u) => (getCard(u.id).font_size = u.font_size));
      pushHistory();
      await api("/api/mind/batch", { method: "POST", body: JSON.stringify({ updates }) });
      render();
    });
    $("t-font-down").addEventListener("click", async () => {
      if (!state.selectedIds.size) return alert("请先选中卡片");
      const updates = [...state.selectedIds].map((id) => ({
        id, font_size: Math.max(10, (getCard(id).font_size || 13) - 2),
      }));
      updates.forEach((u) => (getCard(u.id).font_size = u.font_size));
      pushHistory();
      await api("/api/mind/batch", { method: "POST", body: JSON.stringify({ updates }) });
      render();
    });

    // 色板
    document.querySelectorAll(".t-palette i").forEach((dot) => {
      dot.addEventListener("click", async () => {
        if (!state.selectedIds.size) return alert("请先选中卡片");
        const color = dot.dataset.c || "";
        const updates = [...state.selectedIds].map((id) => ({ id, color }));
        updates.forEach((u) => (getCard(u.id).color = u.color));
        pushHistory();
        await api("/api/mind/batch", { method: "POST", body: JSON.stringify({ updates }) });
        render();
      });
    });

    // 清空
    $("t-clear").addEventListener("click", async () => {
      if (!confirm("确定清空画布所有卡片吗？（只保留中心卡片）")) return;
      pushHistory();
      await api("/api/mind/clear", { method: "POST" });
      clearSelection();
      await reloadData();
    });
  }

  /* ================= 初始化 / 销毁 ================= */
  function init(options) {
    container = options.container;
    svg = options.svg;
    world = options.world;
    rootEl = options.root; // mind-container
    saveStatusEl = options.saveStatus;

    // 创建编辑框和框选框
    editorEl = document.createElement("textarea");
    editorEl.className = "mind-editor";
    editorEl.style.display = "none";
    container.appendChild(editorEl);
    editorEl.addEventListener("blur", () => {
      // 延迟提交，避免点击按钮时先触发 blur
      setTimeout(() => commitEditing(), 100);
    });
    editorEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); cancelEditing(); }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEditing(); }
    });
    // 编辑中防抖保存（每次变更立即更新本地 + 防抖持久化）
    editorEl.addEventListener("input", () => {
      const card = getCard(state.editingCardId);
      if (card) {
        card.text = editorEl.value;
        render();
        clearTimeout(state.saveTimer);
        state.saveTimer = setTimeout(() => {
          api("/api/mind/batch", {
            method: "POST",
            body: JSON.stringify({ updates: [{ id: card.id, text: card.text }] }),
          }).then(() => setSaveStatus("saved")).catch(() => setSaveStatus("error"));
        }, SAVE_DEBOUNCE);
      }
    });

    boxEl = document.createElement("div");
    boxEl.className = "mind-selection-box";
    boxEl.style.display = "none";
    container.appendChild(boxEl);

    // 指针事件（统一处理鼠标/触摸）
    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("pointermove", handlePointerMove);
    container.addEventListener("pointerup", handlePointerUp);
    container.addEventListener("pointercancel", handlePointerCancel);
    container.addEventListener("lostpointercapture", handlePointerCancel);
    container.addEventListener("wheel", handleWheel, { passive: false });

    // 空格键平移
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !isTextInput(e.target)) {
        e.preventDefault();
        state.spaceDown = true;
        container.classList.add("space-down");
      }
    });
    window.addEventListener("keyup", handleKeyUp);

    // 全局快捷键
    window.addEventListener("keydown", handleKeyDown);

    // 双击：空白创建卡片 / 卡片进入编辑
    container.addEventListener("dblclick", (e) => {
      if (state.mode === "editing") return;
      const nodeG = e.target.closest ? e.target.closest(".mind-node") : null;
      if (nodeG) {
        e.stopPropagation();
        startEditing(Number(nodeG.dataset.id));
        return;
      }
      // 双击空白 → 创建
      const c = screenToCanvas(e.clientX, e.clientY);
      createCard(c.x, c.y);
    });

    wireToolbar();

    // 初始数据
    reloadData();
  }

  function destroy() {
    // 提供出口：页面常驻时不会调用，但保证可清理
    if (!container) return;
    container.removeEventListener("pointerdown", handlePointerDown);
    container.removeEventListener("pointermove", handlePointerMove);
    container.removeEventListener("pointerup", handlePointerUp);
    container.removeEventListener("pointercancel", handlePointerCancel);
    container.removeEventListener("lostpointercapture", handlePointerCancel);
    container.removeEventListener("wheel", handleWheel);
    container.removeEventListener("dblclick", null);
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keyup", handleKeyUp);
  }

  return { init, destroy, reloadData };
})();
