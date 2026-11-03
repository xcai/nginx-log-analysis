import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeStreams, openInputs } from './lib/analysis.mjs';
import { renderReport } from './lib/report.mjs';
import { watchLines, createAlertHandler } from './lib/monitor.mjs';
import { createNotifier } from './lib/notifications.mjs';

const help = `Nginx access log 性能分析与监控（Node.js >= 20；邮件告警需 npm install）

用法：node analyze.mjs <access.log|access.log.gz|-> [...] [选项]

选项：
  -o, --output <路径>     HTML 输出路径，默认 report.html
  --json <路径>           同时输出 JSON 统计数据
  --slow-ms <毫秒>        慢请求阈值，默认 1000
  --top <数量>            耗时最高请求条数，默认 20
  --normalize-ids         将路径中的纯数字和 UUID 段聚合为 :id
  --include-static        接口明细包含静态资源（默认忽略 JS、CSS 等）
  --watch                持续监听普通日志文件的新增完整行，不生成报告
  --alert-ms <毫秒>       监控告警阈值，默认 10000（包含等于阈值）
  --alert-cooldown-ms <毫秒> 同文件同接口告警冷却时间，默认 60000；0 不限制
  --poll-ms <毫秒>        监控轮询间隔，默认 1000
  --config <路径>        告警 JSON 配置文件，环境变量优先于配置文件
  --feishu-webhook <URL>  飞书机器人地址，也可设 FEISHU_WEBHOOK_URL
  --email-to <收件人>     邮件收件人，逗号分隔；也可设 ALERT_EMAIL_TO
  -h, --help              显示帮助

示例：
  node analyze.mjs /var/log/nginx/access.log -o report.html
  node analyze.mjs access.log.1.gz access.log --slow-ms 500 --json stats.json
  cat access.log | node analyze.mjs - -o report.html
  node analyze.mjs /var/log/nginx/access.log --watch --alert-ms 10000
`;

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    output: { type: 'string', short: 'o' },
    json: { type: 'string' }, 'slow-ms': { type: 'string', default: '1000' },
    top: { type: 'string', default: '20' }, 'normalize-ids': { type: 'boolean', default: false },
    'include-static': { type: 'boolean', default: false },
    watch: { type: 'boolean', default: false },
    'alert-ms': { type: 'string' }, 'alert-cooldown-ms': { type: 'string' },
    'poll-ms': { type: 'string' }, config: { type: 'string' },
    'feishu-webhook': { type: 'string' }, 'email-to': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(help); return; }
  if (!positionals.length) throw new Error('请指定日志文件或使用 - 从标准输入读取。运行 --help 查看用法。');
  if (positionals.filter(path => path === '-').length > 1) throw new Error('标准输入只能读取一次');
  if (values.watch) {
    if (positionals.some(path => path === '-' || path.endsWith('.gz'))) throw new Error('--watch 仅支持普通日志文件，不支持标准输入或 gzip');
    if (new Set(positionals.map(path => resolve(path))).size !== positionals.length) throw new Error('监控日志路径不能重复');
    if (values.output || values.json || values['normalize-ids'] || values['include-static']
      || args.some(arg => /^(--slow-ms|--top)(=|$)/.test(arg))) throw new Error('--watch 不能与报告选项一起使用；告警包含所有有效请求');
    const thresholdMs = Number(values['alert-ms'] ?? 10_000);
    const cooldownMs = Number(values['alert-cooldown-ms'] ?? 60_000);
    const pollMs = Number(values['poll-ms'] ?? 1000);
    if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) throw new Error('--alert-ms 必须是大于 0 的毫秒数');
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) throw new Error('--alert-cooldown-ms 必须为非负整数');
    if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('--poll-ms 必须为正整数');
    let config = {};
    if (values.config !== undefined) {
      const source = await readFile(values.config, 'utf8');
      try { config = JSON.parse(source); }
      catch { throw new Error('--config 配置文件必须为有效 JSON'); }
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('--config 配置文件必须为 JSON 对象');
    }
    const notifier = await createNotifier({ feishuWebhook: values['feishu-webhook'],
      emailTo: values['email-to'], config });
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const handle = createAlertHandler({ thresholdMs, cooldownMs, notify: notifier.notify });
      for await (const entry of watchLines(positionals.map(path => resolve(path)), { pollMs, signal: controller.signal,
        onReady: () => console.log(`正在监控 ${positionals.length} 个日志文件的新增行；告警阈值 ${thresholdMs} ms；Ctrl+C 停止。`) })) {
        await handle(entry);
      }
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      notifier.close();
    }
    return;
  }
  if (['alert-ms', 'alert-cooldown-ms', 'poll-ms', 'config', 'feishu-webhook', 'email-to'].some(name => values[name] !== undefined)) {
    throw new Error('告警选项需要配合 --watch 使用');
  }
  const slowMs = Number(values['slow-ms']);
  const top = Number(values.top);
  if (!Number.isFinite(slowMs) || slowMs <= 0) throw new Error('--slow-ms 必须是大于 0 的毫秒数');
  if (!Number.isSafeInteger(top) || top < 1) throw new Error('--top 必须为正整数');
  const outputs = [values.output ?? 'report.html', values.json].filter(Boolean).map(path => resolve(path));
  if (new Set(outputs).size !== outputs.length) throw new Error('HTML 和 JSON 输出不能使用相同路径');
  if (positionals.some(path => path !== '-' && outputs.includes(resolve(path)))) throw new Error('输出路径不能覆盖输入日志');
  const data = await analyzeStreams(openInputs(positionals), { slowMs, top, normalizeIds: values['normalize-ids'], includeStatic: values['include-static'] });
  if (!data.overall.count) throw new Error(`没有有效日志记录（无效行 ${data.quality.invalid}），未生成报告。请检查日志格式。`);
  for (const output of outputs) await mkdir(dirname(output), { recursive: true });
  await writeFile(outputs[0], renderReport(data), 'utf8');
  if (values.json) await writeFile(outputs[1], JSON.stringify(data, null, 2), 'utf8');
  console.log(`已分析 ${data.overall.count} 个请求 / ${data.endpoints.length} 个接口；慢请求 ${data.overall.slow} 个；跳过无效行 ${data.quality.invalid}。`);
  console.log(`HTML 报告：${outputs[0]}`);
  if (values.json) console.log(`JSON 数据：${outputs[1]}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`分析失败：${error.message}`); process.exitCode = 1; });
}