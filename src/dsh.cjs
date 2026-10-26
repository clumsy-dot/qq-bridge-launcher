'use strict';

/**
 * DeepSeek Harness 桌面端：进程探测、Web 端口发现、启动。
 *
 * 为什么要动态发现端口：DSH 桌面版每次启动分配的本地 Web 端口是随机的，
 * 而 qq-bridge 的 config.json 里 dsh.baseUrl 是写死的，
 * 所以每次启动都要重新探测并写回。
 */

const { log, ps, psPids, waitFor, launchDetached } = require('./util.cjs');

const PROCESS_NAME = 'DeepSeek Harness';

function pids() {
  return psPids(`(Get-Process -Name '${PROCESS_NAME}' -ErrorAction SilentlyContinue | ForEach-Object Id) -join ','`);
}

const running = () => pids().length > 0;

/** 从 DSH 进程树反查它监听的 Web 端口（不依赖任何配置文件）。 */
function webPort() {
  const output = ps(
    `$ids = @(Get-Process -Name '${PROCESS_NAME}' -ErrorAction SilentlyContinue | ForEach-Object Id); ` +
    'if ($ids.Count -gt 0) { (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ' +
    'Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object LocalPort) -join \',\' }',
  );
  const ports = output
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1024);
  return ports.length ? ports[0] : null;
}

/**
 * 确保 DSH 已启动并返回其 Web 端口。
 * @param {string} exePath
 * @param {number} timeoutMs
 */
async function ensureRunning(exePath, timeoutMs = 180000) {
  let port = webPort();
  if (port) return port;

  if (running()) {
    log.info('DSH 进程已在运行，等待它监听 Web 端口…');
  } else {
    log.info('启动 DSH 桌面端…');
    launchDetached(exePath, require('node:path').dirname(exePath), 'exe');
  }
  port = await waitFor(() => webPort(), timeoutMs, 3000);
  return port;
}

module.exports = { PROCESS_NAME, pids, running, webPort, ensureRunning };
