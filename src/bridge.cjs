'use strict';

/**
 * qq-bridge 侧：配置改写、账号钉定、控制台重启、日志状态。
 *
 * 关键点：桥接的 SnowLuma token 自愈默认会"谁先连上就用谁"，
 * 多账号场景下必须把 snowluma.followDiscoveredEndpoint 设为 false，
 * 并把 wsUrl/httpUrl/accessToken 钉到选定账号上，否则桥接可能偷偷切到另一个账号。
 */

const fs = require('node:fs');
const path = require('node:path');
const { log, tcpOpen, waitFor, readJson, writeJsonWithBackup, postJson, launchDetached, runtime } = require('./util.cjs');

const configFile = (bridgeDir) => path.join(bridgeDir, 'config.json');
const logFile = (bridgeDir) => path.join(bridgeDir, 'state', 'bridge.log');
const tokenFile = (bridgeDir) => path.join(bridgeDir, 'state', 'console-token');
const activeQqFile = (bridgeDir) => path.join(bridgeDir, 'state', 'active-qq.txt');

const readConfig = (bridgeDir) => readJson(configFile(bridgeDir));

/** 把 DSH 当前端口写进桥接配置。 */
function syncDshPort(bridgeDir, dshWebPort) {
  const config = readConfig(bridgeDir);
  const changes = [];
  const want = `http://127.0.0.1:${dshWebPort}`;
  if (config.dsh.baseUrl !== want) {
    changes.push(`dsh.baseUrl: ${config.dsh.baseUrl} -> ${want}`);
    config.dsh.baseUrl = want;
  }
  if (config.dsh.authToken !== '') {
    changes.push('dsh.authToken: 清空（改用 ~/.dsh/.credentials.yaml 离线铸 Cookie）');
    config.dsh.authToken = '';
  }
  if (!changes.length) return { changes, backup: null };
  if (runtime.dryRun) {
    log.info('（dry-run）将写入桥接 config.json：' + changes.join('；'));
    return { changes, backup: null };
  }
  return { changes, backup: writeJsonWithBackup(configFile(bridgeDir), config) };
}

/** 把桥接钉在指定 SnowLuma 账号上。 */
function pinAccount(bridgeDir, snowlumaDir, account) {
  const config = readConfig(bridgeDir);
  const changes = [];
  const want = {
    wsUrl: `ws://127.0.0.1:${account.wsPort}`,
    httpUrl: `http://127.0.0.1:${account.httpPort}`,
    accessToken: account.httpToken,
    followDiscoveredEndpoint: false,
    homeDir: snowlumaDir.replace(/\\/g, '/'),
  };
  for (const [key, value] of Object.entries(want)) {
    if (String(config.snowluma[key] ?? '') !== String(value)) {
      changes.push(`snowluma.${key}`);
      config.snowluma[key] = value;
    }
  }
  if (!changes.length) return { changes, backup: null };
  if (runtime.dryRun) {
    log.info('（dry-run）将写入桥接 config.json：' + changes.join('；'));
    return { changes, backup: null };
  }
  return { changes, backup: writeJsonWithBackup(configFile(bridgeDir), config) };
}

function consolePort(bridgeDir) {
  try {
    const config = readConfig(bridgeDir);
    const port = Number(config.consolePort);
    return Number.isInteger(port) && port > 0 ? port : 3100;
  } catch {
    return 3100;
  }
}

const consoleUp = (bridgeDir) => tcpOpen(consolePort(bridgeDir));

/** 读取控制台 token（必须带 x-console-token 头才能调破坏性接口）。 */
function consoleToken(bridgeDir) {
  try {
    return fs.readFileSync(tokenFile(bridgeDir), 'utf8').trim();
  } catch {
    return '';
  }
}

/** 通过控制台 API 重启桥接（守护窗口会自动拉起）。 */
async function restart(bridgeDir) {
  if (runtime.dryRun) {
    log.info('（dry-run）将通过控制台 API 重启桥接（不会真的重启）');
    return true;
  }
  const port = consolePort(bridgeDir);
  const token = consoleToken(bridgeDir);
  const res = await postJson(port, '/api/restart', token ? { 'x-console-token': token } : {}, '{}');
  if (res.status !== 200) {
    log.warn(`重启桥接失败：${res.error || res.body}`);
    return false;
  }
  const back = await waitFor(() => tcpOpen(port), 45000, 1500);
  return Boolean(back);
}

/** 启动桥接守护窗口。 */
function start(bridgeDir) {
  if (runtime.dryRun) {
    log.info('（dry-run）将启动桥接 start.bat 守护窗口（不会真的启动）');
    return true;
  }
  return launchDetached(path.join(bridgeDir, 'start.bat'), bridgeDir, 'bat');
}

/**
 * 读取桥接日志：最后几行 + 本次启动会话内的连接状态。
 * 不能只看末尾几行 —— 启动时的「SnowLuma 已连接」会被后续聊天日志顶掉。
 */
function status(bridgeDir, tailLines = 6) {
  try {
    const lines = fs.readFileSync(logFile(bridgeDir), 'utf8').trimEnd().split(/\r?\n/);
    let sessionStart = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].includes('桥接已启动')) {
        sessionStart = i;
        break;
      }
    }
    const session = sessionStart >= 0 ? lines.slice(sessionStart) : lines;
    return {
      tail: lines.slice(-tailLines),
      snowlumaConnected: session.some((line) => line.includes('SnowLuma 已连接')),
      dshReady: session.some((line) => line.includes('DSH 已就绪')),
      healFailed: session.filter((line) => line.includes('token 自愈失败')).length,
    };
  } catch {
    return { tail: [], snowlumaConnected: false, dshReady: false, healFailed: 0 };
  }
}

function rememberAccount(bridgeDir, uin) {
  if (runtime.dryRun) {
    let current = '';
    try { current = fs.readFileSync(activeQqFile(bridgeDir), 'utf8').trim(); } catch {}
    if (current !== String(uin)) log.info(`（dry-run）将把当前账号 ${uin} 写入 state/active-qq.txt`);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(activeQqFile(bridgeDir)), { recursive: true });
    fs.writeFileSync(activeQqFile(bridgeDir), `${uin}\n`, 'utf8');
  } catch (error) {
    log.warn(`记录 active-qq 失败：${error.message}`);
  }
}

function rememberedAccount(bridgeDir) {
  try {
    const value = fs.readFileSync(activeQqFile(bridgeDir), 'utf8').trim();
    return /^\d+$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

module.exports = {
  configFile,
  logFile,
  readConfig,
  syncDshPort,
  pinAccount,
  consolePort,
  consoleUp,
  consoleToken,
  restart,
  start,
  status,
  rememberAccount,
  rememberedAccount,
};
