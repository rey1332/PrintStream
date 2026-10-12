@echo off
rem PRINTSTREAM by ETNA: the one official installer and server manager for
rem Windows 10/11 and Windows Server 2016 or newer (x64). Double-click it; it
rem asks for administrator rights. Then:
rem   scripts\server\bootstrap.ps1  checks the machine and installs Node.js and
rem                                 PostgreSQL when missing (asks first);
rem   scripts\server\manager.mjs    the menu: install, start/stop, health,
rem                                 backups, update, repair, uninstall preparation.
rem It works from a package made with "npm run package", from a source folder
rem (it builds a package first) and, once installed, from ETNA_DATA_ROOT
rem (e.g. D:\ETNA\etna.bat). Guide: README.md, "Deploy di Windows".
setlocal
chcp 65001 >nul

rem 64-bit Windows PowerShell, also when started from a 32-bit program.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if defined PROCESSOR_ARCHITEW6432 set "PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" (
  echo Windows PowerShell 5.1 was not found; it is part of every supported Windows.
  echo Windows PowerShell 5.1 tidak ditemukan; seharusnya ada di setiap Windows yang didukung.
  pause
  exit /b 1
)

rem Administrator rights (fltmc works only for administrators).
fltmc >nul 2>&1
if errorlevel 1 (
  set "ETNA_SELF=%~f0"
  echo Asking for administrator rights... / Meminta hak administrator...
  "%PS%" -NoProfile -Command "try { Start-Process -FilePath $env:ETNA_SELF -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
  if errorlevel 1 (
    echo Administrator rights were refused. Right-click etna.bat, Run as administrator.
    echo Hak administrator ditolak. Klik kanan etna.bat, Run as administrator.
    pause
    exit /b 1
  )
  exit /b 0
)

set "BOOT="
if exist "%~dp0scripts\server\bootstrap.ps1" set "BOOT=%~dp0scripts\server\bootstrap.ps1"
if exist "%~dp0app\current\scripts\server\bootstrap.ps1" set "BOOT=%~dp0app\current\scripts\server\bootstrap.ps1"
if exist "%~dp0app\scripts\server\bootstrap.ps1" set "BOOT=%~dp0app\scripts\server\bootstrap.ps1"
if not defined BOOT (
  echo The ETNA app was not found next to this file.
  echo Aplikasi ETNA tidak ditemukan di samping file ini.
  pause
  exit /b 1
)

title PRINTSTREAM - ETNA
rem Bypass applies to this one run only; the machine's execution policy is not changed.
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%BOOT%" -Launcher "%~dp0."
set "CODE=%errorlevel%"
if not "%CODE%"=="0" pause
exit /b %CODE%
