@echo off
rem ============================================
rem  AQ 的工作台 · 一键启动
rem  双击这个文件，然后浏览器打开：
rem  http://localhost:5000
rem ============================================
cd /d "%~dp0"
echo.
echo  正在启动 AQ 的工作台...
echo  启动后请在浏览器打开:  http://localhost:5000
echo  关闭这个窗口 = 停止工作台
echo.
python app.py
pause
