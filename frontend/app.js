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
    renderTrack(slot, data);
    updateRunBtns();
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
  window.addEventListener("scroll", () => {
    const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 260;
    document.body.classList.toggle("scrolled-bottom", nearBottom);
  });
  updateFusionUI();
  updateRunBtns();
  checkHealth();
  initLyricBg();
  startLyrics();
}

/* ================= 背景氛围：歌词 + 音符 ================= */

const LYRICS = [
  { text: "秋天该很好，你若尚在场。", song: "春夏秋冬" },
  { text: "尤其这新婚，就像玩牺牲。想过抢新娘，我差点讲真。", song: "不甘心" },
  { text: "如能忘掉渴望，岁月长，衣裳薄。无论于什么角落，不假设你或会在旁，我也可畅游异国，放心吃喝。", song: "再见二丁目" },
  { text: "从未跟你饮过冰，零度看风景。", song: "偿还" },
  { text: "谁人曾照顾过我的感受，待我温柔吻过我伤口。能得到的安慰是失恋者得救后，很感激忠诚的狗。", song: "七友" },
  { text: "阶砖不会拒绝磨蚀，窗花不可幽禁落霞，有感情就能一生一世吗？", song: "喜帖街" },
  { text: "你是千堆雪，我是长街，怕日出一到，彼此瓦解。", song: "邮差" },
  { text: "在有生的瞬间能遇到你，竟花光所有运气。", song: "明年今日" },
  { text: "留我做个垃圾，长留恋于你家。从沉溺中结疤，再发芽。", song: "垃圾" },
  { text: "意乱情迷极易流逝，难耐这夜春光浪费。", song: "春光乍泄" },
  { text: "青春的快餐只要求快不理哪一家，哪有玩味的空档来欣赏细致淡雅。", song: "苦瓜" },
  { text: "这个世界最坏罪名，叫太易动情，但我喜欢这罪名。", song: "无人之境" },
  { text: "一起约好过年，缺席人物多于往年，只能齐集仍在的脸，赶快地拍下照片。在最坏时候，懂得吃，舍得穿，不会乱。", song: "小团圆" },
  { text: "其实我再去爱惜你又有何用，难道这次我抱紧你未必落空。", song: "暗涌" },
  { text: "难敌这纷扰世态，为理想或求生在捱。没完没了各有需要把青春贱卖，也爱用整晚畅论人家感情最后为何完结的道理。", song: "不吐不快" },
  { text: "就算经过茫茫悠长岁月也会记住那张脸，明日将告别校园跟你道别时，我怕会暗暗鼻酸。", song: "单恋高校" },
  { text: "何事落到这收场，枯死在你的手上。", song: "够钟" },
  { text: "知你曾花心，爱着你很惊心。却又各开心，得我愿意受你所困。我为何肯等个旧人，还错过多少的亲吻。", song: "你知道我在等你们分手吗" },
  { text: "我间中饮醉酒很喜欢自由，\n常犯错爱说谎但总会内疚，\n遇过很多的损友学到贪新厌旧，\n为何还喜欢我我这种无赖。\n是话你蠢还是很伟大，\n在座每位都将我踩口碑有多坏，\n但你亦永远不见怪。", song: "无赖" },
  { text: "即使身边世事再毫无道理，与你永远亦连在一起，你不放下我，我不放下你，我想确定每日挽着同样的手臂。", song: "相依为命" },
  { text: "不介意孤独，比爱你舒服，你是前度，何必听我吠。", song: "献世" },
  { text: "遥远的她不可以再归家，我在梦里却始终只有她。", song: "遥远的她" },
  { text: "互相祝福心软之际，或者准我吻下去。我甘于当副车，也是快乐着唏嘘，彼此这么了解，难怪注定似兄妹一对。", song: "钟无艳" },
  { text: "游客是你，风景是我，无法避免，让你经过。", song: "稀客" },
  { text: "剪影的你轮廓太好看，凝住眼泪才敢细看。", song: "约定" },
  { text: "徘徊在似苦又甜之间，望不穿这暧昧的眼，爱或情借来填一晚，终须都归还，无谓多贪。", song: "暧昧" },
  { text: "让我感谢你，赠我空欢喜，记得要忘记。", song: "花事了" },
  { text: "我仿似跟你热恋过，和你未似现在这接近，思想开始过份。", song: "梦中人" },
  { text: "明知爱这种男孩子，也许只能如此，但我会成为你最牵挂的一个女子。朝朝暮暮让你猜想如何驯服我，若果亲手抱住，或者不必如此。", song: "野孩子" },
  { text: "我就算是拥抱过后回头没海岸，也换来见闻观光。我就算不再相信北极有曙光，行云流水亦爱看。", song: "如果东京不快乐" },
  { text: "我不止三岁，我当然识趣。", song: "知情识趣" },
  { text: "想与你开始从头开始，彼此的痛遥远但相似。", song: "有故事的人" },
  { text: "这一生也在进取，这分钟却挂念谁。", song: "追" },
  { text: "从眉梢中感觉到，从眼角看不到，彷佛已是最直接的裸露。", song: "有心人" },
  { text: "能同途偶遇在这星球上，燃亮飘渺人生，我多么够运。无人如你逗留我思潮上，从没再疑问，这个世界好得很。", song: "春夏秋冬" },
  { text: "为何我心分秒想着过去，为何你一点都不记起，情义已失去恩爱都失去，我却为何偏偏喜欢你。", song: "偏偏喜欢你" },
  { text: "男女朋友无法迁就，越拖越久越想分手，谁对谁错谁太丑陋，嘈杂场面宁愿退后。", song: "Won't You Stand" },
  { text: "我没有为你伤春悲秋不配有憾事，你没有共我踏过万里不够剧情延续故事。", song: "春秋" },
];

const LYRIC_SHOW_MS = 3000;
let lyricIndex = 0;
let lyricTimer = null;

function startLyrics() {
  setTimeout(showLyric, 1200);
}

function showLyric() {
  const item = LYRICS[lyricIndex % LYRICS.length];
  lyricIndex += 1;
  const bar = $("lyric-bar");
  bar.classList.remove("show");
  clearTimeout(lyricTimer);
  setTimeout(() => {
    if (document.body.classList.contains("busy")) {
      // 忙碌时先不打扰，等空闲后再继续
      lyricTimer = setTimeout(showLyric, LYRIC_SHOW_MS);
      return;
    }
    $("lyric-text").textContent = item.text;
    $("lyric-song").textContent = `《${item.song}》`;
    bar.classList.add("show");
    lyricTimer = setTimeout(() => {
      bar.classList.remove("show");
      lyricTimer = setTimeout(showLyric, 400);
    }, LYRIC_SHOW_MS);
  }, 400);
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
  let W = 0;
  let H = 0;
  const parts = [];

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(initial) {
    return {
      x: Math.random() * W,
      y: initial ? Math.random() * H : H + 20 + Math.random() * 100,
      size: 14 + Math.random() * 24,
      speed: 0.15 + Math.random() * 0.35,
      phase: Math.random() * Math.PI * 2,
      alpha: 0.05 + Math.random() * 0.08,
      glyph: GLYPHS[Math.floor(Math.random() * GLYPHS.length)],
    };
  }

  function tick() {
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.y -= p.speed;
      p.phase += 0.012;
      const x = p.x + Math.sin(p.phase) * 14;
      const fadeIn = Math.max(0, Math.min(1, (H - p.y) / 140));
      const fadeOut = Math.max(0, Math.min(1, (p.y - 24) / 100));
      ctx.globalAlpha = p.alpha * Math.min(fadeIn, fadeOut);
      ctx.font = `${p.size}px "Segoe UI Symbol", "Microsoft YaHei", serif`;
      ctx.fillStyle = "#1db954";
      ctx.fillText(p.glyph, x, p.y);
      if (p.y < -30) parts[i] = spawn(false);
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(tick);
  }

  resize();
  window.addEventListener("resize", resize);
  for (let i = 0; i < 11; i++) parts.push(spawn(true));
  tick();
}

init();
