@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ==================================================
echo   MixLab 音乐融合工坊
echo   正在启动本地服务...
echo   稍后浏览器会自动打开 http://127.0.0.1:8000
echo   关闭此窗口即可停止服务
echo ==================================================
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:8000'"

".venv\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port 8000

echo.
echo 服务已停止。
pause
