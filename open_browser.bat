@echo off
rem 等待服务启动后打开浏览器
ping -n 5 127.0.0.1 >nul
start "" "http://127.0.0.1:8000"
