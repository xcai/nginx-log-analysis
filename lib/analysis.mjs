import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

const timingNames = ['rt', 'uct', 'uht', 'urt'];
const metricNames = [...timingNames, 'wait', 'body', 'edge'];
const numberPattern = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const linePattern = /^\S+\s+\[([^\]]+)\]\s+"([^"\r\n]*)"\s+(\d{3})\s+(\d+|-)\s+"(?:\\.|[^"\\])*"\s+"(?:\\.|[^"\\])*"\s+(.*)$/;

function parseTiming(value) {
  if (value === undefined) return null;
  const tokens = value.split(/\s*[, :]\s*/);
  if (!tokens.length || tokens.some(token => token !== '-' && !numberPattern.test(token))) return null;
  return tokens.map(token => token === '-' ? null : Number(token) * 1000);
}

export function parseLine(line) {
  const match = line.match(linePattern);
  if (!match) return null;
  const [, timestamp, request, statusText, bytesText, tail] = match;
  const requestMatch = request.match(/^(\S+)\s+(\S+)\s+HTTP\/[\d.]+$/);
  const timestampMs = Date.parse(timestamp);
  if (!requestMatch || !Number.isFinite(timestampMs)) return null;
  const status = Number(statusText);
  if (status < 100 || status > 599) return null;
  const fields = Object.fromEntries([...tail.matchAll(/\b(rt|uct|uht|urt)=(?:"([^"]*)"|(\S+))/g)]
    .map(field => [field[1], field[2] ?? field[3]]));
  const timings = Object.fromEntries(timingNames.map(name => [name, parseTiming(fields[name])]));
  if (timings.rt && timings.rt.length !== 1) timings.rt = null;
  let path;
  try {
    const target = requestMatch[2];
    path = /^https?:\/\//i.test(target) ? new URL(target).pathname : target.split(/[?#]/, 1)[0];
  } catch {
    return null;
  }
  const upstreamCounts = ['uct', 'uht', 'urt'].map(name => timings[name]?.length ?? 0);
  const attempts = Math.max(...upstreamCounts);
  const aligned = attempts === 1 && upstreamCounts.every(count => count === 1);
  const metrics = Object.fromEntries(timingNames.map(name => {
    const samples = timings[name];
    return [name, samples?.length && samples.every(value => value !== null && Number.isFinite(value))
      ? samples.reduce((sum, value) => sum + value, 0) : null];
  }));
  const difference = (left, right) => left !== null && right !== null && left >= right - 2
    ? Math.max(0, left - right) : null;
  metrics.wait = aligned ? difference(metrics.uht, metrics.uct) : null;
  metrics.body = aligned ? difference(metrics.urt, metrics.uht) : null;
  metrics.edge = aligned ? difference(metrics.rt, metrics.urt) : null;
  return {
    timestamp: timestampMs, method: requestMatch[1], path: path || '/', status,
    bytes: bytesText === '-' ? 0 : Number(bytesText), attempts, metrics,
    inconsistent: aligned && ((metrics.uht !== null && metrics.uct !== null && metrics.uht + 2 < metrics.uct)
      || (metrics.urt !== null && metrics.uht !== null && metrics.urt + 2 < metrics.uht)
      || (metrics.rt !== null && metrics.urt !== null && metrics.rt + 2 < metrics.urt)),
  };
}

function newGroup(key) {
  return {
    key, count: 0, slow: 0, errors: 0, clientErrors: 0, retries: 0, bytes: 0,
    statuses: {}, values: Object.fromEntries(metricNames.map(name => [name, []])),
  };
}

function addRecord(group, record, slowMs) {
  group.count++;
  group.bytes += record.bytes;
  group.slow += Number(record.metrics.rt !== null && record.metrics.rt >= slowMs);
  group.errors += Number(record.status >= 500);
  group.clientErrors += Number(record.status >= 400 && record.status < 500);
  group.retries += Number(record.attempts > 1);
  group.statuses[record.status] = (group.statuses[record.status] ?? 0) + 1;
  for (const name of metricNames) {
    if (record.metrics[name] !== null) group.values[name].push(record.metrics[name]);
  }
}

export function summarize(values) {
  if (!values.length) return { count: 0, min: null, max: null, mean: null, total: 0, p50: null, p90: null, p95: null, p99: null };
  values.sort((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);
  const percentile = fraction => values[Math.ceil(values.length * fraction) - 1];
  return {
    count: values.length, min: values[0], max: values.at(-1), mean: total / values.length, total,
    p50: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95), p99: percentile(0.99),
  };
}

function finishGroup(group) {
  const { values, ...rest } = group;
  return { ...rest, metrics: Object.fromEntries(metricNames.map(name => [name, summarize(values[name])])) };
}

export function diagnose(group, slowMs) {
  const { metrics } = group;
  const findings = [];
  if (group.errors) findings.push({ kind: 'error', text: `${group.errors} 次 5xx，优先关联上游错误日志及超时配置。` });
  if (group.retries) findings.push({ kind: 'retry', text: `${group.retries} 次多上游尝试；检查 upstream 状态及重试原因。` });
  if (metrics.uct.p95 !== null && metrics.uct.p95 >= 50) findings.push({ kind: 'connect', text: '连接耗时偏高：检查上游连接池、网络、TLS 与连接积压。' });
  if (metrics.wait.p95 !== null && metrics.wait.p95 >= slowMs * 0.5) findings.push({ kind: 'wait', text: '首包等待偏高：结合 tracing 检查应用排队、数据库及外部依赖。' });
  if (metrics.body.p95 !== null && metrics.body.p95 >= slowMs * 0.3) findings.push({ kind: 'body', text: '上游响应体接收偏慢：检查响应大小、流式输出及上游传输。' });
  if (metrics.edge.p95 !== null && metrics.edge.p95 >= slowMs * 0.3) findings.push({ kind: 'edge', text: '请求总耗时与上游耗时差偏大：检查客户端上传/下载、限速及 Nginx 处理。' });
  if (!findings.length && group.slow) findings.push({ kind: 'slow', text: '存在慢请求；结合链路追踪定位，当前差值样本不足以细分阶段。' });
  return findings;
}

export async function analyzeStreams(streams, { slowMs = 1000, top = 20, normalizeIds = false } = {}) {
  if (!Number.isFinite(slowMs) || slowMs <= 0) throw new Error('慢请求阈值必须大于 0');
  if (!Number.isInteger(top) || top < 1) throw new Error('Top 数量必须为正整数');
  const overall = newGroup('全部请求');
  const endpoints = new Map();
  const buckets = new Map();
  const slowest = [];
  const quality = { lines: 0, blank: 0, invalid: 0, missing: Object.fromEntries(timingNames.map(name => [name, 0])), inconsistent: 0 };
  let start = Infinity;
  let end = -Infinity;
  for await (const stream of streams) {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        quality.lines++;
        if (!line.trim()) { quality.blank++; continue; }
        const record = parseLine(line);
        if (!record) { quality.invalid++; continue; }
        if (normalizeIds) record.path = record.path.split('/').map(segment => /^\d+$/.test(segment)
          || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ? ':id' : segment).join('/');
        const key = `${record.method} ${record.path}`;
        if (!endpoints.has(key)) endpoints.set(key, newGroup(key));
        addRecord(overall, record, slowMs);
        addRecord(endpoints.get(key), record, slowMs);
        start = Math.min(start, record.timestamp);
        end = Math.max(end, record.timestamp);
        for (const name of timingNames) quality.missing[name] += Number(record.metrics[name] === null);
        quality.inconsistent += Number(record.inconsistent);
        const minute = Math.floor(record.timestamp / 60_000) * 60_000;
        if (!buckets.has(minute)) buckets.set(minute, { time: minute, count: 0, slow: 0, errors: 0, total: 0, timed: 0 });
        const bucket = buckets.get(minute);
        bucket.count++;
        bucket.slow += Number(record.metrics.rt !== null && record.metrics.rt >= slowMs);
        bucket.errors += Number(record.status >= 500);
        if (record.metrics.rt !== null) { bucket.total += record.metrics.rt; bucket.timed++; }
        if (record.metrics.rt !== null && (slowest.length < top || record.metrics.rt > slowest.at(-1).metrics.rt)) {
          slowest.push({ key, timestamp: record.timestamp, status: record.status, bytes: record.bytes, attempts: record.attempts, metrics: record.metrics });
          slowest.sort((left, right) => right.metrics.rt - left.metrics.rt);
          if (slowest.length > top) slowest.pop();
        }
      }
    } finally {
      lines.close();
    }
  }
  const groups = [...endpoints.values()].map(finishGroup).sort((left, right) => right.metrics.rt.total - left.metrics.rt.total);
  for (const group of groups) group.findings = diagnose(group, slowMs);
  return {
    generatedAt: new Date().toISOString(), slowMs, quality,
    start: Number.isFinite(start) ? start : null, end: Number.isFinite(end) ? end : null,
    overall: finishGroup(overall), endpoints: groups, slowest,
    timeline: [...buckets.values()].sort((left, right) => left.time - right.time),
  };
}

export async function* openInputs(paths) {
  for (const path of paths) {
    if (path === '-') { yield process.stdin; continue; }
    const source = createReadStream(path);
    if ((path instanceof URL ? path.pathname : path).endsWith('.gz')) {
      const decompressor = createGunzip();
      source.on('error', error => decompressor.destroy(error));
      yield source.pipe(decompressor);
    } else {
      yield source;
    }
  }
}