PRINTSTREAM by ETNA - offline installers for etna.bat
=====================================================

etna.bat downloads Node.js and PostgreSQL from their official sources when
they are missing. For a server WITHOUT internet access, put these files in
this folder (prereqs\, next to etna.bat) before running etna.bat. They are
never committed to Git (see .gitignore); "npm run package" copies this folder
into the package.

Node.js 24 LTS (only if Node.js 20+ is not installed on the server)
  node-v24.<x>.<y>-x64.msi   https://nodejs.org/dist/latest-v24.x/
  SHASUMS256.txt             from the same folder (the SHA-256 is checked;
                             without it only the OpenJS signature is checked)

PostgreSQL 18 programs (only if PostgreSQL 17+ is not installed)
  postgresql-18.6-5-windows-x64-binaries.zip
                             https://www.enterprisedb.com/download-postgresql-binaries
                             Exactly this file: its SHA-256 is pinned in
                             scripts\server\bootstrap.ps1.

Microsoft Visual C++ runtime (only if it is missing; most servers have it)
  vc_redist.x64.exe          https://aka.ms/vs/17/release/vc_redist.x64.exe
                             (the Microsoft signature is checked)

Bahasa Indonesia: untuk server TANPA internet, taruh file di atas di folder
ini (prereqs\, di samping etna.bat) sebelum menjalankan etna.bat. Hanya yang
belum terpasang di server yang dibutuhkan.
