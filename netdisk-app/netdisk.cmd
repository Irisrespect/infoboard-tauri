@echo off
rem netdisk CLI launcher -- put this folder on PATH and run:
rem   netdisk ls  "https://pan.quark.cn/s/xxxx"
rem   netdisk get "https://pan.quark.cn/s/xxxx" -o D:\dl -c 32
setlocal
set "HERE=%~dp0netdisk_cli.py"
where python >nul 2>nul
if errorlevel 1 goto :nopython
python "%HERE%" %*
goto :done
:nopython
py -3 "%HERE%" %*
if errorlevel 9009 echo Python not found: install 3.10+ and tick "Add python.exe to PATH"
:done
exit /b %errorlevel%
