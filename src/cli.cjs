#!/usr/bin/env node
'use strict';

/**
 * qq-bridge-launcher 入口。
 *
 *   node src/cli.cjs                 一键启动（账号取自 参数 > 配置 > 上次选择 > 询问）
 *   node src/cli.cjs --init          首次配置向导（也可双击 setup.bat）
 *   node src/cli.cjs --ask           强制重新选择要接入的 QQ 账号
 *   node src/cli.cjs --qq 1234567    指定 QQ 号
 *   node src/cli.cjs --list          列出 SnowLuma 里已接入的账号
 */

const path = require('node:path');
const readline = require('node:readline');
const {
  sleep,
  c,
  log,
  setTotalSteps,
  runtime,
  psPids,
  tcpOpen,
  waitFor,
  launchDetached,
} = require('./util.cjs');
const configModule = require('./config.cjs');
const dsh = require('./dsh.cjs');
const snowluma = require('./snowluma.cjs');
const bridge = require('./bridge.cjs');

const TOTAL_STEPS = 6;

// ── 命令行 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { init: false, ask: false, list: false, help: false, dryRun: false, qq: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--init') args.init = true;
    else if (arg === '--ask') args.ask = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--qq') {
      args.qq = String(argv[i + 1] || '').trim();
      i += 1;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
用法：node src/cli.cjs [选项]

  （无参数）        一键启动整条链路
  --init            首次运行配置向导
  --ask             强制重新选择要接入的 QQ 账号
  --qq <QQ号>       指定要接入的 QQ 账号
  --list            列出 SnowLuma 里已接入的账号
  --dry-run         预演：只打印「将修改哪些文件/启动哪些程序」，不写入、不启动
  -h, --help        显示本帮助

注意：正式运行会改写 qq-bridge 与 SnowLuma 的配置文件（详见 README「部署时会修改什么」）。
建议首次部署先执行一次 --dry-run 看清楚。
`);
}

// ── QQ 客户端 ───────────────────────────────────────────────────────────────

const qqPids = () => psPids("(Get-Process -Name 'QQ' -ErrorAction SilentlyContinue | ForEach-Object Id) -join ','");
const qqRunning = () => qqPids().length > 0;

async function ensureQq(exePath) {
  if (qqRunning()) {
    log.ok('QQ 已在运行');
    return true;
  }
  if (runtime.dryRun) {
    log.info('（dry-run）QQ 未运行，正式运行时将启动它');
    return true;
  }
  log.info('启动 QQ…');
  launchDetached(exePath, path.dirname(exePath), 'exe');
  const started = await waitFor(() => qqRunning(), 60000, 2000);
  if (started) {
    log.ok('QQ 已启动（若停在登录界面，请先登录，否则 SnowLuma 无法注入）');
    await sleep(5000);
  } else {
    log.warn('QQ 未能启动');
  }
  return Boolean(started);
}

// ── 账号选择 ────────────────────────────────────────────────────────────────

function askAccount(accounts, suggested) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    log.raw(`\n${c.bold('检测到以下 QQ 账号：')}`);
    accounts.forEach((account, index) => {
      log.raw(`  ${c.cyan(String(index + 1))}) ${account.uin}   OneBot HTTP ${account.httpPort} / WS ${account.wsPort}`);
    });
    log.raw(`  ${c.dim('0) 取消')}`);
    rl.question(`\n请输入要接入桥接的 QQ 号（直接回车 = ${suggested || accounts[0]?.uin || ''}）：`, (answer) => {
      rl.close();
      const text = answer.trim();
      if (text === '0') return resolve(null);
      if (!text) return resolve(suggested || accounts[0]?.uin || null);
      const index = Number(text);
      if (Number.isInteger(index) && index >= 1 && index <= accounts.length) {
        return resolve(accounts[index - 1].uin);
      }
      const hit = accounts.find((account) => account.uin === text);
      resolve(hit ? hit.uin : null);
    });
  });
}

/**
 * 决定本次接入哪个账号，优先级：
 *   --qq > 配置里的固定 QQ 号（除非 --ask）> 上次选择（除非 --ask）> 交互询问 > 唯一账号 > 第一个
 */
async function chooseAccount(accounts, config, args) {
  const known = new Set(accounts.map((account) => account.uin));

  if (args.qq) {
    if (!known.has(args.qq)) {
      log.warn(`指定的账号 ${args.qq} 不在已接入列表里：${[...known].join(', ') || '（无）'}`);
      return null;
    }
    return args.qq;
  }

  const fixed = String(config.defaults?.qqNumber || '').trim();
  if (!args.ask && fixed && known.has(fixed)) return fixed;

  const remembered = bridge.rememberedAccount(config.paths.bridge);
  if (!args.ask && remembered && known.has(remembered)) return remembered;

  if (accounts.length === 1) return accounts[0].uin;

  const suggested = (remembered && known.has(remembered) && remembered)
    || (fixed && known.has(fixed) && fixed)
    || accounts[0].uin;
  const picked = await askAccount(accounts, suggested);
  if (picked) return picked;
  if (!process.stdin.isTTY) {
    const fallback = (remembered && known.has(remembered) && remembered) || accounts[0].uin;
    log.warn(`当前不是交互终端，自动使用账号 ${fallback}`);
    return fallback;
  }
  return null;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  // dry-run 只读预演：不写文件、不启动/重启任何程序
  runtime.dryRun = args.dryRun === true;

  if (args.init) {
    if (runtime.dryRun) {
      const detected = configModule.detectAll();
      console.log('（dry-run）自动探测结果（不会写入 config.json）：');
      Object.entries(detected).forEach(([key, value]) => console.log(`  ${key.padEnd(9)}: ${value || '(未探测到，需要手动填写)'}`));
      return 0;
    }
    try {
      const { problems } = await configModule.runWizard();
      return problems.length ? 1 : 0;
    } catch (error) {
      log.warn(String(error?.message || error));
      return 1;
    }
  }

  let config;
  try {
    config = configModule.loadConfig();
    if (!config) {
      if (args.list) {
        log.warn(`缺少 ${configModule.CONFIG_FILE}，请先运行 setup.bat 或 node src/cli.cjs --init`);
        return 1;
      }
      log.warn('还没有 config.json，进入首次配置向导…');
      config = await configModule.ensureConfig({ allowWizard: true });
    }
  } catch (error) {
    log.warn(String(error.message || error));
    return 1;
  }

  const pathProblems = configModule.validatePaths(config);
  if (pathProblems.length) {
    log.warn('配置里的这些路径有问题，请运行 setup.bat 重新配置：');
    pathProblems.forEach((problem) => log.raw(`    - ${problem}`));
    return 1;
  }

  const paths = config.paths;
  const portBase = Number(config.defaults?.portBase) || 3000;

  if (args.list) {
    const accounts = snowluma.discoverAccounts(paths.snowluma);
    if (!accounts.length) {
      log.warn('还没有任何已接入的账号（需要 SnowLuma 启动并注入 QQ 后才会生成 config/onebot_<QQ号>.json）。');
      return 0;
    }
    log.raw('');
    accounts.forEach((account) => log.raw(`  ${account.uin}   OneBot HTTP ${account.httpPort} / WS ${account.wsPort}`));
    return 0;
  }

  console.log(c.bold('\n=== qq-bridge 一键启动 ==='));
  console.log(c.dim(`QQ      : ${paths.qq}`));
  console.log(c.dim(`SnowLuma: ${paths.snowluma}`));
  console.log(c.dim(`DSH     : ${paths.dsh}`));
  console.log(c.dim(`桥接    : ${paths.bridge}`));

  if (runtime.dryRun) {
    console.log(c.yellow('\n*** DRY-RUN 预演：只打印计划，不写文件、不启动/重启任何程序 ***'));
    console.log(c.dim('   正式运行会修改：qq-bridge/config.json、SnowLuma/config/{runtime.json,onebot_<QQ号>.json}'));
    console.log(c.dim('   这些改动都会先备份为 *.bak-<时间戳>'));
  }

  setTotalSteps(TOTAL_STEPS);

  // 1. DSH
  log.step(1, 'DSH 桌面端');
  let dshPort = dsh.webPort();
  if (!dshPort) {
    if (runtime.dryRun) {
      log.info('（dry-run）DSH 未运行，正式运行时将启动它');
    } else {
      dshPort = await dsh.ensureRunning(paths.dsh, 180000);
    }
  }
  if (!dshPort) {
    if (runtime.dryRun) {
      log.warn('（dry-run）DSH 未运行，无法计算 dsh.baseUrl；正式运行时会先启动它');
    } else {
      log.warn('DSH 没有在 3 分钟内监听 Web 端口，桥接无法工作。请手动打开 DeepSeek Harness 后重试。');
      return 1;
    }
  } else {
    log.ok(`DSH 已就绪，Web 端口 ${dshPort}`);
  }

  // 2. QQ
  log.step(2, 'QQ 客户端');
  await ensureQq(paths.qq);

  // 3. SnowLuma + 账号
  log.step(3, 'SnowLuma / QQ 账号');
  let accounts = snowluma.discoverAccounts(paths.snowluma);
  await snowluma.ensureRunning(paths.snowluma, accounts, 150000);

  if (runtime.dryRun) {
    accounts = snowluma.discoverAccounts(paths.snowluma);
  } else {
    accounts = (await waitFor(() => {
      const found = snowluma.discoverAccounts(paths.snowluma);
      return found.length ? found : null;
    }, 60000, 3000)) || snowluma.discoverAccounts(paths.snowluma);
  }

  if (!accounts.length) {
    log.warn('没有发现任何已接入的 QQ 账号（config/onebot_<QQ号>.json）。');
    log.warn('请确认 QQ 已登录、SnowLuma 日志里有 [Hook] login detected，然后重跑本工具。');
    return 1;
  }

  const portChanges = snowluma.assignAccountPorts(accounts, portBase);
  if (portChanges.length) {
    log.info(runtime.dryRun ? '（dry-run）多账号端口将这样分配：' : '为多账号分配独立 OneBot 端口：');
    portChanges.forEach((change) => log.info(`  ${change}`));
    if (!runtime.dryRun) {
      log.warn('端口改动需要重启 SnowLuma 才生效，重启中…');
      await snowluma.restart(paths.snowluma, accounts, 150000);
      log.ok('SnowLuma 已按新端口重启');
    }
  }

  // 4. 选账号
  log.step(4, '选择接入账号');
  const chosenUin = await chooseAccount(accounts, config, args);
  if (!chosenUin) {
    log.warn('未选择账号，已退出。');
    return 1;
  }
  const account = accounts.find((item) => item.uin === chosenUin);
  const ready = runtime.dryRun
    ? ((await tcpOpen(account.httpPort)) && (await tcpOpen(account.wsPort)))
    : await waitFor(
      async () => (await tcpOpen(account.httpPort)) && (await tcpOpen(account.wsPort)),
      90000,
      2000,
    );
  if (ready) log.ok(`已选择账号 ${c.cyan(account.uin)}（OneBot HTTP ${account.httpPort} / WS ${account.wsPort}）`);
  else log.warn(`账号 ${account.uin} 的 OneBot 端口还没起来（HTTP ${account.httpPort} / WS ${account.wsPort}），桥接可能连不上。`);
  bridge.rememberAccount(paths.bridge, account.uin);
  const others = accounts.filter((item) => item.uin !== account.uin);
  if (others.length) {
    log.info(`其它账号：${others.map((item) => item.uin).join(', ')}（切换运行 select-account.bat）`);
  }

  // 5. 同步配置 + 桥接
  log.step(5, '同步配置并启动桥接');
  let changed = [];
  try {
    if (dshPort) {
      const dshSync = bridge.syncDshPort(paths.bridge, dshPort);
      dshSync.changes.forEach((change) => log.info(change));
      changed = changed.concat(dshSync.changes);
    } else {
      log.info('（dry-run）DSH 未运行，跳过 dsh.baseUrl 的改动计算');
    }

    const pin = bridge.pinAccount(paths.bridge, paths.snowluma, account);
    pin.changes.forEach((change) => log.info(change));
    changed = changed.concat(pin.changes);

    if (runtime.dryRun) {
      if (changed.length) log.warn(`（dry-run）以上 ${changed.length} 项改动正式运行时会写入桥接 config.json（先备份）`);
      else log.ok('（dry-run）桥接 config.json 已是最新，正式运行无需改动');
    } else if (changed.length) log.ok(`已写回桥接 config.json（${changed.length} 项改动，已备份）`);
    else log.ok('桥接 config.json 已是最新，无需改动');
  } catch (error) {
    log.warn(`写桥接 config.json 失败：${error.message}`);
    return 1;
  }

  if (await bridge.consoleUp(paths.bridge)) {
    if (changed.length) {
      log.info('配置有变动，通过控制台 API 重启桥接…');
      if (await bridge.restart(paths.bridge)) log.ok('桥接已重启');
      else log.warn('桥接重启失败或未恢复，请查看 start.bat 窗口');
    } else {
      log.ok('桥接已在运行（配置无变动，未重启）');
    }
  } else {
    log.info('启动桥接（start.bat 守护窗口）…');
    bridge.start(paths.bridge);
    if (runtime.dryRun) {
      // dry-run 不会真的启动，直接继续打印计划
    } else {
      const up = await waitFor(() => bridge.consoleUp(paths.bridge), 60000, 1500);
      if (up) log.ok('桥接已启动');
      else log.warn('桥接未能启动，请查看 start.bat 窗口里的报错');
    }
  }

  // 6. 等待连接
  log.step(6, '等待连接');
  if (runtime.dryRun) {
    log.info('（dry-run）跳过等待，以下是当前真实状态（未做任何改动）');
  } else if (await bridge.consoleUp(paths.bridge)) {
    await waitFor(() => {
      const state = bridge.status(paths.bridge);
      return state.snowlumaConnected && state.dshReady;
    }, 30000, 2000);
  }

  const state = bridge.status(paths.bridge);
  const accountUp = (await tcpOpen(account.httpPort)) && (await tcpOpen(account.wsPort));
  const bridgeUp = await bridge.consoleUp(paths.bridge);
  console.log(`\n${c.bold('=== 当前状态 ===')}`);
  console.log(`  QQ        : ${qqRunning() ? c.green('运行中') : c.red('未运行')}`);
  console.log(`  DSH       : ${c.green(`端口 ${dshPort}`)}`);
  console.log(`  接入账号  : ${c.cyan(account.uin)}  ${accountUp ? c.green(`OneBot ${account.httpPort}/${account.wsPort} 正常`) : c.red('OneBot 端口未就绪')}`);
  console.log(`  桥接      : ${bridgeUp ? c.green('控制台正常') : c.red('未运行')}`);
  console.log(`  已连接    : SnowLuma ${state.snowlumaConnected ? c.green('✓') : c.red('✗')}   DSH ${state.dshReady ? c.green('✓') : c.red('✗')}`);
  if (others.length) {
    console.log(`  其它账号  : ${others.map((item) => `${item.uin}(端口 ${item.httpPort}/${item.wsPort})`).join(', ')}`);
  }
  if (state.tail.length) {
    console.log(c.dim('\n--- 桥接最后几行日志 ---'));
    state.tail.forEach((line) => console.log(c.dim(`  ${line}`)));
  }
  console.log('');
  if (state.snowlumaConnected && state.dshReady) {
    console.log(c.green(`全部就绪：${account.uin} 已接入，现在可以在 QQ 上给机器人发消息了。`));
    if (state.healFailed > 0) {
      console.log(c.yellow(`（本次启动出现过 ${state.healFailed} 次 token 自愈失败，但最终已连接，可忽略）`));
    }
  } else if (accountUp && bridgeUp) {
    console.log(c.yellow('组件都在运行，但桥接还没完成连接，稍等它会自动重连；可查看桥接控制台。'));
  } else {
    console.log(c.yellow('还有组件没就绪，请按上面的提示处理。'));
  }
  if (runtime.dryRun) {
    console.log(c.yellow('\n（dry-run 结束：以上是计划与当前状态，没有写入任何文件，也没有启动/重启任何程序。）'));
    console.log(c.dim('  确认无误后，去掉 --dry-run 再运行一次即可正式部署。'));
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(c.red(`\n启动脚本异常：${error?.stack || error}`));
    process.exit(1);
  });
