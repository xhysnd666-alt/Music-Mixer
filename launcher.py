"""MixLab one-click launcher (packaged as MixLab.exe)."""

import ctypes
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

PORT = 8000


def msgbox(title: str, text: str, icon: int = 0x10) -> None:
    ctypes.windll.user32.MessageBoxW(0, text, title, icon)


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def main() -> int:
    if getattr(sys, "frozen", False):
        root = Path(sys.executable).resolve().parent
    else:
        root = Path(__file__).resolve().parent
    py = root / ".venv" / "Scripts" / "python.exe"
    url = f"http://127.0.0.1:{PORT}"

    if not py.exists():
        msgbox(
            "MixLab 启动失败",
            f"找不到运行环境：\n{py}\n\n请确认项目文件夹完整（.venv 目录存在）。",
        )
        return 1

    # 已经在运行就直接打开浏览器
    if port_open(PORT):
        webbrowser.open(url)
        return 0

    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(
        [str(py), "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=str(root),
        creationflags=flags,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    ok = False
    for _ in range(80):
        if port_open(PORT):
            ok = True
            break
        if proc.poll() is not None:
            break
        time.sleep(0.5)

    if not ok:
        msgbox(
            "MixLab 启动失败",
            "服务启动失败。\n\n请运行项目文件夹里的「诊断工具.bat」，把窗口内容截图发给开发者。",
        )
        return 1

    webbrowser.open(url)
    proc.wait()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
