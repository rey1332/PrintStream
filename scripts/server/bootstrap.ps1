# PRINTSTREAM by ETNA: the first part of etna.bat (the one official installer).
#
#   etna.bat  →  powershell -ExecutionPolicy Bypass -File bootstrap.ps1 -Launcher <folder of etna.bat>
#
# Runs as administrator before the server manager (manager.mjs) and makes the
# machine ready for it, changing nothing without a confirmation:
#   1. checks Windows (10/11, Server 2016+), x64, administrator rights, the
#      free space on the system drive and, only when something must be
#      downloaded, the internet connection;
#   2. Node.js: uses an installed Node.js 20+; installs Node.js 24 LTS (the
#      official MSI, SHA-256 from nodejs.org and the OpenJS signature checked)
#      only when Node.js is missing, and never upgrades one without asking;
#   3. PostgreSQL: uses installed server programs 17+ in
#      %ProgramFiles%\PostgreSQL\<n>; otherwise unpacks the official EDB
#      binaries of PostgreSQL 18 (pinned SHA-256) to %ProgramFiles%\PostgreSQL\18.
#      Programs only: the manager creates ETNA's own cluster and service
#      (localhost only) when ETNA is installed; other clusters are never touched;
#   4. from a source checkout (no prebuilt package): npm ci and npm run package,
#      then continues with that package;
#   5. opens the manager (its menu: install, start/stop, health, backups,
#      update, repair, uninstall preparation).
#
# Offline servers: put the installers in prereqs\ next to etna.bat
# (prereqs\README.txt). Log: %ProgramData%\ETNA\logs\etna-bat-<time>.log
# (no passwords are ever written there).

param([Parameter(Mandatory = $true)][string]$Launcher)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
# TLS 1.2 for the downloads (older Windows PowerShell defaults to TLS 1.0).
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ─── Versions and sources (change only together with the docs) ───────────────

$NodeMajor = 24            # installed when Node.js is missing
$NodeMin = 20              # oldest Node.js the app runs on
$NodeSigner = 'OpenJS Foundation'
$PgMajor = 18
$PgMin = 17                # oldest PostgreSQL the manager accepts (lib/postgres.mjs)
$PgZip = 'postgresql-18.6-5-windows-x64-binaries.zip'
$PgUrl = "https://get.enterprisedb.com/postgresql/$PgZip"
$PgSha256 = 'e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2'
$VcUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
$MinBuild = 14393          # Windows 10 1607 / Windows Server 2016

$Launcher = [IO.Path]::GetFullPath($Launcher)
$AppDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$Prereqs = Join-Path $Launcher 'prereqs'
$EtnaData = Join-Path $env:ProgramData 'ETNA'
$Downloads = Join-Path $EtnaData 'downloads'
$LogDir = Join-Path $EtnaData 'logs'
New-Item -ItemType Directory -Force -Path $Downloads, $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("etna-bat-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$Summary = New-Object System.Collections.Generic.List[string]
$script:Lang = 'en'

# ─── Output ──────────────────────────────────────────────────────────────────

function T([string]$en, [string]$id) { if ($script:Lang -eq 'id') { $id } else { $en } }
function Log([string]$text) { Add-Content -LiteralPath $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format s), $text) -Encoding UTF8 }
function Say([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color; Log $text }
function Ok([string]$text) { Write-Host '  [OK] ' -ForegroundColor Green -NoNewline; Write-Host $text; Log "OK $text"; $Summary.Add("[OK] $text") }
function Warn([string]$text) { Write-Host '  [!!] ' -ForegroundColor Yellow -NoNewline; Write-Host $text; Log "WARN $text"; $Summary.Add("[!!] $text") }
function Fail([string]$text) { Write-Host '  [XX] ' -ForegroundColor Red -NoNewline; Write-Host $text; Log "FAIL $text"; $Summary.Add("[XX] $text") }

class Stop : Exception { Stop([string]$m) : base($m) { } }
function Halt([string]$text) { Fail $text; throw [Stop]::new($text) }

function Confirm-Change([string]$question) {
  $answer = Read-Host ("{0} [y/n]" -f $question)
  return ($answer -match '^(y|yes|ya)$')
}

function Show-Summary([bool]$good) {
  Write-Host ''
  Write-Host (T '─── etna.bat summary ───' '─── Ringkasan etna.bat ───') -ForegroundColor Cyan
  foreach ($line in $Summary) { Write-Host "  $line" }
  if ($good) { Write-Host (T '  Ready. Opening the ETNA server manager.' '  Siap. Membuka ETNA server manager.') -ForegroundColor Green }
  else { Write-Host (T '  Stopped. Nothing after the failed step was changed.' '  Berhenti. Tidak ada yang diubah setelah langkah yang gagal.') -ForegroundColor Red }
  Write-Host ("  Log: {0}" -f $LogFile)
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-FreeBytes([string]$path) {
  $root = [IO.Path]::GetPathRoot($path)
  return (New-Object IO.DriveInfo $root).AvailableFreeSpace
}

function Test-Online([string]$url) {
  try {
    $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 5
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400)
  } catch { return $false }
}

function Need-Online([string]$url, [string]$what) {
  if (Test-Online $url) { Ok (T "Internet: $(([Uri]$url).Host) reachable" "Internet: $(([Uri]$url).Host) dapat dijangkau"); return }
  Halt (T "No connection to $(([Uri]$url).Host) for $what. Connect this server to the internet, or put the installer in $Prereqs (see prereqs\README.txt) and run etna.bat again." `
          "Tidak ada koneksi ke $(([Uri]$url).Host) untuk $what. Sambungkan server ke internet, atau taruh installer-nya di $Prereqs (lihat prereqs\README.txt) lalu jalankan etna.bat lagi.")
}

# Downloads to <dest>.part first, so an interrupted download never looks complete.
function Get-Download([string]$url, [string]$dest) {
  $part = "$dest.part"
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  for ($try = 1; $try -le 3; $try++) {
    try {
      Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
      Say ("  ↓ {0}" -f $url)
      if (Test-Path -LiteralPath $curl) {
        & $curl -fL --retry 2 --connect-timeout 30 --progress-bar -o $part $url
        if ($LASTEXITCODE -ne 0) { throw "curl exit $LASTEXITCODE" }
      } else {
        Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing -TimeoutSec 3600
      }
      Move-Item -LiteralPath $part -Destination $dest -Force
      return
    } catch {
      Log "download attempt $try failed: $($_.Exception.Message)"
      if ($try -eq 3) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue; Halt (T "Download failed: $url ($($_.Exception.Message))" "Unduhan gagal: $url ($($_.Exception.Message))") }
      Start-Sleep -Seconds (5 * $try)
    }
  }
}

function Assert-Sha256([string]$file, [string]$expected) {
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  if ($actual -ne $expected.ToUpperInvariant()) {
    # Only our own download is deleted; a file the administrator put in prereqs\ stays for them to check.
    if ($file.StartsWith($Downloads, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
    Halt (T "Checksum mismatch for $file (not installed). Get the file again from the official source, then run etna.bat again." `
            "Checksum $file tidak cocok (tidak dipasang). Ambil ulang file dari sumber resmi, lalu jalankan etna.bat lagi.")
  }
  Ok (T "SHA-256 verified: $(Split-Path $file -Leaf)" "SHA-256 terverifikasi: $(Split-Path $file -Leaf)")
}

function Assert-Signed([string]$file, [string]$signer) {
  $sig = Get-AuthenticodeSignature -LiteralPath $file
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch [regex]::Escape($signer)) {
    Halt (T "$(Split-Path $file -Leaf) is not validly signed by $signer ($($sig.Status)). Not installed." `
            "$(Split-Path $file -Leaf) tidak bertanda tangan sah dari $signer ($($sig.Status)). Tidak dipasang.")
  }
  Ok (T "Signature valid ($signer): $(Split-Path $file -Leaf)" "Tanda tangan sah ($signer): $(Split-Path $file -Leaf)")
}

function Update-PathFromRegistry {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Invoke-Msi([string]$msi, [string]$what) {
  $msiLog = Join-Path $LogDir ("msi-{0}-{1}.log" -f $what, (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart', '/l*v', "`"$msiLog`"") -Wait -PassThru
  switch ($p.ExitCode) {
    0 { return }
    3010 { Halt (T "$what is installed but Windows must restart first. Restart, then run etna.bat again." "$what terpasang tetapi Windows harus restart dulu. Restart, lalu jalankan etna.bat lagi.") }
    1618 { Halt (T "Another installation is running (Windows Installer busy). Wait for it to finish, then run etna.bat again." "Ada instalasi lain yang sedang berjalan. Tunggu selesai, lalu jalankan etna.bat lagi.") }
    1602 { Halt (T "$what installation was cancelled." "Instalasi $what dibatalkan.") }
    default { Halt (T "$what installation failed (msiexec $($p.ExitCode)). Details: $msiLog" "Instalasi $what gagal (msiexec $($p.ExitCode)). Rincian: $msiLog") }
  }
}

function Test-PendingReboot {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
  )
  foreach ($k in $keys) { if (Test-Path $k) { return $true } }
  return $false
}

# ─── Node.js ─────────────────────────────────────────────────────────────────

function Find-Node {
  $candidates = New-Object System.Collections.Generic.List[string]
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { $candidates.Add($cmd.Source) }
  $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
  foreach ($c in $candidates) {
    if (-not (Test-Path -LiteralPath $c)) { continue }
    $v = (& $c --version 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $v -match '^v(\d+)\.') {
      return [pscustomobject]@{ Path = $c; Version = $v; Major = [int]$Matches[1] }
    }
  }
  return $null
}

function Install-Node {
  $local = $null
  if (Test-Path -LiteralPath $Prereqs) {
    $local = Get-ChildItem -LiteralPath $Prereqs -Filter "node-v$NodeMajor.*-x64.msi" -File | Sort-Object Name -Descending | Select-Object -First 1
  }
  if ($local) {
    $msi = $local.FullName
    Say (T "  Using $($local.Name) from prereqs\" "  Memakai $($local.Name) dari prereqs\")
    $sums = Join-Path $Prereqs 'SHASUMS256.txt'
    if (Test-Path -LiteralPath $sums) {
      $line = Select-String -LiteralPath $sums -Pattern ([regex]::Escape($local.Name) + '$') | Select-Object -First 1
      if (-not $line) { Halt (T "$($local.Name) is not listed in prereqs\SHASUMS256.txt." "$($local.Name) tidak ada di prereqs\SHASUMS256.txt.") }
      Assert-Sha256 $msi (($line.Line -split '\s+')[0])
    } else {
      Warn (T 'prereqs\SHASUMS256.txt missing: only the signature is checked.' 'prereqs\SHASUMS256.txt tidak ada: hanya tanda tangan yang dicek.')
    }
  } else {
    Need-Online 'https://nodejs.org/dist/index.json' 'Node.js'
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 60
    $release = $index | Where-Object { $_.lts -and $_.version -like "v$NodeMajor.*" -and ($_.files -contains 'win-x64-msi') } | Select-Object -First 1
    if (-not $release) { Halt (T "No Node.js $NodeMajor LTS MSI found on nodejs.org." "Tidak ada MSI Node.js $NodeMajor LTS di nodejs.org.") }
    $name = "node-$($release.version)-x64.msi"
    $base = "https://nodejs.org/dist/$($release.version)"
    $msi = Join-Path $Downloads $name
    $sums = Join-Path $Downloads "SHASUMS256-$($release.version).txt"
    Get-Download "$base/SHASUMS256.txt" $sums
    $line = Select-String -LiteralPath $sums -Pattern ([regex]::Escape($name) + '$') | Select-Object -First 1
    if (-not $line) { Halt (T "$name is not listed in SHASUMS256.txt." "$name tidak ada di SHASUMS256.txt.") }
    if (-not (Test-Path -LiteralPath $msi)) { Get-Download "$base/$name" $msi }
    Assert-Sha256 $msi (($line.Line -split '\s+')[0])
  }
  Assert-Signed $msi $NodeSigner
  Say (T '  Installing Node.js (a few minutes)…' '  Memasang Node.js (beberapa menit)…')
  Invoke-Msi $msi 'Node.js'
  Update-PathFromRegistry
}

# ─── PostgreSQL ──────────────────────────────────────────────────────────────

function Find-Postgres {
  $base = Join-Path $env:ProgramFiles 'PostgreSQL'
  if (-not (Test-Path -LiteralPath $base)) { return $null }
  $dirs = Get-ChildItem -LiteralPath $base -Directory | Where-Object { $_.Name -match '^\d+$' } | Sort-Object { [int]$_.Name } -Descending
  foreach ($d in $dirs) {
    $bin = Join-Path $d.FullName 'bin'
    $need = 'initdb.exe', 'pg_ctl.exe', 'pg_dump.exe', 'pg_restore.exe', 'postgres.exe'
    if (@($need | Where-Object { -not (Test-Path -LiteralPath (Join-Path $bin $_)) }).Count -gt 0) { continue }
    $v = (& (Join-Path $bin 'postgres.exe') -V 2>$null | Out-String).Trim()
    if ($v -match '(\d+)(\.\d+)?') { return [pscustomobject]@{ Bin = $bin; Version = $Matches[0]; Major = [int]$Matches[1] } }
  }
  return $null
}

# The Microsoft Visual C++ runtime the PostgreSQL programs need (present on most servers).
function Install-VcRuntime {
  $exe = Join-Path $Prereqs 'vc_redist.x64.exe'
  if (-not (Test-Path -LiteralPath $exe)) {
    Need-Online $VcUrl 'Microsoft Visual C++ Redistributable'
    $exe = Join-Path $Downloads 'vc_redist.x64.exe'
    Get-Download $VcUrl $exe
  }
  Assert-Signed $exe 'Microsoft Corporation'
  Say (T '  Installing the Microsoft Visual C++ runtime…' '  Memasang Microsoft Visual C++ runtime…')
  $p = Start-Process -FilePath $exe -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
  # 1638: a newer version is already installed.
  if ($p.ExitCode -notin 0, 1638, 3010) { Halt (T "Visual C++ runtime installation failed ($($p.ExitCode))." "Instalasi Visual C++ runtime gagal ($($p.ExitCode)).") }
}

function Install-Postgres {
  $target = Join-Path $env:ProgramFiles "PostgreSQL\$PgMajor"
  if (Test-Path -LiteralPath $target) {
    Halt (T "$target exists but does not hold complete PostgreSQL server programs. etna.bat does not change it: repair or remove that installation yourself, then run etna.bat again." `
            "$target ada tetapi tidak berisi program server PostgreSQL yang lengkap. etna.bat tidak mengubahnya: perbaiki atau hapus instalasi itu sendiri, lalu jalankan etna.bat lagi.")
  }
  $zip = Join-Path $Prereqs $PgZip
  if (Test-Path -LiteralPath $zip) {
    Say (T "  Using $PgZip from prereqs\" "  Memakai $PgZip dari prereqs\")
  } else {
    $zip = Join-Path $Downloads $PgZip
    if (-not (Test-Path -LiteralPath $zip)) {
      Need-Online $PgUrl 'PostgreSQL'
      Get-Download $PgUrl $zip
    }
  }
  Assert-Sha256 $zip $PgSha256

  # Unpacked next to the target and renamed at the end: an interrupted run leaves no half installation.
  $staging = Join-Path $env:ProgramFiles "PostgreSQL\.etna-staging-$PgMajor"
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  Say (T '  Unpacking the PostgreSQL programs (bin, lib, share)…' '  Membongkar program PostgreSQL (bin, lib, share)…')
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $stagingFull = [IO.Path]::GetFullPath($staging) + [IO.Path]::DirectorySeparatorChar
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName -notmatch '^pgsql/(bin|lib|share)/') { continue }
      $rel = $entry.FullName.Substring(6).Replace('/', [IO.Path]::DirectorySeparatorChar)
      $dest = [IO.Path]::GetFullPath((Join-Path $staging $rel))
      if (-not $dest.StartsWith($stagingFull, [StringComparison]::OrdinalIgnoreCase)) { throw "unsafe path in zip: $($entry.FullName)" }
      if ($entry.FullName.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $dest | Out-Null; continue }
      New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
    }
  } finally { $archive.Dispose() }

  $sys = Join-Path $env:SystemRoot 'System32'
  $runtime = 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'
  if (@($runtime | Where-Object { -not (Test-Path -LiteralPath (Join-Path $sys $_)) }).Count -gt 0) {
    if (-not (Confirm-Change (T 'PostgreSQL needs the Microsoft Visual C++ runtime (not found). Install it now (official, signed by Microsoft)?' 'PostgreSQL butuh Microsoft Visual C++ runtime (tidak ditemukan). Pasang sekarang (resmi, ditandatangani Microsoft)?'))) {
      Remove-Item -LiteralPath $staging -Recurse -Force
      Halt (T 'Not installed: the Visual C++ runtime is required.' 'Tidak dipasang: Visual C++ runtime dibutuhkan.')
    }
    Install-VcRuntime
  }
  $v = (& (Join-Path $staging 'bin\postgres.exe') -V 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $v -notmatch 'PostgreSQL') {
    Remove-Item -LiteralPath $staging -Recurse -Force
    Halt (T "The PostgreSQL programs do not start on this machine (exit $LASTEXITCODE)." "Program PostgreSQL tidak bisa berjalan di mesin ini (exit $LASTEXITCODE).")
  }
  Rename-Item -LiteralPath $staging -NewName "$PgMajor"
}

# ─── Source checkout ─────────────────────────────────────────────────────────

function Get-NewestPackage([string]$dist) {
  if (-not (Test-Path -LiteralPath $dist)) { return $null }
  return Get-ChildItem -LiteralPath $dist -Directory -Filter 'ETNA-*' |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'app\etna-package.json') } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

function Invoke-Npm([string]$npm, [string[]]$npmArgs) {
  Say ("  > npm {0}" -f ($npmArgs -join ' '))
  Push-Location -LiteralPath $AppDir
  try { & $npm @npmArgs | Out-Host } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Halt (T "npm $($npmArgs -join ' ') failed (exit $LASTEXITCODE)." "npm $($npmArgs -join ' ') gagal (exit $LASTEXITCODE).") }
}

# ─── Main ────────────────────────────────────────────────────────────────────

function Main {
  $remembered = $null
  try { $remembered = (Get-Content -LiteralPath (Join-Path $EtnaData 'install.json') -Raw | ConvertFrom-Json).language } catch { }
  Write-Host ''
  Write-Host '  PRINTSTREAM · ETNA  —  etna.bat' -ForegroundColor Cyan
  Write-Host '  [1] English'
  Write-Host '  [2] Bahasa Indonesia'
  $default = if ($remembered -eq 'id') { '2' } else { '1' }
  $pick = Read-Host "  Language / Bahasa [$default]"
  if (-not $pick) { $pick = $default }
  $script:Lang = if ($pick -eq '2') { 'id' } else { 'en' }
  Log "etna.bat from $Launcher, app folder $AppDir"

  Write-Host ''
  Write-Host (T '1. Checking this machine' '1. Memeriksa mesin ini') -ForegroundColor Cyan
  $os = Get-CimInstance Win32_OperatingSystem
  $build = [int]$os.BuildNumber
  if ($build -lt $MinBuild) { Halt (T "$($os.Caption) (build $build) is not supported: Windows 10/11 or Windows Server 2016 or newer is needed." "$($os.Caption) (build $build) tidak didukung: butuh Windows 10/11 atau Windows Server 2016 ke atas.") }
  Ok "$($os.Caption) (build $build)"
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($arch -ne 'AMD64') { Halt (T "Processor architecture $arch is not supported (x64 / AMD64 only: PostgreSQL for Windows is x64)." "Arsitektur prosesor $arch tidak didukung (hanya x64 / AMD64: PostgreSQL untuk Windows hanya x64).") }
  Ok (T 'x64 processor' 'Prosesor x64')
  if (-not (Test-Admin)) { Halt (T 'Administrator rights are needed: right-click etna.bat → Run as administrator.' 'Butuh hak administrator: klik kanan etna.bat → Run as administrator.') }
  Ok (T 'Administrator rights' 'Hak administrator')
  if (Test-PendingReboot) { Warn (T 'Windows is waiting for a restart; installing programs may fail until it restarts.' 'Windows menunggu restart; pemasangan program bisa gagal sampai di-restart.') }
  $free = Get-FreeBytes $env:ProgramFiles
  $freeGb = [math]::Round($free / 1GB, 1)
  if ($free -lt 3GB) { Halt (T "Only $freeGb GB free on the system drive; at least 3 GB is needed for Node.js and PostgreSQL." "Hanya $freeGb GB kosong di drive sistem; butuh minimal 3 GB untuk Node.js dan PostgreSQL.") }
  Ok (T "$freeGb GB free on the system drive" "$freeGb GB kosong di drive sistem")

  $isPackage = Test-Path -LiteralPath (Join-Path $AppDir 'etna-package.json')
  $isSource = (-not $isPackage) -and (Test-Path -LiteralPath (Join-Path $AppDir 'package-lock.json')) -and (Test-Path -LiteralPath (Join-Path $AppDir 'src'))
  if ($isPackage) { Ok (T "ETNA package: $AppDir" "Paket ETNA: $AppDir") }
  elseif ($isSource) { Ok (T "ETNA source folder: $AppDir" "Folder source ETNA: $AppDir") }

  Write-Host ''
  Write-Host '2. Node.js' -ForegroundColor Cyan
  $node = Find-Node
  if ($node -and $node.Major -ge $NodeMin) {
    Ok "Node.js $($node.Version) ($($node.Path))"
    if ($node.Major -ne $NodeMajor) { Warn (T "Node.js $NodeMajor LTS is recommended; $($node.Version) is kept as installed." "Node.js $NodeMajor LTS disarankan; $($node.Version) tetap dipakai apa adanya.") }
  } else {
    if ($node) {
      Warn (T "Node.js $($node.Version) is too old (needs $NodeMin+)." "Node.js $($node.Version) terlalu lama (butuh $NodeMin+).")
      $q = T "Install Node.js $NodeMajor LTS? It replaces the Node.js installed with the official installer; other programs using Node.js $($node.Major) may be affected." "Pasang Node.js $NodeMajor LTS? Ini menggantikan Node.js yang dipasang dengan installer resmi; program lain yang memakai Node.js $($node.Major) bisa terpengaruh."
    } else {
      Say (T '  Node.js is not installed.' '  Node.js belum terpasang.')
      $q = T "Install Node.js $NodeMajor LTS (official MSI from nodejs.org, about 30 MB)?" "Pasang Node.js $NodeMajor LTS (MSI resmi dari nodejs.org, sekitar 30 MB)?"
    }
    if (-not (Confirm-Change $q)) { Halt (T 'Node.js is required. Nothing was changed.' 'Node.js dibutuhkan. Tidak ada yang diubah.') }
    Install-Node
    $node = Find-Node
    if (-not $node -or $node.Major -lt $NodeMin) { Halt (T 'Node.js was installed but cannot be found. Restart Windows, then run etna.bat again.' 'Node.js sudah dipasang tetapi tidak ditemukan. Restart Windows, lalu jalankan etna.bat lagi.') }
    Ok (T "Node.js $($node.Version) installed ($($node.Path))" "Node.js $($node.Version) terpasang ($($node.Path))")
  }
  $npm = Join-Path (Split-Path $node.Path) 'npm.cmd'

  Write-Host ''
  Write-Host '3. PostgreSQL' -ForegroundColor Cyan
  $pg = Find-Postgres
  if ($pg -and $pg.Major -ge $PgMin) {
    Ok "PostgreSQL $($pg.Version) ($($pg.Bin))"
  } else {
    if ($pg) { Warn (T "PostgreSQL $($pg.Version) is too old for ETNA (needs $PgMin+); it is left as it is." "PostgreSQL $($pg.Version) terlalu lama untuk ETNA (butuh $PgMin+); dibiarkan apa adanya.") }
    else { Say (T '  PostgreSQL server programs are not installed.' '  Program server PostgreSQL belum terpasang.') }
    $q = T "Install the PostgreSQL $PgMajor programs (official EDB binaries, about 370 MB download) in $env:ProgramFiles\PostgreSQL${PgMajor}? No database or service is created now; ETNA's own (localhost only) is created when you install ETNA." `
           "Pasang program PostgreSQL $PgMajor (binari resmi EDB, unduhan sekitar 370 MB) di $env:ProgramFiles\PostgreSQL${PgMajor}? Belum ada database atau service yang dibuat sekarang; milik ETNA (hanya localhost) dibuat saat ETNA dipasang."
    if (-not (Confirm-Change $q)) {
      Warn (T 'PostgreSQL not installed: installing ETNA will not be possible until it is.' 'PostgreSQL tidak dipasang: ETNA belum bisa dipasang sampai PostgreSQL ada.')
    } else {
      Install-Postgres
      $pg = Find-Postgres
      if (-not $pg -or $pg.Major -lt $PgMin) { Halt (T 'PostgreSQL was unpacked but cannot be found.' 'PostgreSQL sudah dibongkar tetapi tidak ditemukan.') }
      Ok (T "PostgreSQL $($pg.Version) installed ($($pg.Bin))" "PostgreSQL $($pg.Version) terpasang ($($pg.Bin))")
    }
  }

  # Which manager: a package's, a source checkout's (after building a package), or an installed one.
  $manager = Join-Path $AppDir 'scripts\server\manager.mjs'
  if ($isSource) {
    Write-Host ''
    Write-Host (T '4. Source folder: build a package' '4. Folder source: buat paket') -ForegroundColor Cyan
    $dist = Join-Path $AppDir 'dist'
    $newest = Get-NewestPackage $dist
    Write-Host (T '  [1] Build a new package from this source (npm ci, npm run package), then install/update from it' '  [1] Buat paket baru dari source ini (npm ci, npm run package), lalu pasang/update dari paket itu')
    if ($newest) { Write-Host (T "  [2] Use the newest package: $($newest.Name)" "  [2] Pakai paket terbaru: $($newest.Name)") }
    # Managing from the source folder makes sense only once ETNA is installed (installing needs a package).
    $hasInstall = Test-Path -LiteralPath (Join-Path $EtnaData 'install.json')
    if ($hasInstall) { Write-Host (T '  [3] Only manage the existing installation (start/stop, health, backups…)' '  [3] Hanya kelola instalasi yang sudah ada (start/stop, kesehatan, backup…)') }
    Write-Host (T '  [0] Exit' '  [0] Keluar')
    $choice = Read-Host (T '  Select option [1]' '  Pilih opsi [1]')
    if (-not $choice) { $choice = '1' }
    if ($choice -eq '3' -and -not $hasInstall) { $choice = '' }
    switch ($choice) {
      '1' {
        Need-Online 'https://registry.npmjs.org/' 'npm'
        if (-not (Confirm-Change (T "Run npm ci and npm run package in $AppDir (replaces node_modules there, builds the app; several minutes)?" "Jalankan npm ci dan npm run package di $AppDir (mengganti node_modules di sana, membangun aplikasi; beberapa menit)?"))) { Halt (T 'Not built.' 'Tidak dibangun.') }
        $env:Path = "$(Split-Path $node.Path);$env:Path"
        Invoke-Npm $npm @('ci', '--no-audit', '--no-fund')
        Invoke-Npm $npm @('run', 'package')
        $newest = Get-NewestPackage $dist
        if (-not $newest) { Halt (T 'The package was not found in dist\.' 'Paket tidak ditemukan di dist\.') }
        Ok (T "Package built: $($newest.FullName)" "Paket dibuat: $($newest.FullName)")
        $manager = Join-Path $newest.FullName 'app\scripts\server\manager.mjs'
      }
      '2' {
        if (-not $newest) { Halt (T 'No package in dist\.' 'Tidak ada paket di dist\.') }
        $manager = Join-Path $newest.FullName 'app\scripts\server\manager.mjs'
        Ok (T "Package: $($newest.FullName)" "Paket: $($newest.FullName)")
      }
      '3' {
        if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'node_modules\pg'))) { Halt (T 'node_modules is missing here: choose [1] once.' 'node_modules tidak ada di sini: pilih [1] sekali.') }
      }
      default { $script:Manager = $null; return }
    }
  } elseif (-not $isPackage -and -not (Test-Path -LiteralPath $manager)) {
    Halt (T "The ETNA app was not found next to etna.bat ($Launcher)." "Aplikasi ETNA tidak ditemukan di samping etna.bat ($Launcher).")
  }

  Show-Summary $true
  Log "manager: $manager"
  $script:Manager = $manager
  $script:NodePath = $node.Path
}

$script:Manager = $null
$script:NodePath = $null
try {
  Main | Out-Host
  if (-not $script:Manager) { exit 0 }
  $env:ETNA_LANG = $script:Lang
  $env:Path = "$(Split-Path $script:NodePath);$env:Path"
  & $script:NodePath $script:Manager
  exit $LASTEXITCODE
} catch [Stop] {
  Show-Summary $false
  exit 1
} catch {
  Fail ($_.Exception.Message)
  Log ($_ | Out-String)
  Show-Summary $false
  exit 1
}
