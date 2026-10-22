@echo off
chcp 65001>nul
cd /d "%~dp0"

rem 优先 pythonw：不弹黑色控制台窗口
where pythonw >nul 2>nul
if %errorlevel%==0 (
  start "" pythonw "%~dp0bili_dl.py"
  exit /b 0
)

where pyw >nul 2>nul
if %errorlevel%==0 (
  start "" pyw "%~dp0bili_dl.py"
  exit /b 0
)

where python >nul 2>nul
if %errorlevel%==0 (
  start "" python "%~dp0bili_dl.py"
  exit /b 0
)

echo.
echo 没找到 Python。请先安装 Python 3.9+（安装时勾选 "Add python.exe to PATH"）
echo 下载地址: https://www.python.org/downloads/windows/
echo.
pause
