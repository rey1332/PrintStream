@echo off
rem Runs ETNA as a server: production mode on 127.0.0.1 only, for a Cloudflare
rem Tunnel or reverse proxy (Caddy) in front. Task Scheduler starts it at boot
rem (docs/INSTALL-SERVER.md). Build first with "npm run build" after every update.
rem   etna-server.cmd          port 4028 (production)
rem   etna-server.cmd 4029     another port (staging)
rem If the server stops on its own, it is started again after 10 seconds.
rem Log: storage\logs\server.log
cd /d "%~dp0..\.."
set "PORT=%~1"
if "%PORT%"=="" set "PORT=4028"
if not exist storage\logs mkdir storage\logs
:run
echo [%date% %time%] starting on 127.0.0.1:%PORT% >> storage\logs\server.log
call node_modules\.bin\next.cmd start -H 127.0.0.1 -p %PORT% >> storage\logs\server.log 2>&1
echo [%date% %time%] stopped (exit %errorlevel%), restarting in 10 seconds >> storage\logs\server.log
timeout /t 10 /nobreak >nul
goto run
