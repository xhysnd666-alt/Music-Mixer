@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MixLab 音乐融合工坊

echo ==================================================
echo   MixLab 音乐融合工坊
echo   正在启动本地服务...
echo   稍后浏览器会自动打开 http://127.0.0.1:8000
echo   关闭此窗口即可停止服务
echo ==================================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [错误] 找不到 Python 运行环境，项目可能不完整。
    echo 请重新获取完整项目后再试。
    echo.
    pause
    exit /b 1
)

start "" /min "%~dp0open_browser.bat"

".venv\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port 8000

echo.
echo 服务已停止。
pause
