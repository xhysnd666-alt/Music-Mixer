"""Core audio engine: analysis, stem separation, seamless joining, smart fusion."""

import os
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Callable, Optional

import imageio_ffmpeg
import numpy as np
import soundfile as sf

SR = 44100
MODEL_REPO_DIR = Path(__file__).resolve().parent.parent / "data" / "models" / "demucs_6s"
KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

_model_lock = threading.Lock()
_model_cache: dict = {}
_device = None


def _ffmpeg_exe() -> str:
    return imageio_ffmpeg.get_ffmpeg_exe()


def decode_to_wav(src: str, dst: str) -> None:
    subprocess.run(
        [_ffmpeg_exe(), "-y", "-i", src, "-ar", str(SR), "-ac", "2", dst],
        check=True,
        capture_output=True,
    )


def load_audio(src: str) -> np.ndarray:
    """Load any audio file as stereo float32, shape (2, N)."""
    tmp = tempfile.mktemp(suffix=".wav", prefix="mixlab_")
    try:
        decode_to_wav(src, tmp)
        data, sr = sf.read(tmp, dtype="float32", always_2d=True)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    if sr != SR:
        import librosa

        data = librosa.resample(data.T, orig_sr=sr, target_sr=SR).T
    return np.ascontiguousarray(data.T)


def save_audio(dst: str, audio: np.ndarray) -> None:
    sf.write(dst, audio.T, SR, subtype="PCM_16")


def export_mp3(src_wav: str, dst_mp3: str, bitrate: str = "320k") -> None:
    subprocess.run(
        [_ffmpeg_exe(), "-y", "-i", src_wav, "-b:a", bitrate, dst_mp3],
        check=True,
        capture_output=True,
    )


def _mono(audio: np.ndarray) -> np.ndarray:
    return audio.mean(axis=0)


def detect_bpm(audio: np.ndarray) -> float:
    import librosa

    y = _mono(audio)
    tempo, _ = librosa.beat.beat_track(y=y, sr=SR)
    bpm = float(np.atleast_1d(tempo)[0])
    while bpm < 70:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    return bpm


def detect_key(audio: np.ndarray) -> str:
    import librosa

    y = _mono(audio)
    chroma = librosa.feature.chroma_stft(y=y, sr=SR)
    chroma_mean = chroma.mean(axis=1)
    best_score, best_pc, best_mode = -2.0, 0, "major"
    for pc in range(12):
        for mode, profile in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            score = float(np.corrcoef(chroma_mean, np.roll(profile, pc))[0, 1])
            if score > best_score:
                best_score, best_pc, best_mode = score, pc, mode
    return f"{KEY_NAMES[best_pc]} {best_mode}"


def loudness_db(audio: np.ndarray) -> float:
    y = _mono(audio)
    rms = float(np.sqrt(np.mean(y**2) + 1e-12))
    return 20.0 * np.log10(rms)


def compute_peaks(audio: np.ndarray, bins: int = 900) -> list:
    y = _mono(audio)
    if len(y) == 0:
        return []
    chunk = max(1, len(y) // bins)
    n = len(y) // chunk
    trimmed = y[: n * chunk].reshape(n, chunk)
    peaks = np.abs(trimmed).max(axis=1)
    if peaks.size:
        peaks = peaks / (peaks.max() + 1e-12)
    return [float(v) for v in peaks]


def analyze(path: str) -> dict:
    audio = load_audio(path)
    dur = audio.shape[1] / SR
    bpm = detect_bpm(audio)
    key = detect_key(audio)
    loud = loudness_db(audio)
    return {
        "duration": round(dur, 2),
        "sample_rate": SR,
        "channels": 2,
        "bpm": round(float(bpm), 1),
        "key": key,
        "loudness_db": round(float(loud), 1),
        "peaks": compute_peaks(audio),
    }


def _key_pc(key: str) -> int:
    return KEY_NAMES.index(key.split()[0])


def time_stretch(audio: np.ndarray, rate: float) -> np.ndarray:
    if abs(rate - 1.0) < 1e-3:
        return audio
    import librosa

    return np.stack([librosa.effects.time_stretch(ch, rate=rate) for ch in audio])


def pitch_shift(audio: np.ndarray, n_steps: int) -> np.ndarray:
    if n_steps == 0:
        return audio
    import librosa

    return np.stack([librosa.effects.pitch_shift(ch, sr=SR, n_steps=n_steps) for ch in audio])


def align_to(track: np.ndarray, bpm_from: float, bpm_to: float, key_from: str, key_to: str,
             max_speed_change: float = 0.2, max_pitch_shift: int = 3) -> np.ndarray:
    """Stretch and pitch-shift a track so it sits in the same tempo/key as the target."""
    rate = bpm_to / bpm_from if bpm_from > 0 else 1.0
    rate = float(np.clip(rate, 1 - max_speed_change, 1 + max_speed_change))
    out = time_stretch(track, rate)
    delta = (_key_pc(key_to) - _key_pc(key_from) + 6) % 12 - 6
    candidates = [delta, delta + 12, delta - 12]
    valid = [c for c in candidates if abs(c) <= max_pitch_shift]
    n_steps = min(valid, key=abs) if valid else 0
    out = pitch_shift(out, int(n_steps))
    return out


def _fit_length(audio: np.ndarray, n: int) -> np.ndarray:
    """Truncate or tile audio to exactly n samples."""
    if audio.shape[1] >= n:
        return audio[:, :n]
    reps = int(np.ceil(n / audio.shape[1]))
    return np.tile(audio, (1, reps))[:, :n]


def _master(audio: np.ndarray, target_rms: float = 0.16) -> np.ndarray:
    rms = float(np.sqrt(np.mean(audio**2)) + 1e-12)
    audio = audio * (target_rms / rms)
    peak = float(np.max(np.abs(audio)))
    if peak > 0.93:
        drive = (0.93 / peak) * 1.4
        audio = np.tanh(audio * drive) / np.tanh(drive)
    return audio


def _match_loudness(track: np.ndarray, target_rms: float, lo: float = 0.2, hi: float = 4.0) -> np.ndarray:
    rms = float(np.sqrt(np.mean(track**2)) + 1e-12)
    gain = float(np.clip(target_rms / rms, lo, hi))
    return track * gain


def seamless_join(
    path_a: str,
    path_b: str,
    cut_a: Optional[float] = None,
    cut_b: Optional[float] = None,
    crossfade_sec: float = 4.0,
    align_bpm: bool = True,
    align_pitch: bool = True,
) -> np.ndarray:
    """Join track B onto track A with a musical, energy-matched transition."""
    a = load_audio(path_a)
    b = load_audio(path_b)
    dur_a = a.shape[1] / SR
    dur_b = b.shape[1] / SR

    bpm_a = detect_bpm(a)
    bpm_b = detect_bpm(b)
    key_a = detect_key(a)
    key_b = detect_key(b)

    if align_bpm and bpm_b > 0 and bpm_a > 0:
        b = align_to(b, bpm_b, bpm_a, key_b, key_a) if align_pitch else time_stretch(b, bpm_a / bpm_b)
    elif align_pitch:
        b = pitch_shift(b, _key_pc(key_a) - _key_pc(key_b))

    cut_a_s = cut_a if cut_a is not None else min(dur_a * 0.75, dur_a - 1.0)
    cut_b_s = cut_b if cut_b is not None else 0.0
    cut_a_s = float(np.clip(cut_a_s, 0.5, max(0.5, dur_a - 0.5)))
    cut_b_s = float(np.clip(cut_b_s, 0.0, max(0.0, dur_b - 1.0)))

    n_a = int(cut_a_s * SR)
    n_b = int(cut_b_s * SR)
    n_cross = int(crossfade_sec * SR)
    n_cross = max(0, min(n_cross, n_a, b.shape[1] - n_b))

    head = a[:, :n_a].copy()
    tail = b[:, n_b:]
    if n_cross > 0:
        t = np.linspace(0.0, np.pi / 2.0, n_cross, dtype=np.float32)
        fade_out = np.cos(t)[None, :]
        fade_in = np.sin(t)[None, :]
        a_tail = a[:, n_a - n_cross : n_a]
        b_head = b[:, n_b : n_b + n_cross]
        mix = a_tail * fade_out + b_head * fade_in
        body = np.concatenate([mix, tail[:, n_cross:]], axis=1)
    else:
        body = tail

    out = np.concatenate([head, body], axis=1)
    rms_a = float(np.sqrt(np.mean(_mono(a) ** 2)) + 1e-12)
    out = _match_loudness(out, rms_a)
    return _master(out)


def _separate(path: str, device: str, progress_cb: Optional[Callable] = None) -> dict:
    """Separate audio into 6 stems with a cached Demucs htdemucs_6s model."""
    global _device
    with _model_lock:
        if "model" not in _model_cache:
            from demucs.pretrained import get_model

            if progress_cb:
                progress_cb("loading_model", 0, "正在加载 AI 分离模型")
            model = get_model("htdemucs_6s", repo=MODEL_REPO_DIR)
            _device = device if device == "cuda" and os.environ.get("MIXLAB_FORCE_CPU") != "1" else device
            if _device == "cuda":
                import torch

                if not torch.cuda.is_available():
                    _device = "cpu"
            model.to(_device)
            model.eval()
            _model_cache["model"] = model
        model = _model_cache["model"]

    import torch
    from demucs.apply import apply_model

    wav = load_audio(path)
    x = torch.from_numpy(wav).unsqueeze(0).to(_device)
    with torch.no_grad():
        sources = apply_model(model, x, device=_device, shifts=0, split=True, overlap=0.25)[0]
    sources = sources.cpu().numpy()
    return {name: sources[i] for i, name in enumerate(model.sources)}


def separate_to_files(path: str, out_dir: str, device: str = "cuda", progress_cb: Optional[Callable] = None) -> dict:
    stems = _separate(path, device, progress_cb)
    os.makedirs(out_dir, exist_ok=True)
    paths = {}
    for name, audio in stems.items():
        dst = os.path.join(out_dir, f"{name}.wav")
        save_audio(dst, audio)
        paths[name] = dst
    return paths


def smart_fusion(
    path_a: str,
    path_b: str,
    mode: str = "vocal_swap",
    b_volume: float = 1.0,
    keep_a_bed: float = 0.25,
    use_b_drums: bool = False,
    align: bool = True,
    device: str = "cuda",
    progress_cb: Optional[Callable] = None,
) -> np.ndarray:
    """Fuse two tracks into one with selectable element allocation."""
    a = load_audio(path_a)
    b = load_audio(path_b)
    bpm_a, bpm_b = detect_bpm(a), detect_bpm(b)
    key_a, key_b = detect_key(a), detect_key(b)

    def cb(stage: str, pct: float, msg: str):
        if progress_cb:
            progress_cb(stage, pct, msg)

    if mode == "vocal_swap":
        cb("separate_a", 10, "正在分离歌曲 A（人声 / 鼓 / 贝斯 / 吉他 / 钢琴 / 其他）")
        stems_a = _separate(path_a, device)
        cb("separate_b", 48, "正在分离歌曲 B")
        stems_b = _separate(path_b, device)
        cb("mix", 88, "正在混合：A 的人声 + B 的伴奏")

        vocals_a = stems_a["vocals"]
        acc_b = np.zeros_like(b)
        for name, src in stems_b.items():
            if name != "vocals":
                acc_b = acc_b + src
        if align:
            acc_b = align_to(acc_b, bpm_b, bpm_a, key_b, key_a)
        acc_b = _fit_length(acc_b, a.shape[1])
        bed = np.zeros_like(a)
        for name, src in stems_a.items():
            if name != "vocals":
                bed = bed + src
        out = vocals_a + acc_b * float(b_volume) + bed * float(keep_a_bed)

    elif mode == "a_main":
        cb("align", 30, "正在将歌曲 B 对齐到歌曲 A 的节拍和调性")
        b_aligned = align_to(b, bpm_b, bpm_a, key_b, key_a) if align else b
        if use_b_drums:
            cb("separate_b", 55, "正在提取歌曲 B 的鼓点")
            stems_b = _separate(path_b, device)
            b_aligned = align_to(stems_b["drums"], bpm_b, bpm_a, key_b, key_a) if align else stems_b["drums"]
        cb("mix", 85, "正在混合：A 为主，B 为辅")
        b_aligned = _fit_length(b_aligned, a.shape[1])
        out = a + b_aligned * float(b_volume)

    else:  # balanced
        cb("align", 30, "正在将歌曲 B 对齐到歌曲 A 的节拍和调性")
        b_aligned = align_to(b, bpm_b, bpm_a, key_b, key_a) if align else b
        cb("mix", 85, "正在均衡混合两首歌")
        b_aligned = _fit_length(b_aligned, a.shape[1])
        out = a + b_aligned * float(b_volume)

    cb("master", 94, "正在统一响度并导出")
    return _master(out)
