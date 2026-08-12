const $ = (id) => document.getElementById(id);

const state = {
  tracks: { a: null, b: null },
  trackSep: null,
  page: "join",
  fusionMode: "vocal_swap",
  cutA: 75,
  cutB: 0,
  autoCut: true,
  running: {},
  format: { join: "mp3", fusion: "mp3" },
};

function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ================= 页面切换 ================= */
function setPage(page) {
  state.page = page;
  document.querySelectorAll(".nav-tab").forEach((t) => t.classList.toggle("active", t.dataset.page === page));
  ["join", "fusion", "separate"].forEach((p) => {
    $(`page-${p}`).hidden = p !== page;
  });
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
}

/* ================= GPU 状态 ================= */
async function checkHealth() {
  try {
    const r = await fetch("/api/health");
    const d = await r.json();
    $("gpu-status").classList.add("ok");
    $("gpu-text").textContent = d.device === "cuda" ? "GPU 加速已就绪" : "CPU 模式（分离会偏慢）";
  } catch {
    $("gpu-status").classList.add("err");
    $("gpu-text").textContent = "服务未连接";
  }
}

/* ================= 波形绘制 ================= */
function drawWave(canvas, peaks, color = "#1db954") {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  const h = canvas.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!peaks || !peaks.length) return;
  const n = peaks.length;
  const step = w / n;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = i * step + step / 2;
    const amp = Math.max(0.02, peaks[i]) * (h * 0.42);
    ctx.moveTo(x, h / 2 - amp);
    ctx.lineTo(x, h / 2 + amp);
  }
  ctx.stroke();
  ctx.strokeStyle = color + "30";
  ctx.lineWidth = 4;
  ctx.stroke();
}

function redrawAllWaves() {
  if (state.tracks.a) {
    drawWave($("wave-a"), state.tracks.a.meta.peaks);
    drawWave($("fusion-wave-a"), state.tracks.a.meta.peaks);
  }
  if (state.tracks.b) {
    drawWave($("wave-b"), state.tracks.b.meta.peaks, "#4d9de0");
    drawWave($("fusion-wave-b"), state.tracks.b.meta.peaks, "#4d9de0");
  }
  if (state.trackSep) drawWave($("wave-sep"), state.trackSep.meta.peaks);
  updateTimelineUI();
}

/* ================= 时间线 ================= */
function currentCutA() {
  return state.autoCut ? 75 : state.cutA;
}

function currentCutB() {
  return state.autoCut ? 0 : state.cutB;
}

function drawTimeline(canvasId, markerId, timeId, peaks, pct, editable, color, duration) {
  const canvas = $(canvasId);
  drawWave(canvas, peaks || [], color);
  const marker = $(markerId);
  const time = $(timeId);
  marker.style.left = `${pct}%`;
  time.style.left = `${pct}%`;
  time.textContent = editable ? fmtTime((duration || 0) * (pct / 100)) : "自动";
  marker.style.background = editable ? color : "#5a5a5a";
  marker.style.boxShadow = editable ? `0 0 8px ${color}` : "none";
}

function updateTimelineUI() {
  drawTimeline("tl-a", "marker-a", "time-a", state.tracks.a?.meta.peaks, currentCutA(), !state.autoCut, "#1db954", state.tracks.a?.meta.duration);
  drawTimeline("tl-b", "marker-b", "time-b", state.tracks.b?.meta.peaks, currentCutB(), !state.autoCut, "#4d9de0", state.tracks.b?.meta.duration);
}

function bindTimelineDrag(canvasId, setter, min, max) {
  const canvas = $(canvasId);
  let dragging = false;

  function move(e) {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.min(max, Math.max(min, pct));
    setter(pct);
    updateTimelineUI();
  }

  canvas.addEventListener("mousedown", (e) => {
    if (state.autoCut) return;
    dragging = true;
    canvas.style.cursor = "grabbing";
    move(e);
  });
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = "crosshair";
  });
}

/* ================= 上传 ================= */
const TRACK_UI = {
  a: [
    { title: "title-a", drop: "drop-a", wave: "wave-a", meta: "meta-a", remove: "remove-a", file: "file-a" },
    { title: "fusion-title-a", drop: "fusion-drop-a", wave: "fusion-wave-a", meta: "fusion-meta-a", remove: "fusion-remove-a", file: "fusion-file-a" },
  ],
  b: [
    { title: "title-b", drop: "drop-b", wave: "wave-b", meta: "meta-b", remove: "remove-b", file: "file-b" },
    { title: "fusion-title-b", drop: "fusion-drop-b", wave: "fusion-wave-b", meta: "fusion-meta-b", remove: "fusion-remove-b", file: "fusion-file-b" },
  ],
};

function bindDropzone(slot, ui) {
  const { drop, file, remove } = ui;
  $(drop).addEventListener("click", () => $(file).click());
  $(file).addEventListener("change", () => $(file).files[0] && uploadTrack(slot, $(file).files[0]));
  ["dragover", "dragenter"].forEach((ev) =>
    $(drop).addEventListener(ev, (e) => {
      e.preventDefault();
      $(drop).classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    $(drop).addEventListener(ev, (e) => {
      e.preventDefault();
      $(drop).classList.remove("dragover");
    })
  );
  $(drop).addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) uploadTrack(slot, f);
  });
  $(remove).addEventListener("click", () => clearTrack(slot));
}

async function uploadTrack(slot, file) {
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    if (!r.ok) {
      const err = await r.json();
      throw new Error(err.detail || "上传失败");
    }
    const data = await r.json();
    state.tracks[slot] = data;
    renderTrack(slot, data);
    updateRunBtns();
  } catch (err) {
    alert(`上传失败：${err.message}`);
  }
}

function renderTrack(slot, data) {
  TRACK_UI[slot].forEach((ui) => {
    $(ui.title).textContent = data.name;
    $(ui.drop).classList.add("hidden");
    $(ui.remove).hidden = false;
    $(ui.meta).hidden = false;
    $(ui.wave).hidden = false;
    $(ui.meta).innerHTML = [
      `<span class="meta-chip">时长 <b>${fmtTime(data.meta.duration)}</b></span>`,
      `<span class="meta-chip">BPM <b>${data.meta.bpm}</b></span>`,
      `<span class="meta-chip">调性 <b>${data.meta.key}</b></span>`,
    ].join("");
  });
  redrawAllWaves();
}

function clearTrack(slot) {
  state.tracks[slot] = null;
  TRACK_UI[slot].forEach((ui) => {
    $(ui.title).textContent = slot === "a" ? "歌曲 A" : "歌曲 B";
    $(ui.drop).classList.remove("hidden");
    $(ui.wave).hidden = true;
    $(ui.meta).hidden = true;
    $(ui.remove).hidden = true;
    $(ui.file).value = "";
  });
  redrawAllWaves();
  updateRunBtns();
}

/* ================= 分离页上传 ================= */
function bindSepUpload() {
  const drop = $("drop-sep");
  const file = $("file-sep");
  drop.addEventListener("click", () => file.click());
  file.addEventListener("change", () => file.files[0] && uploadSep(file.files[0]));
  ["dragover", "dragenter"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("dragover");
    })
  );
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) uploadSep(f);
  });
  $("remove-sep").addEventListener("click", () => {
    state.trackSep = null;
    $("drop-sep").classList.remove("hidden");
    $("wave-sep").hidden = true;
    $("meta-sep").hidden = true;
    $("remove-sep").hidden = true;
    $("title-sep").textContent = "上传要分离的歌曲";
    $("file-sep").value = "";
    updateRunBtns();
  });
}

async function uploadSep(file) {
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    if (!r.ok) {
      const err = await r.json();
      throw new Error(err.detail || "上传失败");
    }
    const data = await r.json();
    state.trackSep = data;
    $("drop-sep").classList.add("hidden");
    $("wave-sep").hidden = false;
    $("meta-sep").hidden = false;
    $("remove-sep").hidden = false;
    $("title-sep").textContent = data.name;
    drawWave($("wave-sep"), data.meta.peaks);
    $("meta-sep").innerHTML = [
      `<span class="meta-chip">时长 <b>${fmtTime(data.meta.duration)}</b></span>`,
      `<span class="meta-chip">BPM <b>${data.meta.bpm}</b></span>`,
      `<span class="meta-chip">调性 <b>${data.meta.key}</b></span>`,
    ].join("");
    updateRunBtns();
  } catch (err) {
    alert(`上传失败：${err.message}`);
  }
}

/* ================= 按钮状态 ================= */
function updateRunBtns() {
  $("join-btn").disabled = state.running.join || !state.tracks.a || !state.tracks.b;
  $("fusion-btn").disabled = state.running.fusion || !state.tracks.a || !state.tracks.b;
  $("sep-btn").disabled = state.running.sep || !state.trackSep;
}

/* ================= 任务轮询 ================= */
async function runTask(page, endpoint, payload, ui) {
  state.running[page] = true;
  updateRunBtns();
  $(ui.progress).hidden = false;
  $(ui.result).hidden = true;
  setProgress(ui, 0, "提交任务中…");
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const err = await r.json();
      throw new Error(err.detail || "提交失败");
    }
    const { task_id } = await r.json();
    const t = await pollTask(task_id, ui);
    return { task_id, ...t };
  } catch (err) {
    setProgress(ui, 0, `出错了：${err.message}`);
    return null;
  } finally {
    state.running[page] = false;
    updateRunBtns();
  }
}

function setProgress(ui, pct, msg) {
  $(ui.bar).style.width = `${Math.max(2, pct)}%`;
  $(ui.pct).textContent = `${Math.round(pct)}%`;
  $(ui.msg).textContent = msg;
}

async function pollTask(taskId, ui) {
  while (true) {
    const r = await fetch(`/api/task/${taskId}`);
    const t = await r.json();
    if (t.status === "done") {
      setProgress(ui, 100, t.message);
      $(ui.result).hidden = false;
      return t;
    }
    if (t.status === "error") {
      setProgress(ui, 0, `出错了：${t.message || "未知错误"}`);
      throw new Error(t.message);
    }
    setProgress(ui, t.progress, t.message);
    await new Promise((res) => setTimeout(res, 900));
  }
}

function downloadFile(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

/* ================= 拼接 ================= */
const JOIN_UI = {
  progress: "progress-join",
  bar: "progress-join-bar",
  pct: "progress-join-pct",
  msg: "progress-join-msg",
  result: "result-join",
};

function collectJoinPayload() {
  return {
    a_id: state.tracks.a.id,
    b_id: state.tracks.b.id,
    cut_a: state.autoCut ? null : (state.cutA / 100) * state.tracks.a.meta.duration,
    cut_b: state.autoCut ? null : (state.cutB / 100) * state.tracks.b.meta.duration,
    crossfade_sec: parseFloat($("crossfade").value),
    align_bpm: $("align-bpm").checked,
    align_pitch: $("align-pitch").checked,
    output_format: state.format.join,
  };
}

async function runJoin() {
  const t = await runTask("join", "/api/join", collectJoinPayload(), JOIN_UI);
  if (t) {
    $("result-join-audio").src = `/api/download/${t.task_id}`;
    $("download-join").onclick = () => downloadFile(`/api/download/${t.task_id}`, `mixlab-join.${state.format.join}`);
  }
}

/* ================= 融合 ================= */
const FUSION_UI = {
  progress: "progress-fusion",
  bar: "progress-fusion-bar",
  pct: "progress-fusion-pct",
  msg: "progress-fusion-msg",
  result: "result-fusion",
};

function collectFusionPayload() {
  return {
    a_id: state.tracks.a.id,
    b_id: state.tracks.b.id,
    mode: state.fusionMode,
    b_volume: parseFloat($("b-volume").value),
    keep_a_bed: parseFloat($("keep-bed").value),
    use_b_drums: $("use-b-drums").checked,
    align: $("fusion-align").checked,
    output_format: state.format.fusion,
  };
}

async function runFusion() {
  const t = await runTask("fusion", "/api/fusion", collectFusionPayload(), FUSION_UI);
  if (t) {
    $("result-fusion-audio").src = `/api/download/${t.task_id}`;
    $("download-fusion").onclick = () => downloadFile(`/api/download/${t.task_id}`, `mixlab-fusion.${state.format.fusion}`);
  }
}

function updateFusionUI() {
  const mode = state.fusionMode;
  $("keep-bed-row").style.display = mode === "vocal_swap" ? "" : "none";
  $("drums-row").hidden = mode !== "a_main";
  $("b-vol-label").textContent = mode === "a_main" ? "B 的融入音量（建议 20-40%）" : "B 的音量";
}

/* ================= 分离 ================= */
const SEP_UI = {
  progress: "progress-sep",
  bar: "progress-sep-bar",
  pct: "progress-sep-pct",
  msg: "progress-sep-msg",
  result: "result-sep",
};

const STEM_COLORS = {
  vocals: "#1db954",
  drums: "#e8b33c",
  bass: "#4d9de0",
  guitar: "#b36bf2",
  piano: "#f27ba6",
  other: "#8d99ae",
};

async function runSeparate() {
  const t = await runTask("sep", "/api/separate", { track_id: state.trackSep.id }, SEP_UI);
  if (!t) return;
  const meta = t.result_meta || {};
  const grid = $("stem-grid");
  grid.innerHTML = "";
  (meta.stems || []).forEach((stem) => {
    const card = document.createElement("div");
    card.className = "stem-card";
    const url = `/api/sep/${meta.task_dir}/${stem.file}`;
    card.innerHTML = `
      <div class="stem-card-head">
        <span class="stem-name">${stem.label}</span>
        <div class="stem-actions">
          <button class="stem-btn" data-url="${url}" data-name="${stem.file}">下载</button>
        </div>
      </div>
      <canvas class="stem-wave" height="40"></canvas>
      <audio class="stem-audio" controls preload="none" src="${url}"></audio>
    `;
    grid.appendChild(card);
    drawWave(card.querySelector(".stem-wave"), stem.peaks, STEM_COLORS[stem.name] || "#1db954");
    card.querySelector(".stem-btn").addEventListener("click", () => downloadFile(url, stem.file));
  });
  $("download-sep-zip").onclick = () => downloadFile(meta.zip_url, "mixlab-separated.zip");
}

/* ================= 初始化 ================= */
function bindSeg(containerId, cb) {
  const seg = $(containerId);
  seg.querySelectorAll(".seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      cb(btn.dataset.format);
    })
  );
}

function init() {
  const VALID = ["join", "fusion", "separate"];
  document.querySelectorAll(".nav-tab").forEach((t) => t.addEventListener("click", () => setPage(t.dataset.page)));
  const initial = VALID.find((p) => location.hash === `#${p}`) || "join";
  setPage(initial);
  window.addEventListener("hashchange", () => {
    const p = location.hash.slice(1);
    if (VALID.includes(p)) setPage(p);
  });

  bindDropzone("a", TRACK_UI.a[0]);
  bindDropzone("b", TRACK_UI.b[0]);
  bindDropzone("a", TRACK_UI.a[1]);
  bindDropzone("b", TRACK_UI.b[1]);
  bindSepUpload();

  bindTimelineDrag("tl-a", (p) => (state.cutA = p), 5, 95);
  bindTimelineDrag("tl-b", (p) => (state.cutB = p), 0, 95);
  $("auto-cut").addEventListener("change", (e) => {
    state.autoCut = e.target.checked;
    updateTimelineUI();
  });

  const range = (id, val, fmt) => {
    const input = $(id);
    const out = $(val);
    input.addEventListener("input", () => (out.textContent = fmt(parseFloat(input.value))));
    out.textContent = fmt(parseFloat(input.value));
  };
  range("crossfade", "crossfade-val", (v) => `${v} 秒`);
  range("b-volume", "b-volume-val", (v) => `${Math.round(v * 100)}%`);
  range("keep-bed", "keep-bed-val", (v) => `${Math.round(v * 100)}%`);

  bindSeg("format-seg-join", (f) => (state.format.join = f));
  bindSeg("format-seg-fusion", (f) => (state.format.fusion = f));

  document.querySelectorAll(".mode-card").forEach((card) =>
    card.addEventListener("click", () => {
      document.querySelectorAll(".mode-card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      state.fusionMode = card.dataset.mode;
      updateFusionUI();
    })
  );

  $("join-btn").addEventListener("click", runJoin);
  $("fusion-btn").addEventListener("click", runFusion);
  $("sep-btn").addEventListener("click", runSeparate);

  window.addEventListener("resize", redrawAllWaves);
  updateFusionUI();
  updateRunBtns();
  checkHealth();
}

init();
