import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeStreams, openInputs } from './lib/analysis.mjs';
import { renderReport } from './lib/report.mjs';

const help = `Nginx access log 性能分析（Node.js >= 20，无需安装依赖）

用法：node analyze.mjs <access.log|access.log.gz|-> [...] [选项]

选项：
  -o, --output <路径>     HTML 输出路径，默认 report.html
  --json <路径>           同时输出 JSON 统计数据
  --slow-ms <毫秒>        慢请求阈值，默认 1000
  --top <数量>            耗时最高请求条数，默认 20
  --normalize-ids         将路径中的纯数字和 UUID 段聚合为 :id
  -h, --help              显示帮助

示例：
  node analyze.mjs /var/log/nginx/access.log -o report.html
  node analyze.mjs access.log.1.gz access.log --slow-ms 500 --json stats.json
  cat access.log | node analyze.mjs - -o report.html
`;

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    output: { type: 'string', short: 'o', default: 'report.html' },
    json: { type: 'string' }, 'slow-ms': { type: 'string', default: '1000' },
    top: { type: 'string', default: '20' }, 'normalize-ids': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(help); return; }
  if (!positionals.length) throw new Error('请指定日志文件或使用 - 从标准输入读取。运行 --help 查看用法。');
  if (positionals.filter(path => path === '-').length > 1) throw new Error('标准输入只能读取一次');
  const slowMs = Number(values['slow-ms']);
  const top = Number(values.top);
  if (!Number.isFinite(slowMs) || slowMs <= 0) throw new Error('--slow-ms 必须是大于 0 的毫秒数');
  if (!Number.isSafeInteger(top) || top < 1) throw new Error('--top 必须为正整数');
  const outputs = [values.output, values.json].filter(Boolean).map(path => resolve(path));
  if (new Set(outputs).size !== outputs.length) throw new Error('HTML 和 JSON 输出不能使用相同路径');
  if (positionals.some(path => path !== '-' && outputs.includes(resolve(path)))) throw new Error('输出路径不能覆盖输入日志');
  const data = await analyzeStreams(openInputs(positionals), { slowMs, top, normalizeIds: values['normalize-ids'] });
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