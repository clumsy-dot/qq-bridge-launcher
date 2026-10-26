'use strict';

/**
 * SnowLuma WebUI 接口（本地 127.0.0.1）：
 *   POST /api/login                     { password } -> token
 *   GET  /api/processes                 x-snowluma-token: <token> -> { list: [{pid, uin, ...}] }
 *   POST /api/processes/<pid>/unload    x-snowluma-token: <token>
 *
 * 用途：SnowLuma 的 hookAutoLoad 会注入**所有**发现的 QQ 进程（没有按账号过滤的配置项），
 * 启动后调用这里的 unload 接口，把非目标账号的注入卸掉，面板上就只剩要用的那个号。
 *
 * 注意：unload 只在当前运行期有效；SnowLuma 重启后 hookAutoLoad 会再次注入，
 * 所以本工具每次启动都会做一遍。
 */

const http = require('node:http');
const { log } = require('./util.cjs');

const DEFAULT_WEBUI_PORT = 5099;

function request({ port, method, path, token, body, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (token) headers['x-snowluma-token'] = token;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', (error) => resolve({ status: 0, error: error.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ status: 0, error: 'timeout' });
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** 登录 WebUI，返回 { token } 或 { error }。 */
async function login(port, password) {
  const res = await request({ port, method: 'POST', path: '/api/login', body: { password } });
  if (res.status === 0) return { error: `连不上 SnowLuma WebUI（127.0.0.1:${port}）：${res.error}` };
  if (res.status === 429) return { error: '登录尝试过多，已被 SnowLuma 临时限速，请稍后再试' };
  if (res.json?.needsTotp) return { error: 'SnowLuma 开了两步验证（TOTP），无法自动登录' };
  if (!res.json?.success || !res.json?.token) return { error: res.json?.message || `登录失败（HTTP ${res.status}）` };
  return { token: res.json.token };
}

/** 列出当前已注入的进程。 */
async function listProcesses(port, token) {
  const res = await request({ port, method: 'GET', path: '/api/processes', token });
  if (res.status !== 200 || !Array.isArray(res.json?.list)) {
    return { error: res.json?.message || res.error || `读取进程列表失败（HTTP ${res.status}）` };
  }
  return { list: res.json.list };
}

/** 卸载指定 PID 的注入。 */
async function unload(port, token, pid) {
  const res = await request({ port, method: 'POST', path: `/api/processes/${pid}/unload`, token });
  if (res.status === 200 && res.json?.success) return { ok: true };
  return { ok: false, error: res.json?.message || res.error || `HTTP ${res.status}` };
}

/**
 * 卸载所有「不是 keepUin」的账号注入。
 * @returns {Promise<{skipped?:string, unloaded?:Array<{uin:string,pid:number}>, failed?:Array<{uin:string,pid:number,error:string}>}>}
 */
async function unloadOtherAccounts({ port = DEFAULT_WEBUI_PORT, password, keepUin }) {
  if (!password) return { skipped: '未配置 SnowLuma WebUI 密码' };

  const auth = await login(port, password);
  if (auth.error) return { skipped: auth.error };

  const listed = await listProcesses(port, auth.token);
  if (listed.error) return { skipped: listed.error };

  const unloaded = [];
  const failed = [];
  for (const item of listed.list) {
    const uin = String(item?.uin ?? '');
    const pid = Number(item?.pid);
    if (!uin || !Number.isInteger(pid) || pid <= 0) continue;
    if (uin === String(keepUin)) continue;
    const result = await unload(port, auth.token, pid);
    if (result.ok) unloaded.push({ uin, pid });
    else failed.push({ uin, pid, error: result.error });
  }
  return { unloaded, failed };
}

module.exports = { login, listProcesses, unload, unloadOtherAccounts, DEFAULT_WEBUI_PORT };
