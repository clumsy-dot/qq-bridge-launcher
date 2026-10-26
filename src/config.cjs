'use strict';

/**
 * 配置文件读写 + 首次运行向导 + 安装位置自动探测。
 *
 * config.json 里是本机路径和你固定的 QQ 号，**不要提交到 git**（.gitignore 已排除）。
 * 仓库里只有 config.example.json 模板。
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { log, ps, readJson } = require('./util.cjs');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const EXAMPLE_FILE = path.join(ROOT, 'config.example.json');

const DEFAULTS = {
  paths: { qq: '', snowluma: '', dsh: '', bridge: '' },
  defaults: { qqNumber: '', portBase: 3000 },
  // 可选：SnowLuma WebUI 密码，用于启动后自动卸载非目标账号的 Hook 注入
  snowlumaWebui: { password: '', unloadOtherAccounts: true },
};

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 读取配置；不存在返回 null。 */
function loadConfig() {
  if (!exists(CONFIG_FILE)) return null;
  const raw = readJson(CONFIG_FILE);
  return {
    paths: { ...DEFAULTS.paths, ...(raw.paths || {}) },
    defaults: { ...DEFAULTS.defaults, ...(raw.defaults || {}) },
    snowlumaWebui: { ...DEFAULTS.snowlumaWebui, ...(raw.snowlumaWebui || {}) },
  };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** 探测 QQ 客户端可执行文件（先看正在运行的进程，再看标准安装位置）。 */
function detectQq() {
  const running = ps("(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)");
  if (exists(running)) return running;
  const candidates = [
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQ\\Bin\\QQ.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Tencent', 'QQNT', 'QQ.exe'),
  ];
  return candidates.find(exists) || '';
}

/**
 * 在常见位置按目录名找安装目录，返回第一个命中的完整路径。
 *
 * 为什么不能只扫 $env:USERPROFILE：实测有机器把用户目录放在 D 盘
 * （`C:\Users\x` 与 `D:\Users\x\Downloads` 并存），只扫 C 盘会漏。
 * 所以这里把三处的浅层目录都列一遍：用户目录、各盘根、以及 `*:\Users\*` 下的
 * 自身 + Downloads/Desktop/Documents。
 */
function scanForDir(filterPattern, markerFile) {
  const script = [
    '$roots = New-Object System.Collections.Generic.List[string]',
    '$roots.Add($env:USERPROFILE)',
    "foreach ($p in @('Downloads','Desktop','Documents')) { $roots.Add((Join-Path $env:USERPROFILE $p)) }",
    "foreach ($base in @('D:\\Users','C:\\Users','D:\\','C:\\')) {",
    '  if (Test-Path $base) {',
    '    $roots.Add($base)',
    '    Get-ChildItem -Path $base -Directory -ErrorAction SilentlyContinue | ForEach-Object {',
    '      $roots.Add($_.FullName)',
    "      foreach ($p in @('Downloads','Desktop','Documents')) { $roots.Add((Join-Path $_.FullName $p)) }",
    '    }',
    '  }',
    '}',
    '$found = $null',
    'foreach ($d in $roots) {',
    '  if ($found) { break }',
    '  if (-not (Test-Path $d)) { continue }',
    `  $hit = Get-ChildItem -Path $d -Directory -Filter '${filterPattern}' -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName '${markerFile}') } | Select-Object -First 1 -ExpandProperty FullName`,
    '  if ($hit) { $found = $hit }',
    '}',
    '$found',
  ].join('\n');
  return ps(script);
}

/** 探测 SnowLuma 安装目录（包含 launcher.bat 与 index.mjs）。 */
function detectSnowLuma() {
  // 1) 正在运行的话，从 node 进程的命令行里直接取（最快最准）
  const commandLine = ps(
    "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.CommandLine -match 'index\\.mjs' -or $_.CommandLine -match 'SnowLuma' } | " +
    'Select-Object -First 1 -ExpandProperty CommandLine)',
  );
  const fromProcess = /([A-Za-z]:\\[^"]*?)\\index\.mjs/i.exec(commandLine);
  if (fromProcess) {
    const dir = fromProcess[1];
    if (exists(path.join(dir, 'launcher.bat')) && exists(path.join(dir, 'index.mjs'))) return dir;
  }
  // 2) 没在运行：按常见位置扫描
  const found = scanForDir('SnowLuma*', 'launcher.bat');
  return exists(path.join(found, 'launcher.bat')) && exists(path.join(found, 'index.mjs')) ? found : '';
}

/** 探测 DeepSeek Harness 桌面端可执行文件（先看正在运行的进程，再看标准安装位置）。 */
function detectDsh() {
  const running = ps("(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)");
  if (exists(running)) return running;
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const candidates = [
    ...programFiles.map((base) => path.join(base, 'DeepSeek Harness', 'DeepSeek Harness.exe')),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
  ];
  return candidates.find(exists) || '';
}

/** 探测 qq-bridge 仓库目录（有 package.json + src/bridge.js + start.bat）。 */
function detectBridge() {
  const isBridge = (dir) => exists(path.join(dir, 'src', 'bridge.js')) && exists(path.join(dir, 'start.bat'));
  const near = [path.join(ROOT, '..', 'qq-bridge'), path.join(ROOT, 'qq-bridge'), process.cwd()];
  for (const dir of near) if (isBridge(dir)) return path.resolve(dir);
  const found = scanForDir('qq-bridge', 'start.bat');
  return isBridge(found) ? found : '';
}

/** 探测全部路径（只填能探测到的）。 */
function detectAll() {
  return {
    qq: detectQq(),
    snowluma: detectSnowLuma(),
    dsh: detectDsh(),
    bridge: detectBridge(),
  };
}

function ask(rl, question, defaultValue) {
  return new Promise((resolve) => {
    const hint = defaultValue ? ` [${defaultValue}]` : '';
    rl.question(`${question}${hint}: `, (answer) => resolve(answer.trim() || defaultValue || ''));
  });
}

/**
 * 问密码：不回显默认值（避免把已保存的密码打印到屏幕上）。
 * 直接回车 = 保留已保存的值；没有已保存值则留空。
 */
function askPassword(rl, question, existingValue) {
  const hint = existingValue ? '（已保存，直接回车保留）' : '（留空跳过）';
  return new Promise((resolve) => {
    rl.question(`${question}${hint}: `, (answer) => {
      const text = answer.trim();
      resolve(text === '' ? existingValue : text);
    });
  });
}

/** 首次运行向导：逐项确认路径 + 可选的固定 QQ 号。 */
async function runWizard() {
  if (!process.stdin.isTTY) {
    throw new Error('首次运行需要在有控制台的环境里执行（双击 setup.bat，或在终端里运行 node src/cli.cjs --init）');
  }
  log.raw('');
  log.raw('首次运行配置向导：直接回车即采用方括号里的自动探测结果。');
  const detected = detectAll();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const qq = await ask(rl, '① QQ 客户端 QQ.exe 路径', detected.qq);
    const snowluma = await ask(rl, '② SnowLuma 安装目录（含 launcher.bat）', detected.snowluma);
    const dsh = await ask(rl, '③ DeepSeek Harness 程序路径（DeepSeek Harness.exe）', detected.dsh);
    const bridge = await ask(rl, '④ qq-bridge 仓库目录（含 start.bat）', detected.bridge);
    const qqNumber = await ask(rl, '⑤ 想固定接入的 QQ 号（留空 = 每次启动时询问/使用上次选择）', '');
    const previous = loadConfig();
    const webuiPassword = await askPassword(
      rl,
      '⑥ SnowLuma WebUI 密码（可选：填写后启动时会自动卸载其它 QQ 账号的 Hook 注入）',
      previous?.snowlumaWebui?.password || '',
    );

    const problems = [];
    if (!exists(qq)) problems.push(`QQ.exe 不存在：${qq}`);
    if (!exists(path.join(snowluma, 'launcher.bat'))) problems.push(`不是 SnowLuma 目录：${snowluma}`);
    if (!exists(dsh)) problems.push(`DeepSeek Harness.exe 不存在：${dsh}`);
    if (!exists(path.join(bridge, 'start.bat'))) problems.push(`不是 qq-bridge 目录：${bridge}`);
    if (qqNumber && !/^\d{5,12}$/.test(qqNumber)) problems.push(`QQ 号格式不对：${qqNumber}`);

    const config = {
      paths: { qq, snowluma, dsh, bridge },
      defaults: { qqNumber: /^\d{5,12}$/.test(qqNumber) ? qqNumber : '', portBase: 3000 },
      snowlumaWebui: { password: webuiPassword, unloadOtherAccounts: true },
    };
    saveConfig(config);

    if (problems.length) {
      log.raw('');
      log.warn('配置已保存，但有几项看起来不对，请检查：');
      problems.forEach((p) => log.raw(`    - ${p}`));
      return { config, problems };
    }
    log.raw('');
    log.ok(`配置已写入 ${CONFIG_FILE}`);
    return { config, problems: [] };
  } finally {
    rl.close();
  }
}

/** 载入配置；没有就尝试向导；非交互环境直接报错。 */
async function ensureConfig({ allowWizard = true } = {}) {
  const config = loadConfig();
  if (config) return config;

  if (!exists(EXAMPLE_FILE)) {
    // 没有模板也能跑：用内置默认值
  }
  if (!allowWizard) {
    throw new Error(`缺少 ${CONFIG_FILE}，请先运行 setup.bat 或 node src/cli.cjs --init`);
  }
  const { config: created } = await runWizard();
  return created;
}

/** 校验配置里的路径都存在，返回问题列表。 */
function validatePaths(config) {
  const problems = [];
  if (!exists(config.paths.qq)) problems.push(`QQ.exe：${config.paths.qq || '(空)'}`);
  if (!exists(path.join(config.paths.snowluma, 'launcher.bat'))) problems.push(`SnowLuma 目录：${config.paths.snowluma || '(空)'}`);
  if (!exists(config.paths.dsh)) problems.push(`DeepSeek Harness.exe：${config.paths.dsh || '(空)'}`);
  if (!exists(path.join(config.paths.bridge, 'start.bat'))) problems.push(`qq-bridge 目录：${config.paths.bridge || '(空)'}`);
  return problems;
}

module.exports = {
  ROOT,
  CONFIG_FILE,
  loadConfig,
  saveConfig,
  detectAll,
  runWizard,
  ensureConfig,
  validatePaths,
  exists,
};
