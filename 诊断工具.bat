@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MixLab 诊断工具

echo ==================================================
echo   MixLab 诊断工具
echo   下面的信息如果出错，请完整截图发给开发者
echo ==================================================
echo.

echo [1/3] Python 环境检查
".venv\Scripts\python.exe" -c "import sys; print('Python:', sys.version.split()[0]); print('路径:', sys.executable)"
if errorlevel 1 (
    echo [错误] Python 环境无法运行！
    pause
    exit /b 1
)
echo.

echo [2/3] 显卡检查
".venv\Scripts\python.exe" -c "import torch; print('CUDA 可用:', torch.cuda.is_available())"
echo.

echo [3/3] 启动服务（关闭窗口或按 Ctrl+C 停止）
".venv\Scripts\python.exe" -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
echo.
echo 如果上面出现红色错误，请截图发给开发者。
pause
