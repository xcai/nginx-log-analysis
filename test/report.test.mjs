import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Script } from 'node:vm';
import { analyzeStreams } from '../lib/analysis.mjs';
import { renderReport } from '../lib/report.mjs';

test('report is standalone, safe against log HTML injection and includes real metrics', async () => {
  const log = '192.0.2.1 [2026-10-30T09:55:40+08:00] "GET /api/</script><img/onerror=alert(1)>?tel=secret HTTP/1.1" 500 123 "-" "Agent" rt=1.5 uct="0.001" uht="1.4" urt="1.5"';
  const result = await analyzeStreams([Readable.from([log])]);
  const html = renderReport(result);
  assert.ok(html.includes('1,500'));
  assert.ok(!html.includes('<img/onerror'));
  assert.ok(!html.includes('tel=secret'));
  assert.ok(!/<script[^>]+src=|<link[^>]+href=/.test(html));
  assert.ok(html.includes('首包等待'));
  const payload = html.match(/<script id="report-data" type="application\/json">(.*?)<\/script>/s)[1];
  assert.equal(JSON.parse(payload).overall.count, 1);
  const scripts = [...html.matchAll(/<script>(.*?)<\/script>/gs)];
  for (const script of scripts) assert.doesNotThrow(() => new Script(script[1]));
});

test('empty report has explicit missing metrics, not invented zeros', async () => {
  const data = await analyzeStreams([]);
  const html = renderReport(data);
  assert.ok(html.includes('没有可分析的请求'));
  assert.ok(html.includes('没有可用的时间样本'));
  assert.ok(!html.includes('NaN'));
  assert.ok(!html.includes('Infinity'));
});

test('embedded search, sorting and slow-only controls update table results', async () => {
  const line = (path, seconds) => `192.0.2.1 [2026-10-30T09:55:40+08:00] "GET ${path} HTTP/1.1" 200 123 "-" "Agent" rt=${seconds}`;
  const data = await analyzeStreams([Readable.from([[line('/api/slow', 2), line('/api/fast', 0.1), line('/api/fast', 0.1)].join('\n')])]);
  const html = renderReport(data);
  const elements = Object.fromEntries(['report-data', 'search', 'sort', 'slow-only', 'endpoint-body', 'empty-search', 'result-count']
    .map(id => [id, { value: '', checked: false, hidden: true, events: {}, addEventListener(name, callback) { this.events[name] = callback; } }]));
  elements['report-data'].textContent = html.match(/<script id="report-data" type="application\/json">(.*?)<\/script>/s)[1];
  const script = new Script([...html.matchAll(/<script>(.*?)<\/script>/gs)][0][1]);
  script.runInNewContext({ document: { getElementById: id => elements[id] } });
  elements.sort.value = 'count';
  elements.sort.events.change();
  assert.ok(elements['endpoint-body'].innerHTML.indexOf('/api/fast') < elements['endpoint-body'].innerHTML.indexOf('/api/slow'));
  elements['slow-only'].checked = true;
  elements['slow-only'].events.change();
  assert.ok(elements['endpoint-body'].innerHTML.includes('/api/slow'));
  assert.ok(!elements['endpoint-body'].innerHTML.includes('/api/fast'));
  elements.search.value = 'not-found';
  elements.search.events.input();
  assert.equal(elements['empty-search'].hidden, false);
  assert.equal(elements['result-count'].textContent, '0 / 2 个接口');
});