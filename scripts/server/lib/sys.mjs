// Windows plumbing for the server manager: commands, services, scheduled
// tasks, the local service account, folder permissions, drives and ports.
// Passwords are passed to PowerShell on stdin, never on a command line
// (command lines are visible to every process on the machine).

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function run(command, args = [], { input, cwd, env, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Runs and throws with the last lines of the error output when it fails. */
export async function mustRun(command, args = [], options = {}) {
  const r = await run(command, args, options);
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-4).join(' ');
    throw new Error(`${path.basename(command)} failed (${r.code}): ${tail}`);
  }
  return r.stdout;
}

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

export function powershell(script, options = {}) {
  return run('powershell.exe', [...PS, script], options);
}

export async function psJson(script) {
  const r = await powershell(`${script} | ConvertTo-Json -Compress -Depth 4`);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  try {
    const value = JSON.parse(r.stdout);
    return value;
  } catch {
    return null;
  }
}

/** A single-quoted PowerShell string literal. */
export const psq = (value) => `'${String(value).replace(/'/g, "''")}'`;

export const randomPassword = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

export async function isAdmin() {
  return (await run('net.exe', ['session'])).code === 0;
}

// ─── Machine ─────────────────────────────────────────────────────────────────

export async function drives() {
  const list = await psJson(
    `Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,FreeSpace,Size,VolumeName`
  );
  return (Array.isArray(list) ? list : list ? [list] : [])
    .map((d) => ({ letter: d.DeviceID, free: Number(d.FreeSpace) || 0, size: Number(d.Size) || 0, label: d.VolumeName || '' }))
    .sort((a, b) => a.letter.localeCompare(b.letter));
}

/** Free bytes on the disk holding a folder (or its nearest existing parent). */
export function freeSpace(dir) {
  let at = path.resolve(dir);
  while (!fs.existsSync(at)) {
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
  try {
    const s = fs.statfsSync(at);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export async function windowsInfo() {
  const osInfo = await psJson(`Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber`);
  const cpus = os.cpus();
  return {
    windows: osInfo ? `${osInfo.Caption} (${osInfo.Version})` : `${os.type()} ${os.release()}`,
    build: osInfo ? Number(osInfo.BuildNumber) : null,
    cpu: cpus[0]?.model?.trim() || 'unknown',
    cores: cpus.length,
    ramTotal: os.totalmem(),
    ramFree: os.freemem(),
    hostname: os.hostname(),
  };
}

export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

export function portOpen(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function httpStatus(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

export async function waitFor(check, { timeoutMs = 90_000, everyMs = 2000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

// ─── Services ────────────────────────────────────────────────────────────────

/** 'missing' | 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown' */
export async function serviceState(name) {
  const r = await run('sc.exe', ['query', name]);
  if (r.code === 1060 || /1060/.test(r.stdout)) return 'missing';
  const m = r.stdout.match(/STATE\s*:\s*\d+\s+(\w+)/);
  if (!m) return r.code === 0 ? 'unknown' : 'missing';
  return { RUNNING: 'running', STOPPED: 'stopped', START_PENDING: 'starting', STOP_PENDING: 'stopping' }[m[1]] || 'unknown';
}

export async function startService(name) {
  if ((await serviceState(name)) === 'running') return;
  await mustRun('net.exe', ['start', name]);
}

export async function stopService(name) {
  if ((await serviceState(name)) !== 'running') return;
  await mustRun('net.exe', ['stop', name]);
}

// ─── Local service account ───────────────────────────────────────────────────

export async function localUserExists(name) {
  const r = await powershell(`if (Get-LocalUser -Name ${psq(name)} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`);
  return r.stdout.trim() === 'yes';
}

/** Creates the account, or gives it a new password. No admin rights, never expires. */
export async function setLocalUser(name, password, description) {
  const script = [
    '$p = [Console]::In.ReadLine() | ConvertTo-SecureString -AsPlainText -Force',
    `$u = Get-LocalUser -Name ${psq(name)} -ErrorAction SilentlyContinue`,
    `if ($u) { Set-LocalUser -Name ${psq(name)} -Password $p -PasswordNeverExpires $true }`,
    `else { New-LocalUser -Name ${psq(name)} -Password $p -PasswordNeverExpires -UserMayNotChangePassword -Description ${psq(description)} | Out-Null }`,
  ].join('; ');
  const r = await powershell(script, { input: `${password}\n` });
  if (r.code !== 0) throw new Error(`Could not set up the Windows account ${name}: ${r.stderr.trim().split(/\r?\n/)[0]}`);
}

// ─── Scheduled tasks ─────────────────────────────────────────────────────────

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function taskXml({ description, trigger, command, args, workDir, timeLimit }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xmlEscape(description)}</Description></RegistrationInfo>
  <Triggers>${trigger}</Triggers>
  <Principals><Principal id="Author"><LogonType>Password</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>${timeLimit}</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

const quoteArg = (a) => `"${String(a).replace(/"/g, '')}"`;

/** Starts ETNA when Windows starts, and keeps it running (no time limit). */
export function serverTaskXml({ node, runner, root, workDir }) {
  return taskXml({
    description: 'ETNA server (starts at boot; restarts the app if it stops). Managed by the ETNA server manager.',
    trigger: '<BootTrigger><Enabled>true</Enabled><Delay>PT30S</Delay></BootTrigger>',
    command: node,
    args: `${quoteArg(runner)} --root ${quoteArg(root)}`,
    workDir,
    timeLimit: 'PT0S',
  });
}

/** A full backup every day at HH:MM (made up later if the server was off). */
export function backupTaskXml({ node, manager, root, workDir, time }) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Time must be HH:MM');
  return taskXml({
    description: 'ETNA daily full backup. Managed by the ETNA server manager.',
    trigger: `<CalendarTrigger><StartBoundary>2026-01-01T${time}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`,
    command: node,
    args: `${quoteArg(manager)} backup --auto --root ${quoteArg(root)}`,
    workDir,
    timeLimit: 'PT6H',
  });
}

export async function registerTask(folder, name, xml, user, password) {
  const tmp = path.join(os.tmpdir(), `etna-task-${process.pid}-${Date.now()}.xml`);
  fs.writeFileSync(tmp, xml, 'utf8');
  try {
    const script = [
      '$p = [Console]::In.ReadLine()',
      `$x = Get-Content -Raw -LiteralPath ${psq(tmp)}`,
      `Register-ScheduledTask -TaskPath ${psq(folder)} -TaskName ${psq(name)} -Xml $x -User ${psq(user)} -Password $p -Force | Out-Null`,
    ].join('; ');
    const r = await powershell(script, { input: `${password}\n` });
    if (r.code !== 0) throw new Error(`Could not register the task ${name}: ${r.stderr.trim().split(/\r?\n/)[0]}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** { exists, state: 'Ready' | 'Running' | 'Disabled' | ..., lastRun, lastResult } */
export async function taskInfo(folder, name) {
  const info = await psJson(
    `$t = Get-ScheduledTask -TaskPath ${psq(folder)} -TaskName ${psq(name)} -ErrorAction SilentlyContinue; ` +
      `if ($t) { $i = $t | Get-ScheduledTaskInfo; [pscustomobject]@{ State = "$($t.State)"; LastRun = $i.LastRunTime.ToString('o'); LastResult = $i.LastTaskResult } }`
  );
  if (!info) return { exists: false };
  return { exists: true, state: info.State, lastRun: info.LastRun, lastResult: info.LastResult };
}

export const runTask = (folder, name) => mustRun('schtasks.exe', ['/Run', '/TN', `${folder}${name}`]);
export const endTask = (folder, name) => run('schtasks.exe', ['/End', '/TN', `${folder}${name}`]);

// ─── Folders ─────────────────────────────────────────────────────────────────

export const icacls = (target, args) => mustRun('icacls.exe', [target, ...args, '/Q']);

/** Points a junction at a folder (replacing an existing junction, never a real folder). */
export function setJunction(link, target) {
  if (fs.existsSync(link) || isLink(link)) {
    if (!isLink(link)) throw new Error(`${link} is a real folder, not a junction`);
    fs.rmdirSync(link);
  }
  fs.symlinkSync(target, link, 'junction');
}

export function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function junctionTarget(link) {
  try {
    return fs.readlinkSync(link).replace(/^\\\\\?\\/, '').replace(/\\$/, '');
  } catch {
    return null;
  }
}

/** Total size and file count of a folder. */
export function folderStats(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          // Gone meanwhile.
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { bytes, files };
}

export function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
