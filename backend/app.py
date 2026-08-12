"""FastAPI backend for MixLab."""

import os
import shutil
import sys
import threading
import traceback
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE = Path(__file__).resolve().parent.parent
BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

import audio_engine  # noqa: E402

DATA = BASE / "data"
UPLOADS = DATA / "uploads"
RESULTS = DATA / "results"
FRONTEND = BASE / "frontend"
UPLOADS.mkdir(parents=True, exist_ok=True)
RESULTS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="MixLab", docs_url=None, redoc_url=None)

TRACKS: dict = {}
_tasks: dict = {}
_lock = threading.Lock()


def _new_task(fn) -> str:
    task_id = uuid.uuid4().hex[:12]
    state = {
        "status": "running",
        "stage": "init",
        "progress": 0,
        "message": "任务已创建",
        "result": None,
        "error": None,
    }
    with _lock:
        _tasks[task_id] = state

    def runner():
        def cb(stage: str, pct: float, msg: str):
            with _lock:
                _tasks[task_id].update(stage=stage, progress=round(pct, 1), message=msg)

        try:
            result_path = fn(cb)
            with _lock:
                _tasks[task_id].update(status="done", progress=100, message="完成，可以下载了", result=result_path)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            with _lock:
                _tasks[task_id].update(status="error", message=str(exc), error=traceback.format_exc())

    threading.Thread(target=runner, daemon=True).start()
    return task_id


def _track_or_404(track_id: str) -> dict:
    track = TRACKS.get(track_id)
    if not track:
        raise HTTPException(404, "歌曲不存在，请重新上传")
    return track


@app.get("/api/health")
def health():
    device = "cpu"
    try:
        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "device": device}


@app.post("/api/upload")
def upload(file: UploadFile = File(...)):
    track_id = uuid.uuid4().hex[:12]
    ext = os.path.splitext(file.filename or "")[1].lower() or ".mp3"
    path = UPLOADS / f"{track_id}{ext}"
    with open(path, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    try:
        meta = audio_engine.analyze(str(path))
    except Exception as exc:  # noqa: BLE001
        path.unlink(missing_ok=True)
        raise HTTPException(400, f"无法解析音频文件：{exc}") from exc
    TRACKS[track_id] = {"path": str(path), "name": file.filename or track_id, "meta": meta}
    return {"id": track_id, "name": file.filename or track_id, "meta": meta}


class JoinRequest(BaseModel):
    a_id: str
    b_id: str
    cut_a: Optional[float] = None
    cut_b: Optional[float] = None
    crossfade_sec: float = 4.0
    align_bpm: bool = True
    align_pitch: bool = True
    output_format: str = "mp3"


@app.post("/api/join")
def join(req: JoinRequest):
    ta = _track_or_404(req.a_id)
    tb = _track_or_404(req.b_id)

    def fn(cb):
        cb("analysis", 8, "正在分析两首歌的节拍和调性")
        audio = audio_engine.seamless_join(
            ta["path"],
            tb["path"],
            cut_a=req.cut_a,
            cut_b=req.cut_b,
            crossfade_sec=req.crossfade_sec,
            align_bpm=req.align_bpm,
            align_pitch=req.align_pitch,
        )
        cb("render", 80, "正在渲染结果")
        return _save_result(audio, req.output_format)

    return {"task_id": _new_task(fn)}


class FusionRequest(BaseModel):
    a_id: str
    b_id: str
    mode: str = "vocal_swap"  # vocal_swap | a_main | balanced
    b_volume: float = 1.0
    keep_a_bed: float = 0.25
    use_b_drums: bool = False
    align: bool = True
    output_format: str = "mp3"


@app.post("/api/fusion")
def fusion(req: FusionRequest):
    ta = _track_or_404(req.a_id)
    tb = _track_or_404(req.b_id)

    def fn(cb):
        audio = audio_engine.smart_fusion(
            ta["path"],
            tb["path"],
            mode=req.mode,
            b_volume=req.b_volume,
            keep_a_bed=req.keep_a_bed,
            use_b_drums=req.use_b_drums,
            align=req.align,
            device="cuda",
            progress_cb=cb,
        )
        return _save_result(audio, req.output_format)

    return {"task_id": _new_task(fn)}


def _save_result(audio, output_format: str) -> str:
    task_id = uuid.uuid4().hex[:12]
    wav_path = RESULTS / f"result_{task_id}.wav"
    audio_engine.save_audio(str(wav_path), audio)
    if output_format == "mp3":
        mp3_path = RESULTS / f"result_{task_id}.mp3"
        audio_engine.export_mp3(str(wav_path), str(mp3_path))
        wav_path.unlink(missing_ok=True)
        return str(mp3_path)
    return str(wav_path)


@app.get("/api/task/{task_id}")
def task_status(task_id: str):
    state = _tasks.get(task_id)
    if not state:
        return JSONResponse({"status": "not_found"}, status_code=404)
    return JSONResponse(
        {
            "status": state["status"],
            "stage": state["stage"],
            "progress": state["progress"],
            "message": state["message"],
            "result": state["result"],
            "error": state["error"],
        }
    )


@app.get("/api/download/{task_id}")
def download(task_id: str):
    state = _tasks.get(task_id)
    if not state or state.get("status") != "done" or not state.get("result"):
        raise HTTPException(404, "结果不存在")
    return FileResponse(state["result"], filename=os.path.basename(state["result"]))


app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
