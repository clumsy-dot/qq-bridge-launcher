'use strict';

/**
 * SnowLuma 相关：账号发现、多账号端口分配、hook 自动注入、进程启停。
 *
 * 背景（这些是踩坑踩出来的）：
 *   - SnowLuma 每个已登录 QQ 账号各有一份 config/onebot_<QQ号>.json，
 *     里面的 OneBot HTTP/WS 端口默认都是 3000/3001，多账号同时启动必然 EADDRINUSE；
 *   - runtime.json 的 hookAutoLoad=false 时，每次重启都要人工在 WebUI 点「加载进程注入」，
 *     账号才会接入 OneBot；设为 true 后启动时自动注入每个发现的 QQ 进程；
 *   - QQ 客户端自重启（--relaunch）会让已注入的 Hook 失效，SnowLuma 进程还在但 OneBot 端口消失。
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  log,
  ps,
  psPids,
  tcpOpen,
  waitFor,
  sleep,
  readJson,
  writeJsonWithBackup,
  launchDetached,
  runtime,
} = require('./util.cjs');

const configDir = (snowlumaDir) => path.join(snowlumaDir, 'config');
const oneBotFile = (snowlumaDir, uin) => path.join(configDir(snowlumaDir), `onebot_${uin}.json`);
const runtimeFile = (snowlumaDir) => path.join(configDir(snowlumaDir), 'runtime.json');

/** 读取 SnowLuma 里所有曾接入过的 QQ 账号（来自 onebot_<uin>.json）。 */
function discoverAccounts(snowlumaDir) {
  let names = [];
  try {
    names = fs.readdirSync(configDir(snowlumaDir));
  } catch {
    return [];
  }
  const accounts = [];
  for (const name of names) {
    const match = /^onebot_(\d+)\.json$/i.exec(name);
    if (!match) continue;
    const file = path.join(configDir(snowlumaDir), name);
    try {
      const raw = readJson(file);
      const nets = raw.networks || {};
      const httpServer = Array.isArray(nets.httpServers) ? nets.httpServers[0] : null;
      const wsServer = Array.isArray(nets.wsServers) ? nets.wsServers[0] : null;
      if (!httpServer || !wsServer) continue;
      accounts.push({
        uin: match[1],
        file,
        raw,
        httpPort: Number(httpServer.port) || 0,
        wsPort: Number(wsServer.port) || 0,
        httpToken: String(httpServer.accessToken ?? ''),
        wsToken: String(wsServer.accessToken ?? ''),
      });
    } catch {
      // 单个账号文件损坏不影响其它账号
    }
  }
  return accounts.sort((a, b) => a.uin.localeCompare(b.uin));
}

/**
 * 按 QQ 号升序分配稳定端口：第 1 个 portBase/portBase+1，第 2 个 +10，依此类推。
 * 端口只在新账号加入或原来有冲突时才会改动 —— 改动后必须重启 SnowLuma 才生效。
 */
function assignAccountPorts(accounts, portBase = 3000) {
  const changes = [];
  accounts.forEach((account, index) => {
    const wantHttp = portBase + index * 10;
    const wantWs = portBase + 1 + index * 10;
    if (account.httpPort === wantHttp && account.wsPort === wantWs) return;
    const json = account.raw;
    json.networks.httpServers[0].port = wantHttp;
    json.networks.wsServers[0].port = wantWs;
    if (runtime.dryRun) {
      log.info(`（dry-run）将改写 ${path.basename(account.file)}：${account.httpPort}/${account.wsPort} -> ${wantHttp}/${wantWs}`);
    } else {
      writeJsonWithBackup(account.file, json);
    }
    changes.push(`${account.uin}: ${account.httpPort}/${account.wsPort} -> ${wantHttp}/${wantWs}`);
    account.httpPort = wantHttp;
    account.wsPort = wantWs;
  });
  return changes;
}

/** 打开 hookAutoLoad；返回是否改动。 */
function ensureHookAutoLoad(snowlumaDir) {
  const file = runtimeFile(snowlumaDir);
  if (!fs.existsSync(file)) {
    log.warn(`找不到 ${file}（SnowLuma 首次启动后会生成），跳过 hookAutoLoad 设置`);
    return false;
  }
  const runtimeJson = readJson(file);
  if (runtimeJson.hookAutoLoad === true) return false;
  const before = runtimeJson.hookAutoLoad;
  if (runtime.dryRun) {
    log.info(`（dry-run）将把 ${path.basename(file)} 的 hookAutoLoad 从 ${JSON.stringify(before)} 改为 true`);
    return true;
  }
  runtimeJson.hookAutoLoad = true;
  writeJsonWithBackup(file, runtimeJson);
  log.info(`已开启 SnowLuma hookAutoLoad（原值 ${JSON.stringify(before)}）`);
  return true;
}

// ── 进程 ────────────────────────────────────────────────────────────────────

const nodePids = () => psPids(
  "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
  "Where-Object { $_.CommandLine -match 'index\\.mjs' -or $_.CommandLine -match 'SnowLuma' } | " +
  'ForEach-Object ProcessId) -join \',\'',
);

const launcherPids = () => psPids(
  "(Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | " +
  "Where-Object { $_.CommandLine -match 'SnowLuma' -and $_.CommandLine -match 'launcher\\.bat' } | " +
  'ForEach-Object ProcessId) -join \',\'',
);

const running = () => nodePids().length > 0 || launcherPids().length > 0;

function kill(reason) {
  const pids = [...nodePids(), ...launcherPids()];
  if (!pids.length) return;
  log.info(`${reason}: 结束 PID ${pids.join(', ')}`);
  ps(`Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue`);
}

// ── 启动 ────────────────────────────────────────────────────────────────────

/**
 * 启动 SnowLuma（带自动注入环境变量），并等待指定账号的 OneBot 端口出现。
 * @param {string} snowlumaDir
 * @param {Array} accounts 已知账号（用来等端口；为空则只等进程）
 * @param {number} timeoutMs
 */
async function start(snowlumaDir, accounts, timeoutMs = 150000) {
  ensureHookAutoLoad(snowlumaDir);
  const ports = accounts.flatMap((account) => [account.httpPort, account.wsPort]).filter(Boolean);
  if (runtime.dryRun) {
    log.info('（dry-run）将启动 SnowLuma 窗口（不会真的启动）');
    return true;
  }
  log.info('启动 SnowLuma 窗口…');
  launchDetached(path.join(snowlumaDir, 'launcher.bat'), snowlumaDir, 'bat', {
    SNOWLUMA_HOOK_AUTOLOAD: '1',
  });
  if (!ports.length) {
    return Boolean(await waitFor(() => running(), timeoutMs, 2500));
  }
  return Boolean(await waitFor(async () => {
    const states = await Promise.all(ports.map((port) => tcpOpen(port, 500)));
    return states.some(Boolean);
  }, timeoutMs, 2500));
}

/** 确保 SnowLuma 在跑：没跑就启动；在跑但所有已知账号端口都消失就重启。 */
async function ensureRunning(snowlumaDir, accounts, timeoutMs = 150000) {
  const ports = accounts.flatMap((account) => [account.httpPort, account.wsPort]).filter(Boolean);
  if (runtime.dryRun) {
    if (!running()) {
      log.info('（dry-run）SnowLuma 未运行，正式运行时将启动它');
      return;
    }
    if (ports.length) {
      const up = await Promise.all(ports.map((port) => tcpOpen(port, 500)));
      if (!up.some(Boolean)) log.info('（dry-run）SnowLuma 进程在但 OneBot 端口全无，正式运行时将重启它');
      else log.ok('SnowLuma 正在运行，OneBot 端口正常（dry-run 直接复用）');
    } else {
      log.ok('SnowLuma 正在运行（dry-run 直接复用）');
    }
    return;
  }
  if (!running()) {
    await start(snowlumaDir, accounts, timeoutMs);
    return;
  }
  if (!ports.length) return;
  const up = await Promise.all(ports.map((port) => tcpOpen(port, 500)));
  if (up.some(Boolean)) return;
  log.warn('SnowLuma 在跑但 OneBot 端口一个都没起来（常见原因：QQ 客户端自重启导致 Hook 失效），重启它…');
  kill('清理旧 SnowLuma');
  await sleep(2000);
  await start(snowlumaDir, accounts, timeoutMs);
}

/** 重启 SnowLuma（用于应用端口改动）。 */
async function restart(snowlumaDir, accounts, timeoutMs = 150000) {
  if (runtime.dryRun) {
    log.info('（dry-run）将重启 SnowLuma 以应用端口改动（不会真的重启）');
    return;
  }
  kill('重启以应用新端口');
  await sleep(2500);
  await start(snowlumaDir, accounts, timeoutMs);
  await waitFor(async () => {
    const states = await Promise.all(accounts.map((account) => tcpOpen(account.httpPort, 500)));
    return states.some(Boolean);
  }, 60000, 2500);
}

module.exports = {
  configDir,
  oneBotFile,
  runtimeFile,
  discoverAccounts,
  assignAccountPorts,
  ensureHookAutoLoad,
  nodePids,
  launcherPids,
  running,
  kill,
  start,
  restart,
  ensureRunning,
};
