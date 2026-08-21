/* =====================================================
   FILES · 文件暂存（阶段 4）
   功能：拖拽/点击/多文件上传（进度条）、搜索筛选排序、
        下载、编辑备注标签过期、删除/批量删除、分享链接
   ===================================================== */

window.Files = (function () {
  "use strict";

  let selectedForBatch = new Set();

  async function api(url, options = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    return res.json();
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }

  function fmtDate(iso) {
    if (!iso) return "永不过期";
    const d = new Date(iso);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fileIcon(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) return "🖼️";
    if (["mp4", "mov", "avi", "mkv"].includes(ext)) return "🎬";
    if (["mp3", "wav", "flac", "m4a"].includes(ext)) return "🎵";
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "🗜️";
    if (["pdf"].includes(ext)) return "📄";
    if (["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(ext)) return "📊";
    if (["txt", "md", "log", "csv", "json"].includes(ext)) return "📝";
    return "📦";
  }

  /* ---------- 加载列表 ---------- */
  async function loadList() {
    const search = document.getElementById("file-search").value.trim();
    const type = document.getElementById("file-type").value;
    const sort = document.getElementById("file-sort").value;
    const q = new URLSearchParams({ search, type, sort });
    const data = await api(`/api/files?${q}`);
    renderList(data.files || []);
    loadStats();
  }

  function renderList(files) {
    const box = document.getElementById("files-list");
    if (!files.length) {
      box.innerHTML = '<div class="files-empty">还没有文件，拖拽或点击上传第一个文件吧</div>';
      return;
    }
    box.innerHTML = files
      .map((f) => {
        const expired = f.expires_at && new Date(f.expires_at) < new Date();
        const status = expired
          ? '<span class="f-status err">已过期</span>'
          : f.status === "active"
          ? '<span class="f-status ok">正常</span>'
          : '<span class="f-status dim">已删除</span>';
        const checked = selectedForBatch.has(f.id) ? " checked" : "";
        return `<div class="file-item" data-id="${f.id}">
          <label class="file-check"><input type="checkbox" class="f-select${checked}" data-id="${f.id}" /></label>
          <span class="file-ico">${fileIcon(f.original_name)}</span>
          <div class="file-info">
            <div class="file-name">${escapeHtml(f.original_name)} ${f.active_shares ? `<span class="f-share-badge">🔗${f.active_shares}</span>` : ""}</div>
            <div class="file-meta">${fmtSize(f.size)} · ${f.mime_type || "未知类型"} · 上传 ${fmtDate(f.created_at)} · 下载 ${f.download_count} 次 · 到期 ${fmtDate(f.expires_at)}</div>
            ${f.note ? `<div class="file-note">📝 ${escapeHtml(f.note)}</div>` : ""}
            ${f.tags ? `<div class="file-tags">${f.tags.split(",").map((t) => `<span class="f-tag">${escapeHtml(t.trim())}</span>`).join("")}</div>` : ""}
          </div>
          <div class="file-actions">
            <button class="btn-plain small" data-act="download">下载</button>
            <button class="btn-plain small" data-act="edit">编辑</button>
            <button class="btn-plain small" data-act="share">分享</button>
            <button class="btn-danger small" data-act="delete">删除</button>
          </div>
        </div>`;
      })
      .join("");
  }

  async function loadStats() {
    try {
      const s = await api("/api/files/stats");
      document.getElementById("files-stats").innerHTML =
        `📦 ${s.file_count} 个文件 · 已用 ${s.used_mb}MB / ${s.limit_mb}MB` +
        (s.expiring_count ? ` · ⚠️ ${s.expiring_count} 个即将过期` : "") +
        (s.clean_failed_count ? ` · ❌ ${s.clean_failed_count} 个清理失败` : "") +
        ` · 剩余 ${s.free_mb}MB`;
    } catch (e) {
      document.getElementById("files-stats").textContent = "";
    }
  }

  /* ---------- 上传（XHR 进度） ---------- */
  function uploadFiles(fileList) {
    const note = document.getElementById("file-note").value.trim();
    const tags = document.getElementById("file-tags").value.trim();
    const expire = document.getElementById("file-expire").value;
    const progBox = document.getElementById("upload-progress");

    [...fileList].forEach((file) => {
      const item = document.createElement("div");
      item.className = "upload-item";
      item.innerHTML = `<span class="up-name">${escapeHtml(file.name)}</span>
        <div class="up-bar"><div class="up-fill" style="width:0%"></div></div>
        <span class="up-pct">0%</span>`;
      progBox.appendChild(item);
      const fill = item.querySelector(".up-fill");
      const pct = item.querySelector(".up-pct");

      const fd = new FormData();
      fd.append("file", file);
      fd.append("note", note);
      fd.append("tags", tags);
      fd.append("expire", expire);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/files/upload");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.round((e.loaded / e.total) * 100);
          fill.style.width = p + "%";
          pct.textContent = p + "%";
        }
      };
      xhr.onload = () => {
        if (xhr.status === 200) {
          fill.style.width = "100%";
          pct.textContent = "✓";
          item.classList.add("ok");
        } else {
          let msg = "上传失败";
          try {
            msg = JSON.parse(xhr.responseText).error || msg;
          } catch (e) {}
          pct.textContent = "✗";
          item.classList.add("err");
          item.querySelector(".up-name").title = msg;
          item.querySelector(".up-name").textContent = file.name + "（" + msg + "）";
        }
        loadList();
      };
      xhr.onerror = () => {
        pct.textContent = "✗";
        item.classList.add("err");
      };
      xhr.send(fd);
    });
  }

  /* ---------- 事件绑定 ---------- */
  function wire() {
    // 拖拽 / 点击
    const zone = document.getElementById("drop-zone");
    const input = document.getElementById("file-input");
    zone.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      uploadFiles(input.files);
      input.value = "";
    });
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drag");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drag");
      uploadFiles(e.dataTransfer.files);
    });

    // 搜索/筛选/排序
    let searchTimer = null;
    document.getElementById("file-search").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadList, 300);
    });
    document.getElementById("file-type").addEventListener("change", loadList);
    document.getElementById("file-sort").addEventListener("change", loadList);

    // 列表操作
    document.getElementById("files-list").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const item = e.target.closest(".file-item");
      const fid = Number(item.dataset.id);
      const act = btn.dataset.act;

      if (act === "download") {
        window.open(`/api/files/${fid}/download`, "_blank");
      } else if (act === "delete") {
        const name = item.querySelector(".file-name").textContent.trim();
        if (!confirm(`确定删除文件「${name}」吗？`)) return;
        await api(`/api/files/${fid}`, { method: "DELETE" });
        loadList();
      } else if (act === "edit") {
        openEdit(fid);
      } else if (act === "share") {
        openShare(fid);
      }
    });

    // 多选
    document.getElementById("files-list").addEventListener("change", (e) => {
      if (e.target.classList.contains("f-select")) {
        const id = Number(e.target.dataset.id);
        if (e.target.checked) selectedForBatch.add(id);
        else selectedForBatch.delete(id);
        document.getElementById("file-batch-del").disabled = selectedForBatch.size === 0;
      }
    });
    document.getElementById("file-batch-del").addEventListener("click", async () => {
      if (!selectedForBatch.size) return;
      if (!confirm(`确定删除选中的 ${selectedForBatch.size} 个文件吗？`)) return;
      await api("/api/files/batch-delete", {
        method: "POST",
        body: JSON.stringify({ ids: [...selectedForBatch] }),
      });
      selectedForBatch.clear();
      document.getElementById("file-batch-del").disabled = true;
      loadList();
    });
  }

  /* ---------- 编辑弹窗 ---------- */
  let editFid = null;
  function openEdit(fid) {
    editFid = fid;
    // 从列表拿当前信息（简化：重新查询）
    document.getElementById("fe-name").textContent = "正在加载…";
    document.getElementById("file-edit-modal").style.display = "flex";
    loadFileInfo(fid);
  }
  async function loadFileInfo(fid) {
    const data = await api("/api/files");
    const f = (data.files || []).find((x) => x.id === fid);
    if (!f) return;
    document.getElementById("fe-name").textContent = f.original_name;
    document.getElementById("fe-note").value = f.note || "";
    document.getElementById("fe-tags").value = f.tags || "";
    document.getElementById("fe-expire").value = "";
  }
  function closeEdit() {
    document.getElementById("file-edit-modal").style.display = "none";
  }

  /* ---------- 分享弹窗 ---------- */
  let shareFid = null;
  function openShare(fid) {
    shareFid = fid;
    document.getElementById("share-file-name").textContent = "文件 #" + fid;
    document.getElementById("share-result").innerHTML = "";
    document.getElementById("share-modal").style.display = "flex";
    (async () => {
      const d = await api("/api/files");
      const f = (d.files || []).find((x) => x.id === fid);
      if (f) document.getElementById("share-file-name").textContent = f.original_name;
      loadShareList(fid);
    })();
  }

  // 已有分享列表
  async function loadShareList(fid) {
    const box = document.getElementById("share-list");
    try {
      const data = await api(`/api/files/${fid}/shares`);
      const shares = data.shares || [];
      if (!shares.length) {
        box.innerHTML = '<p class="share-hint">还没有分享链接</p>';
        return;
      }
      const statusText = {
        active: '<span class="f-status ok">使用中</span>',
        expired: '<span class="f-status err">已过期</span>',
        exhausted: '<span class="f-status err">次数用完</span>',
        revoked: '<span class="f-status dim">已撤销</span>',
      };
      box.innerHTML = `<p class="share-hint">已有分享：</p>` + shares
        .map((s) => {
          const created = new Date(s.created_at).toLocaleString("zh-CN", { hour12: false });
          const expires = s.expires_at ? new Date(s.expires_at).toLocaleString("zh-CN", { hour12: false }) : "永久";
          const limit = s.max_downloads >= 0 ? `${s.download_count}/${s.max_downloads} 次` : `${s.download_count} 次`;
          return `<div class="share-item">
            <div class="share-item-info">
              <div>创建 ${created} · 到期 ${expires}</div>
              <div>已下载 ${limit} ${statusText[s.status] || ""}</div>
            </div>
            ${s.status === "active" ? `<button class="btn-danger small" data-sid="${s.id}" data-act="revoke">撤销</button>` : ""}
          </div>`;
        })
        .join("");
      // 撤销
      box.querySelectorAll("[data-act='revoke']").forEach((btn) => {
        btn.addEventListener("click", async () => {
          if (!confirm("确定撤销这个分享链接吗？之后将无法下载。")) return;
          await api(`/api/files/shares/${btn.dataset.sid}`, { method: "DELETE" });
          loadShareList(shareFid);
        });
      });
    } catch (e) {
      box.innerHTML = "";
    }
  }

  function closeShare() {
    document.getElementById("share-modal").style.display = "none";
  }

  function wireModals() {
    document.getElementById("fe-cancel").addEventListener("click", closeEdit);
    document.getElementById("fe-save").addEventListener("click", async () => {
      const body = {
        note: document.getElementById("fe-note").value.trim(),
        tags: document.getElementById("fe-tags").value.trim(),
      };
      const exp = document.getElementById("fe-expire").value;
      if (exp) {
        const hours = { "1h": 1, "1d": 24, "7d": 168, "30d": 720 }[exp];
        body.expires_at = new Date(Date.now() + hours * 3600 * 1000).toISOString();
      } else {
        body.expires_at = null;
      }
      await api(`/api/files/${editFid}`, { method: "PATCH", body: JSON.stringify(body) });
      closeEdit();
      loadList();
    });
    document.getElementById("fe-expire").addEventListener("change", (e) => {
      const exp = e.target.value;
      const hours = { "1h": 1, "1d": 24, "7d": 168, "30d": 720 }[exp];
      if (hours) {
        const d = new Date(Date.now() + hours * 3600 * 1000);
        if (!confirm(`确定设为 ${exp} 后过期吗？（${d.toLocaleString("zh-CN")}）`)) {
          e.target.value = "";
        }
      }
    });

    document.getElementById("share-cancel").addEventListener("click", closeShare);
    document.getElementById("share-create").addEventListener("click", async () => {
      const hours = Number(document.getElementById("share-hours").value);
      const max = Number(document.getElementById("share-max").value);
      const res = await api(`/api/files/${shareFid}/share`, {
        method: "POST",
        body: JSON.stringify({ hours, max_downloads: max }),
      });
      if (res.error) {
        document.getElementById("share-result").innerHTML = `<span class="err">${escapeHtml(res.error)}</span>`;
        return;
      }
      document.getElementById("share-result").innerHTML = `
        <p>✅ 分享链接已生成：</p>
        <div class="share-link-box">
          <input type="text" value="${escapeHtml(res.url)}" readonly />
          <button class="btn-primary" id="share-copy">复制</button>
        </div>
        <p class="share-hint">${hours}h 内有效${max > 0 ? ` · 最多下载 ${max} 次` : " · 不限次数"} · 可在下方列表随时撤销</p>`;
      document.getElementById("share-copy").addEventListener("click", () => {
        const input = document.querySelector("#share-result input");
        input.select();
        document.execCommand("copy");
        alert("已复制分享链接");
      });
      loadShareList(shareFid);
    });

    document.getElementById("file-edit-modal").addEventListener("click", (e) => {
      if (e.target === document.getElementById("file-edit-modal")) closeEdit();
    });
    document.getElementById("share-modal").addEventListener("click", (e) => {
      if (e.target === document.getElementById("share-modal")) closeShare();
    });
  }

  /* ---------- 初始化 ---------- */
  function init() {
    wire();
    wireModals();
    window.addEventListener("hashchange", () => {
      if (location.hash === "#/files") loadList();
    });
  }

  return { init, loadList };
})();
