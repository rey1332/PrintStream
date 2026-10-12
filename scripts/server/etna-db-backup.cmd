@echo off
rem Daily backup of one ETNA database. Runs ON THE DATABASE SERVER from Task
rem Scheduler (docs/INSTALL-SERVER.md, langkah 4); copy this file there.
rem   etna-db-backup.cmd <database> <port> <folder>
rem   etna-db-backup.cmd etna 5432 D:\etna-backup\production
rem   etna-db-backup.cmd etna_staging 5433 D:\etna-backup\staging
rem Connects as etna_owner on localhost. The password comes from the PostgreSQL
rem password file of the Windows account that runs the task
rem (%APPDATA%\postgresql\pgpass.conf); -w fails instead of waiting for input.
rem Keeps 14 daily dumps plus the dump of the 1st of each month for a year.
setlocal
set "DB=%~1"
set "PORT=%~2"
set "DIR=%~3"
if "%DIR%"=="" (
  echo Usage: etna-db-backup.cmd database port folder
  exit /b 2
)
if "%PGBIN%"=="" set "PGBIN=C:\Program Files\PostgreSQL\18\bin"
if not exist "%DIR%\monthly" mkdir "%DIR%\monthly"
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"
set "FILE=%DIR%\%DB%-%STAMP%.dump"

"%PGBIN%\pg_dump.exe" -w -h localhost -p %PORT% -U etna_owner -d %DB% -Fc -f "%FILE%"
if errorlevel 1 (
  echo [%date% %time%] FAILED %DB% >> "%DIR%\backup.log"
  if exist "%FILE%" del "%FILE%"
  exit /b 1
)
echo [%date% %time%] ok %DB%-%STAMP%.dump >> "%DIR%\backup.log"

if "%STAMP:~6,2%"=="01" copy /y "%FILE%" "%DIR%\monthly\" >nul
forfiles /p "%DIR%" /m "%DB%-*.dump" /d -14 /c "cmd /c del @path" >nul 2>nul
forfiles /p "%DIR%\monthly" /m "%DB%-*.dump" /d -366 /c "cmd /c del @path" >nul 2>nul
exit /b 0
