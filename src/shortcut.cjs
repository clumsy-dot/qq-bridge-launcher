'use strict';

/**
 * 在桌面创建快捷方式（Windows）。
 *
 * 用 PowerShell 的 WScript.Shell COM 创建 .lnk —— 这是 Windows 上唯一不依赖
 * 第三方工具、也不需要管理员权限的方式。桌面路径用 GetFolderPath('Desktop')
 * 取，能正确兼容中文「桌面」目录。
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { log } = require('./util.cjs');

// 文件名故意和旧版手工快捷方式一致：重复执行会覆盖而不是堆一堆
// 桌面只放一个图标：双击进入菜单（启动 / 换账号 / 预演 / 重建快捷方式）
const SHORTCUT = {
  file: 'QQ 桥接.lnk',
  target: 'launcher.bat',
  description: 'QQ 桥接：启动 / 切换账号 / 预演',
};

// 旧版本创建过的两个图标，安装时顺手清掉，避免桌面上留一堆
const LEGACY_SHORTCUTS = ['一键启动 QQ 桥接.lnk', '选择 QQ 账号.lnk'];

function runPowerShell(script, opts = {}) {
  // 必须先声明 UTF-8 输出编码：否则子进程把中文桌面路径（C:\Users\x\桌面）
  // 按 OEM 代码页输出，Node 按 utf8 解码会变乱码，后续 existsSync 就会判错。
  const full = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', full], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
    ...opts,
  });
}

/** 当前用户的桌面目录（兼容 OneDrive / 中文「桌面」/ 英文 Desktop）。 */
function desktopDir() {
  const candidates = [];
  try {
    const out = runPowerShell("[Environment]::GetFolderPath('Desktop')").trim();
    if (out) candidates.push(out);
  } catch {}
  const home = os.homedir();
  candidates.push(
    path.join(home, '桌面'),
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', '桌面'),
    path.join(home, 'OneDrive', 'Desktop'),
  );
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return path.join(home, 'Desktop');
}

/**
 * 在桌面创建/覆盖**一个**快捷方式（旧的多个图标会被清掉）。
 * @param {string} projectRoot 项目根目录
 * @returns {string[]} 创建成功的 .lnk 路径
 */
function install(projectRoot) {
  if (process.platform !== 'win32') {
    log.warn('只有 Windows 支持创建桌面快捷方式，已跳过');
    return [];
  }
  const desktop = desktopDir();
  const icon = path.join(projectRoot, 'assets', 'icon.ico');
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const created = [];

  // 清理旧版遗留的两个图标，保证桌面只有一个入口
  for (const legacy of LEGACY_SHORTCUTS) {
    const legacyPath = path.join(desktop, legacy);
    if (fs.existsSync(legacyPath)) {
      try {
        fs.rmSync(legacyPath, { force: true });
        log.info(`已移除旧快捷方式：${legacy}`);
      } catch (error) {
        log.warn(`旧快捷方式删不掉（${legacy}）：${error?.message || error}`);
      }
    }
  }

  const target = path.join(projectRoot, SHORTCUT.target);
  if (!fs.existsSync(target)) {
    log.warn(`缺少 ${target}，无法创建桌面快捷方式`);
    return [];
  }
  const linkPath = path.join(desktop, SHORTCUT.file);
  const lines = [
    '$sh = New-Object -ComObject WScript.Shell',
    `$lnk = $sh.CreateShortcut(${quote(linkPath)})`,
    `$lnk.TargetPath = ${quote(target)}`,
    `$lnk.WorkingDirectory = ${quote(projectRoot)}`,
    `$lnk.Description = ${quote(SHORTCUT.description)}`,
    fs.existsSync(icon) ? `$lnk.IconLocation = ${quote(`${icon},0`)}` : '',
    '$lnk.Save()',
  ].filter(Boolean);
  try {
    runPowerShell(lines.join('; '), { stdio: 'ignore' });
    if (fs.existsSync(linkPath)) created.push(linkPath);
    else log.warn(`快捷方式未生成：${linkPath}`);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim().split(/\r?\n/).pop();
    log.warn(`创建快捷方式失败（${SHORTCUT.file}）：${detail}`);
  }

  if (created.length) {
    log.ok(`已在桌面创建快捷方式：${path.basename(created[0])}`);
    log.info(`桌面目录：${desktop}`);
  }
  return created;
}

module.exports = { install, desktopDir, SHORTCUT, LEGACY_SHORTCUTS };
