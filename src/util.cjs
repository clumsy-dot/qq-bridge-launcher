'use strict';

/**
 * 通用小工具：进程/端口探测、颜色日志、窗口启动、HTTP 调用。
 * 这里刻意不依赖任何第三方包，clone 下来就能跑。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const c = {
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

let totalSteps = 0;
function setTotalSteps(n) {
  totalSteps = n;
}

/**
 * 全局运行模式。
 * dryRun = true 时所有写文件/启动进程的动作都只打印计划，不真正执行 ——
 * 让用户在部署前先看清楚「会改 qq-bridge / SnowLuma 的哪些字段」。
 */
const runtime = {
  dryRun: false,
};

const log = {
  step(n, text) {
    console.log(`\n${c.bold(`[${n}/${totalSteps}]`)} ${text}`);
  },
  ok: (s) => console.log(`  ${c.green('✅')} ${s}`),
  warn: (s) => console.log(`  ${c.yellow('⚠️')} ${s}`),
  info: (s) => console.log(`  ${c.dim('·')} ${s}`),
  raw: (s) => console.log(s),
};

/**
 * 运行 PowerShell 命令并返回 stdout。
 *
 * 两个坑（都踩过）：
 *  1) 必须把 stderr 收起来：PowerShell 的报错是中文的，直接继承到控制台会因为代码页
 *     不匹配变成「◆◆◆◆」乱码。这里统一 pipe 掉，失败就当空结果处理。
 *  2) 命令输出统一声明成 UTF-8，避免重定向时用 OEM 代码页。
 */
function ps(command) {
  try {
    const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${command}`;
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 40000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

/** 把 PowerShell 输出的逗号分隔 PID 列表转成数字数组。 */
function psPids(command) {
  return ps(command)
    .split(/[,\r\n]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** 端口是否在 127.0.0.1 上监听。 */
function tcpOpen(port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 轮询等待 check() 返回真值。 */
async function waitFor(check, timeoutMs, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

/** 写 JSON，覆盖前留时间戳备份，并只保留最近 keep 份。 */
function writeJsonWithBackup(file, data, keep = 20) {
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (fs.existsSync(file)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  try {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.bak-`;
    const olds = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
    for (const old of olds.slice(0, Math.max(0, olds.length - keep))) {
      fs.rmSync(path.join(dir, old), { force: true });
    }
  } catch {}
  return backup;
}

/**
 * 打开一个独立控制台窗口来启动程序。
 *
 * 为什么不用 Node 的 spawn({detached:true})：Windows 上它拿到的是 DETACHED_PROCESS，
 * 批处理窗口根本起不来（实测）。这里生成一个临时包装 .bat，用 start 开新窗口，
 * 再用 cmd /c 执行包装脚本 —— 最稳。
 */
function launchDetached(target, cwd, kind, extraEnv) {
  const wrapper = path.join(os.tmpdir(), `launcher-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.bat`);
  const lines = ['@echo off'];
  if (extraEnv) for (const [key, value] of Object.entries(extraEnv)) lines.push(`set "${key}=${value}"`);
  if (kind === 'bat') lines.push(`start "launcher" /D "${cwd}" cmd /c "${target}"`);
  else lines.push(`start "launcher" /D "${cwd}" "${target}"`);
  lines.push('exit /b 0');
  try {
    fs.writeFileSync(wrapper, `${lines.join('\r\n')}\r\n`, 'utf8');
    execFileSync(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/c', wrapper], {
      stdio: 'ignore',
      windowsHide: false,
      timeout: 20000,
    });
    return true;
  } catch (error) {
    log.warn(`启动失败：${target}（${error?.code || error?.message || error}）`);
    return false;
  }
}

function postJson(port, pathname, headers, body) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', (error) => resolve({ error: error.message }));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
    req.end(body);
  });
}

module.exports = {
  sleep,
  c,
  log,
  setTotalSteps,
  runtime,
  ps,
  psPids,
  tcpOpen,
  waitFor,
  readJson,
  writeJsonWithBackup,
  launchDetached,
  postJson,
};
