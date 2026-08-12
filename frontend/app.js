const $ = (id) => document.getElementById(id);

const state = {
  tracks: { a: null, b: null },
  trackSep: null,
  page: "join",
  fusionMode: "vocal_swap",
  cutA: 75,
  cutB: 0,
  autoCut: true,
  structureA: null,
  structureB: null,
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
  if (!state.autoCut) return state.cutA;
  if (state.structureA && state.tracks.a?.meta.duration) {
    return (state.structureA.intro_end / state.tracks.a.meta.duration) * 100;
  }
  return 75;
}

function currentCutB() {
  if (!state.autoCut) return state.cutB;
  if (state.structureB && state.tracks.b?.meta.duration) {
    return (state.structureB.chorus_start / state.tracks.b.meta.duration) * 100;
  }
  return 0;
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
    setBusy(true);
    dragging = true;
    canvas.style.cursor = "grabbing";
    move(e);
  });
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    setBusy(false);
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
  setBusy(true);
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
    if (slot === "a") state.structureA = null;
    else state.structureB = null;
    renderTrack(slot, data);
    updateRunBtns();
    if (state.tracks.a && state.tracks.b) autoDetectStructure(true);
  } catch (err) {
    alert(`上传失败：${err.message}`);
  } finally {
    setBusy(false);
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
  if (slot === "a") state.structureA = null;
  else state.structureB = null;
  const hint = $("structure-hint");
  if (hint) hint.hidden = true;
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
  setBusy(true);
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
  } finally {
    setBusy(false);
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
  setBusy(true);
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
    setBusy(false);
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
    cut_a: state.autoCut ? (state.structureA?.intro_end ?? null) : (state.cutA / 100) * state.tracks.a.meta.duration,
    cut_b: state.autoCut ? (state.structureB?.chorus_start ?? null) : (state.cutB / 100) * state.tracks.b.meta.duration,
    crossfade_sec: parseFloat($("crossfade").value),
    align_bpm: $("align-bpm").checked,
    align_pitch: $("align-pitch").checked,
    output_format: state.format.join,
  };
}

async function autoDetectStructure(auto = false) {
  if (!state.tracks.a || !state.tracks.b) return;
  if (auto && state.structureA && state.structureB) return;
  setBusy(true);
  const hint = $("structure-hint");
  try {
    if (hint) {
      hint.hidden = false;
      hint.textContent = "正在智能识别前奏 / 副歌…";
    }
    const [sa, sb] = await Promise.all([
      fetch("/api/structure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_id: state.tracks.a.id }),
      }).then((r) => {
        if (!r.ok) throw new Error("A 结构识别失败");
        return r.json();
      }),
      fetch("/api/structure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_id: state.tracks.b.id }),
      }).then((r) => {
        if (!r.ok) throw new Error("B 结构识别失败");
        return r.json();
      }),
    ]);
    state.structureA = sa.structure;
    state.structureB = sb.structure;
    if (hint) {
      hint.textContent = `已识别：A 前奏结束 ${fmtTime(sa.structure.intro_end)} · B 副歌开始 ${fmtTime(sb.structure.chorus_start)}，切点已自动定位`;
    }
    updateTimelineUI();
  } catch (err) {
    if (hint) hint.textContent = `识别失败：${err.message}`;
  } finally {
    setBusy(false);
  }
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
    match_space: $("match-space").checked,
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
  $("keep-bed-row").style.display = mode === "vocal_swap" || mode === "harmony" || mode === "rhythm_swap" ? "" : "none";
  $("drums-row").hidden = mode !== "a_main";
  const keepLabel = $("keep-bed-row").querySelector("label");
  keepLabel.textContent = mode === "rhythm_swap" ? "保留 A 原节奏比例（更稳一点）" : "保留 A 的伴奏底（更有 A 的味道）";
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
  $("auto-structure").addEventListener("click", () => autoDetectStructure());

  window.addEventListener("resize", redrawAllWaves);
  window.addEventListener("scroll", () => {
    const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 260;
    document.body.classList.toggle("scrolled-bottom", nearBottom);
  });
  updateFusionUI();
  updateRunBtns();
  checkHealth();
  initLyricBg();
  startAmbientLyrics();
}

/* ================= 背景氛围：歌词 + 音符 ================= */

const LYRICS = [
  { text: "秋天该很好，你若尚在场", song: "春夏秋冬" },
  { text: "想过抢新娘，我差点讲真", song: "不甘心" },
  { text: "如能忘掉渴望，岁月长，衣裳薄", song: "再见二丁目" },
  { text: "从未跟你饮过冰，零度看风景", song: "偿还" },
  { text: "谁人曾照顾过我的感受", song: "七友" },
  { text: "窗花不可幽禁落霞", song: "喜帖街" },
  { text: "你是千堆雪，我是长街", song: "邮差" },
  { text: "在有生的瞬间能遇到你", song: "明年今日" },
  { text: "留我做个垃圾", song: "垃圾" },
  { text: "意乱情迷极易流逝", song: "春光乍泄" },
  { text: "哪有玩味的空档来欣赏细致淡雅", song: "苦瓜" },
  { text: "这个世界最坏罪名，叫太易动情", song: "无人之境" },
  { text: "在最坏时候，懂得吃，舍得穿，不会乱", song: "小团圆" },
  { text: "难道这次我抱紧你未必落空", song: "暗涌" },
  { text: "难敌这纷扰世态，为理想或求生在捱", song: "不吐不快" },
  { text: "明日将告别校园跟你道别时", song: "单恋高校" },
  { text: "何事落到这收场", song: "够钟" },
  { text: "我为何肯等个旧人，还错过多少的亲吻", song: "你知道我在等你们分手吗" },
  { text: "为何还喜欢我这种无赖", song: "无赖" },
  { text: "你不放下我，我不放下你", song: "相依为命" },
  { text: "不介意孤独，比爱你舒服", song: "献世" },
  { text: "遥远的她不可以再归家", song: "遥远的她" },
  { text: "我甘于当副车，也是快乐着唏嘘", song: "钟无艳" },
  { text: "游客是你，风景是我", song: "稀客" },
  { text: "剪影的你轮廓太好看", song: "约定" },
  { text: "终须都归还，无谓多贪", song: "暧昧" },
  { text: "记得要忘记", song: "花事了" },
  { text: "我仿似跟你热恋过", song: "梦中人" },
  { text: "但我会成为你最牵挂的一个女子", song: "野孩子" },
  { text: "我就算不再相信北极有曙光", song: "如果东京不快乐" },
  { text: "我不止三岁，我当然识趣", song: "知情识趣" },
  { text: "想与你开始从头开始", song: "有故事的人" },
  { text: "这一生也在进取，这分钟却挂念谁", song: "追" },
  { text: "从眉梢中感觉到，从眼角看不到", song: "有心人" },
  { text: "能同途偶遇在这星球上", song: "春夏秋冬" },
  { text: "情义已失去恩爱都失去", song: "偏偏喜欢你" },
  { text: "嘈杂场面宁愿退后", song: "Won't You Stand" },
  { text: "我没有为你伤春悲秋不配有憾事", song: "春秋" },
  { text: "你的衣裳今天我在穿", song: "暧昧" },
  { text: "难离难舍想抱紧些", song: "单车" },
  { text: "我想哭你可不可以暂时别要睡", song: "假如让我说下去" },
  { text: "天生我高贵艳丽到底", song: "芳华绝代" },
  { text: "其实你是一幅画", song: "念念不忘" },
  { text: "从前共你促膝把酒倾通宵都不够", song: "最佳损友" },
  { text: "仍未忘相约看漫天黄叶远飞", song: "约定" },
  { text: "自己都不爱，怎么相爱", song: "给自己的情书" },
  { text: "多少年，共对亦无言", song: "冷战" },
  { text: "得到过又猝逝也有一种智慧", song: "年度之歌" },
  { text: "若你喜欢怪人，其实我很美", song: "打回原形" },
  { text: "余生请你，指教", song: "咬唇" },
  { text: "真想带你见见，我刚识到的她", song: "耿耿于怀" },
  { text: "能承认嘛我故意当那电灯胆", song: "电灯胆" },
  { text: "做只猫做只狗，不做情人", song: "爱与诚" },
  { text: "我想知，如何永远不分开", song: "出埃及记" },
  { text: "抱着你不枉献世", song: "飞女正传" },
  { text: "沉没湖底，欣赏月圆", song: "漩涡" },
  { text: "如果你太累，及时的道别没有罪", song: "玻璃之情" },
  { text: "如沿途人群闹哄了，亦会听到心跳", song: "真命天子" },
  { text: "任他们多漂亮，未及你矜贵", song: "终身美丽" },
  { text: "宁愿没拥抱，共你可到老", song: "祝君好" },
  { text: "但凡未得到，但凡是过去", song: "似是故人来" },
  { text: "共你相识三千天，我没名无姓", song: "好好恋爱" },
  { text: "谁曾送我一朵，告别我", song: "告别我" },
  { text: "最动人时光，未必地老天荒", song: "罗生门" },
  { text: "共你亲到无可亲密后", song: "恋无可恋" },
  { text: "能容纳没处去的怪人", song: "守下去" },
];

const LYRIC_DURATION = 4000;
const LYRIC_GAP = 3000;
let lyricSide = "right";
let lyricHistory = [];
let lyricLastTop = { left: 40, right: 40 };

function startAmbientLyrics() {
  setTimeout(() => {
    showSideLyric("left");
    setInterval(() => {
      if (document.body.classList.contains("busy")) return;
      lyricSide = lyricSide === "left" ? "right" : "left";
      showSideLyric(lyricSide);
    }, LYRIC_GAP);
  }, 800);
}

function pickLyric() {
  let idx;
  do {
    idx = Math.floor(Math.random() * LYRICS.length);
  } while (lyricHistory.includes(idx) && lyricHistory.length < LYRICS.length);
  lyricHistory.push(idx);
  if (lyricHistory.length > 8) lyricHistory.shift();
  return LYRICS[idx];
}

function showSideLyric(side) {
  const layer = $("lyric-layer");
  if (!layer) return;
  const item = pickLyric();
  const W = window.innerWidth;
  const contentW = Math.min(1080, W * 0.78);
  const sideW = Math.max(80, (W - contentW) / 2);
  const el = document.createElement("div");
  el.className = `lyric-item side-${side}`;
  // 逐字墨迹晕染（手写感）
  const chars = Array.from(item.text)
    .map((c, i) => `<span class="char" style="animation-delay:${i * 60}ms">${c}</span>`)
    .join("");
  el.innerHTML = `<span class="l-text">${chars}</span><span class="l-song">《${item.song}》</span>`;
  // 垂直位置与另一侧至少保持 18% 的间距，两条歌词绝不会重叠
  const other = side === "left" ? "right" : "left";
  let top = 16 + Math.random() * 44;
  if (Math.abs(top - lyricLastTop[other]) < 18) {
    top = lyricLastTop[other] + (Math.random() < 0.5 ? -1 : 1) * (18 + Math.random() * 12);
    top = Math.max(16, Math.min(60, top));
    if (Math.abs(top - lyricLastTop[other]) < 18) top = lyricLastTop[other] >= 38 ? 16 : 60;
  }
  lyricLastTop[side] = top;
  el.style.top = `${top}%`;
  const margin = 20;
  // 强制单行：按句子长度自适应字号，保证不超出侧区，也绝不超出视口边框
  const len = Math.max(1, item.text.length);
  const spacing = 1.5 * (len - 1);
  const fsIdeal = Math.floor((sideW - margin * 2 - spacing) / len);
  const fsMax = Math.floor((W - margin * 2 - 30 - spacing) / len);
  const fs = Math.max(14, Math.min(26, fsIdeal, fsMax));
  el.style.fontSize = `${fs}px`;
  if (side === "left") {
    el.style.left = `${margin}px`;
    el.style.setProperty("--tilt", `${-(3 + Math.random() * 4)}deg`);
  } else {
    // 右侧歌词用 right 定位，让文字向左生长，避免冲出屏幕右边缘
    el.style.right = `${margin}px`;
    el.style.left = "auto";
    el.style.setProperty("--tilt", `${3 + Math.random() * 4}deg`);
  }
  layer.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.add("hide");
    setTimeout(() => el.remove(), 850);
  }, LYRIC_DURATION);
}

let busyCount = 0;

function setBusy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  document.body.classList.toggle("busy", busyCount > 0);
}

function initLyricBg() {
  const canvas = $("lyric-bg");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const GLYPHS = ["♪", "♫", "♬", "♩"];
  const SAFE_SEL = ".topbar, .track-card, .card, .mode-card, .actions, .progress-wrap, .result-card, .footer";
  let W = 0;
  let H = 0;
  let safeRects = [];
  const parts = [];

  // 收集当前视口里会被音符挡住的区域（功能卡片、导航栏、按钮等），音符绝不进这些区域
  function updateSafeRects() {
    safeRects = [];
    const pad = 26;
    document.querySelectorAll(SAFE_SEL).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (r.bottom < -pad || r.top > H + pad || r.right < -pad || r.left > W + pad) return;
      safeRects.push({
        x0: Math.max(0, r.left - pad),
        x1: Math.min(W, r.right + pad),
        y0: Math.max(0, r.top - pad),
        y1: Math.min(H, r.bottom + pad),
      });
    });
  }

  function blocked(x, y, size) {
    for (let i = 0; i < safeRects.length; i++) {
      const r = safeRects[i];
      if (x + size > r.x0 && x < r.x1 && y + size > r.y0 && y < r.y1) return true;
    }
    return false;
  }

  function spawn(initial, side) {
    const size = 17 + Math.random() * 23; // 17-40px，比之前更大更清楚
    const half = W / 2;
    const margin = 14;
    let x = margin;
    let y = initial ? Math.random() * H : H + 20 + Math.random() * 120;
    // 全屏随机找位置，最多试 80 次；找不到就退回最后一次随机结果（会被卡片自然遮住）
    for (let tries = 0; tries < 80; tries++) {
      if (side === "left") {
        x = margin + Math.random() * Math.max(10, half - 30 - size - margin);
      } else {
        x = half + 30 + Math.random() * Math.max(10, W - margin - size - (half + 30));
      }
      if (initial) y = Math.random() * H;
      if (!blocked(x, y, size)) break;
    }
    return {
      side,
      x,
      y,
      size,
      speed: 0.22 + Math.random() * 0.38,
      phase: Math.random() * Math.PI * 2,
      rot: (Math.random() - 0.5) * 0.45,
      alpha: 0.20 + Math.random() * 0.18,
      glyph: GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
    };
  }

  function rebuild() {
    parts.length = 0;
    const perSide = W < 900 ? 10 : W < 1400 ? 14 : 18;
    for (let i = 0; i < perSide; i++) parts.push(spawn(true, "left"));
    for (let i = 0; i < perSide; i++) parts.push(spawn(true, "right"));
  }

  function tick() {
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.y -= p.speed;
      p.phase += 0.012;
      const x = p.x + Math.sin(p.phase) * 16;
      // 飘到卡片后面或被卡片挡住时，直接换一个干净位置重生，保持左右数量恒定
      if (p.y < -40 || blocked(x, p.y, p.size)) {
        parts[i] = spawn(false, p.side);
        continue;
      }
      const fadeIn = Math.max(0, Math.min(1, (H - p.y) / 160));
      const fadeOut = Math.max(0, Math.min(1, (p.y - 30) / 120));
      ctx.globalAlpha = p.alpha * Math.min(fadeIn, fadeOut);
      ctx.save();
      ctx.translate(x + p.size / 2, p.y);
      ctx.rotate(p.rot);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `${p.size}px "Segoe UI Symbol", "Microsoft YaHei", serif`;
      ctx.fillStyle = "#2bd96a";
      ctx.shadowColor = "rgba(43, 217, 106, 0.9)";
      ctx.shadowBlur = 10 + p.size * 0.35;
      ctx.fillText(p.glyph, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    updateSafeRects();
    rebuild();
  }

  resize();
  window.addEventListener("resize", resize);
  window.addEventListener("scroll", () => requestAnimationFrame(updateSafeRects), { passive: true });
  tick();
}

init();
