@echo off
chcp 65001 >nul
echo 正在停止 MixLab 服务...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*uvicorn*backend.app*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo 已停止。可以放心关闭窗口。
pause
