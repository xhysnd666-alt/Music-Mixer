const state = {
  tracks: { a: null, b: null },
  mode: "join",
  format: "mp3",
  running: false,
};

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  autoCut: true,
  cutA: 75,
  cutB: 0,
  crossfade: 4,
  alignBpm: true,
  alignPitch: true,
  fusionMode: "vocal_swap",
  bVolume: 1.0,
  keepBed: 0.25,
  useBDrums: false,
  fusionAlign: true,
};

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ---------- GPU 状态 ---------- */
async function checkHealth() {
  try {
    const r = await fetch("/api/health");
    const data = await r.json();
    const el = $("gpu-status");
    el.classList.add("ok");
    el.innerHTML = `<span class="status-dot"></span> ${
      data.device === "cuda" ? "本机 GPU 加速已就绪（CUDA）" : "CPU 模式（分离会偏慢）"
    }`;
  } catch {
    $("gpu-status").classList.add("err");
    $("gpu-status").innerHTML = `<span class="status-dot"></span> 服务未连接`;
  }
}

/* ---------- 上传 ---------- */
function bindDropzone(slot, dropId, fileId, waveId, metaId, titleId, removeId) {
  const drop = $(dropId);
  const input = $(fileId);
  drop.addEventListener("click", () => input.click());
  input.addEventListener("change", () => input.files[0] && uploadFile(slot, input.files[0]));
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
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(slot, file);
  });
  $(removeId).addEventListener("click", () => clearTrack(slot));
}

async function uploadFile(slot, file) {
  const fd = new FormData();
  fd.append("file", file);
  const holder = slot === "a" ? "track-a" : "track-b";
  $(holder).style.opacity = "0.55";
  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    if (!r.ok) {
      const err = await r.json();
      throw new Error(err.detail || "上传失败");
    }
    const data = await r.json();
    state.tracks[slot] = data;
    renderTrack(slot, data);
  } catch (err) {
    alert(`上传失败：${err.message}`);
  } finally {
    $(holder).style.opacity = "1";
  }
  updateRunBtn();
}

function renderTrack(slot, data) {
  const waveId = slot === "a" ? "wave-a" : "wave-b";
  const metaId = slot === "a" ? "meta-a" : "meta-b";
  const titleId = slot === "a" ? "title-a" : "title-b";
  const removeId = slot === "a" ? "remove-a" : "remove-b";
  const dropId = slot === "a" ? "drop-a" : "drop-b";

  $(dropId).classList.add("hidden");
  $(waveId).hidden = false;
  $(metaId).hidden = false;
  $(removeId).hidden = false;
  $(titleId).textContent = data.name;
  drawWave($(waveId), data.meta.peaks, slot === "a" ? "#a78bfa" : "#67e8f9");
  $(metaId).innerHTML = [
    `<span class="meta-chip">时长 <b>${fmtTime(data.meta.duration)}</b></span>`,
    `<span class="meta-chip">BPM <b>${data.meta.bpm}</b></span>`,
    `<span class="meta-chip">调性 <b>${data.meta.key}</b></span>`,
    `<span class="meta-chip">响度 <b>${data.meta.loudness_db} dB</b></span>`,
  ].join("");
}

function clearTrack(slot) {
  state.tracks[slot] = null;
  const waveId = slot === "a" ? "wave-a" : "wave-b";
  const metaId = slot === "a" ? "meta-a" : "meta-b";
  const titleId = slot === "a" ? "title-a" : "title-b";
  const removeId = slot === "a" ? "remove-a" : "remove-b";
  const dropId = slot === "a" ? "drop-a" : "drop-b";
  const fileId = slot === "a" ? "file-a" : "file-b";
  $(dropId).classList.remove("hidden");
  $(waveId).hidden = true;
  $(metaId).hidden = true;
  $(removeId).hidden = true;
  $(titleId).textContent = slot === "a" ? "上传歌曲 A" : "上传歌曲 B";
  $(fileId).value = "";
  updateRunBtn();
}

function drawWave(canvas, peaks, color) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  const h = canvas.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!peaks || !peaks.length) return;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, color);
  grad.addColorStop(1, color);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  const n = peaks.length;
  const step = w / n;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = i * step + step / 2;
    const amp = Math.max(0.025, peaks[i]) * (h * 0.42);
    ctx.moveTo(x, h / 2 - amp);
    ctx.lineTo(x, h / 2 + amp);
  }
  ctx.stroke();
  const glow = ctx.createLinearGradient(0, 0, w, 0);
  glow.addColorStop(0, color + "33");
  glow.addColorStop(1, color + "33");
  ctx.strokeStyle = glow;
  ctx.lineWidth = 5;
  ctx.stroke();
}

/* ---------- 模式 ---------- */
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-card").forEach((c) => c.classList.toggle("active", c.dataset.mode === mode));
  $("params-join").hidden = mode !== "join";
  $("params-fusion").hidden = mode !== "fusion";
}

/* ---------- 参数 ---------- */
function bindRange(id, valId, fmt) {
  const input = $(id);
  const out = $(valId);
  const update = () => (out.textContent = fmt(parseFloat(input.value)));
  input.addEventListener("input", update);
  update();
}

function bindSeg(containerId, onClick) {
  const seg = $(containerId);
  seg.querySelectorAll(".seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onClick(btn.dataset.mode || btn.dataset.format);
    })
  );
}

function resetParams() {
  Object.assign(DEFAULTS, {
    autoCut: true,
    cutA: 75,
    cutB: 0,
    crossfade: 4,
    alignBpm: true,
    alignPitch: true,
    fusionMode: "vocal_swap",
    bVolume: 1.0,
    keepBed: 0.25,
    useBDrums: false,
    fusionAlign: true,
  });
  $("auto-cut").checked = true;
  $("cut-a").disabled = true;
  $("cut-b").disabled = true;
  $("cut-a").value = 75;
  $("cut-a-val").textContent = "75%";
  $("cut-b").value = 0;
  $("cut-b-val").textContent = "0%";
  $("crossfade").value = 4;
  $("crossfade-val").textContent = "4 秒";
  $("align-bpm").checked = true;
  $("align-pitch").checked = true;
  $("b-volume").value = 1;
  $("b-volume-val").textContent = "100%";
  $("keep-bed").value = 0.25;
  $("keep-bed-val").textContent = "25%";
  $("use-b-drums").checked = false;
  $("fusion-align").checked = true;
  const seg = $("fusion-mode-seg");
  seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === "vocal_swap"));
  updateFusionModeUI();
}

function updateFusionModeUI() {
  const mode = state.fusionMode;
  $("keep-bed-row").style.display = mode === "vocal_swap" ? "" : "none";
  $("drums-row").hidden = mode !== "a_main";
  const bVolLabel = mode === "a_main" ? "B 的融入音量（建议 20-40%）" : "B 的音量";
  $("b-volume").closest(".param-row").querySelector(".param-label").textContent = bVolLabel;
}

/* ---------- 任务 ---------- */
function updateRunBtn() {
  $("run-btn").disabled = state.running || !state.tracks.a || !state.tracks.b;
}

function collectParams() {
  if (state.mode === "join") {
    return {
      a_id: state.tracks.a.id,
      b_id: state.tracks.b.id,
      cut_a: $("auto-cut").checked ? null : (parseFloat($("cut-a").value) / 100) * state.tracks.a.meta.duration,
      cut_b: $("auto-cut").checked ? null : (parseFloat($("cut-b").value) / 100) * state.tracks.b.meta.duration,
      crossfade_sec: parseFloat($("crossfade").value),
      align_bpm: $("align-bpm").checked,
      align_pitch: $("align-pitch").checked,
      output_format: state.format,
    };
  }
  return {
    a_id: state.tracks.a.id,
    b_id: state.tracks.b.id,
    mode: state.fusionMode,
    b_volume: parseFloat($("b-volume").value),
    keep_a_bed: parseFloat($("keep-bed").value),
    use_b_drums: $("use-b-drums").checked,
    align: $("fusion-align").checked,
    output_format: state.format,
  };
}

async function runTask(auto = false) {
  if (state.running || !state.tracks.a || !state.tracks.b) return;
  if (auto) resetParams();
  state.running = true;
  updateRunBtn();
  $("progress-wrap").hidden = false;
  $("result-card").hidden = true;
  setProgress(0, "正在提交任务…");

  try {
    const endpoint = state.mode === "join" ? "/api/join" : "/api/fusion";
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectParams()),
    });
    if (!r.ok) {
      const err = await r.json();
      throw new Error(err.detail || "提交失败");
    }
    const { task_id } = await r.json();
    await poll(task_id);
  } catch (err) {
    setProgress(0, `出错了：${err.message}`);
  } finally {
    state.running = false;
    updateRunBtn();
  }
}

function setProgress(pct, msg) {
  $("progress-bar").style.width = `${Math.max(2, pct)}%`;
  $("progress-pct").textContent = `${Math.round(pct)}%`;
  $("progress-message").textContent = msg;
}

async function poll(taskId) {
  while (true) {
    const r = await fetch(`/api/task/${taskId}`);
    const t = await r.json();
    if (t.status === "done") {
      setProgress(100, t.message);
      $("result-card").hidden = false;
      $("result-audio").src = `/api/download/${taskId}`;
      $("download-btn").onclick = () => {
        const a = document.createElement("a");
        a.href = `/api/download/${taskId}`;
        a.download = `mixlab-${state.mode}-${Date.now()}.${state.format}`;
        a.click();
      };
      return;
    }
    if (t.status === "error") {
      setProgress(0, `出错了：${t.message || "未知错误"}`);
      return;
    }
    setProgress(t.progress, t.message);
    await new Promise((res) => setTimeout(res, 900));
  }
}

/* ---------- 初始化 ---------- */
function init() {
  bindDropzone("a", "drop-a", "file-a", "wave-a", "meta-a", "title-a", "remove-a");
  bindDropzone("b", "drop-b", "file-b", "wave-b", "meta-b", "title-b", "remove-b");

  document.querySelectorAll(".mode-card").forEach((c) => c.addEventListener("click", () => setMode(c.dataset.mode)));
  setMode("join");

  bindRange("cut-a", "cut-a-val", (v) => `${Math.round(v)}%`);
  bindRange("cut-b", "cut-b-val", (v) => `${Math.round(v)}%`);
  bindRange("crossfade", "crossfade-val", (v) => `${v} 秒`);
  bindRange("b-volume", "b-volume-val", (v) => `${Math.round(v * 100)}%`);
  bindRange("keep-bed", "keep-bed-val", (v) => `${Math.round(v * 100)}%`);

  $("auto-cut").addEventListener("change", (e) => {
    $("cut-a").disabled = e.target.checked;
    $("cut-b").disabled = e.target.checked;
  });

  bindSeg("fusion-mode-seg", (mode) => {
    state.fusionMode = mode;
    updateFusionModeUI();
  });
  bindSeg("format-seg", (format) => {
    state.format = format;
  });

  $("reset-params").addEventListener("click", resetParams);
  $("run-btn").addEventListener("click", () => runTask(false));
  $("auto-run").addEventListener("click", () => runTask(true));

  window.addEventListener("resize", () => {
    if (state.tracks.a) drawWave($("wave-a"), state.tracks.a.meta.peaks, "#a78bfa");
    if (state.tracks.b) drawWave($("wave-b"), state.tracks.b.meta.peaks, "#67e8f9");
  });

  checkHealth();
}

init();
