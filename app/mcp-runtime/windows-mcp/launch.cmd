@echo off
setlocal
set PYTHONDONTWRITEBYTECODE=1
"%~dp0..\..\python\python.exe" "%~dp0launch.py" serve --transport stdio %*
