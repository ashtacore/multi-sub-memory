import { downloadAnalytics } from './api.js';
import { badge, byId, empty, node } from './dom.js';

const missing = '—';
const formatter = (options) => {
  const format = new Intl.NumberFormat(undefined, options);
  return (value) => Number.isFinite(value) ? format.format(value) : missing;
};
const number = formatter({ maximumFractionDigits: 1 });
const rank = formatter({ maximumFractionDigits: 3 });
const percent = formatter({ style: 'percent', maximumFractionDigits: 1 });
const usd = formatter({ style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
const ms = (value) => Number.isFinite(value) ? number(value) + ' ms' : missing;
const utcDay = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

export function analyticsFilters(project) {
  return { project, window: byId('analytics-window').value, monthMode: byId('analytics-month-mode').value };
}

export function bindAnalyticsControls(projectSelect, refresh) {
  const windowSelect = byId('analytics-window');
  const monthMode = byId('analytics-month-mode');
  windowSelect.addEventListener('change', () => {
    monthMode.disabled = windowSelect.value !== '2m';
    byId('analytics-month-field').hidden = monthMode.disabled;
    void refresh();
  });
  monthMode.addEventListener('change', () => void refresh());
  byId('analytics-refresh').addEventListener('click', () => void refresh());
  for (const format of ['json', 'markdown']) {
    const button = byId('analytics-export-' + format);
    const error = byId('analytics-export-error');
    button.addEventListener('click', async () => {
      if (button.hasAttribute('aria-disabled')) return;
      button.setAttribute('aria-disabled', 'true');
      error.hidden = true;
      try {
        await downloadAnalytics(analyticsFilters(projectSelect.value), format);
      } catch (failure) {
        error.textContent = 'Export failed. ' + failure.message;
        error.hidden = false;
      } finally {
        button.removeAttribute('aria-disabled');
      }
    });
  }
}

function section(title, ...children) {
  return node('section', { className: 'analytics-section' }, node('h3', { text: title }), ...children);
}

function chartCard(title, ...children) {
  return node('div', { className: 'card analytics-chart' }, node('h4', { text: title }), ...children);
}

function metrics(rows) {
  return node('dl', { className: 'analytics-metrics' }, ...rows.map(([label, value]) =>
    node('div', { className: 'card' }, node('dt', { text: label }), node('dd', { text: value })),
  ));
}

function table(title, headers, rows) {
  const content = node('table', {},
    node('caption', { text: title }),
    node('thead', {}, node('tr', {}, ...headers.map((text) => {
      const cell = node('th', { text });
      cell.scope = 'col';
      return cell;
    }))),
    node('tbody', {}, ...rows.map(([label, ...values]) => {
      const cell = node('th', { text: label });
      cell.scope = 'row';
      return node('tr', {}, cell, ...values.map((text) => node('td', { text })));
    })),
  );
  const scroll = node('div', { className: 'analytics-table' }, content);
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', title);
  return scroll;
}

function svgElement(tag, attrs = {}, text) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function svgChart(label, width, height, className) {
  const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label, class: className });
  svg.append(svgElement('title', {}, label));
  return svg;
}

function chartMark(tag, attrs, label) {
  const mark = svgElement(tag, attrs);
  mark.append(svgElement('title', {}, label));
  return mark;
}

function legend(labels) {
  return node('ul', { className: 'analytics-legend' }, ...labels.map((label, index) =>
    node('li', {}, node('span', { className: 'analytics-mark-' + index }), label),
  ));
}

// Rows share a zero baseline and a scale. Separate charts keep unrelated units apart.
function bars(title, rows, format = number, { labels = [], max = 0, values = true } = {}) {
  const samples = rows.flatMap(([, row]) => row.map(([value]) => value)).filter(Number.isFinite);
  if (!samples.length) return chartCard(title, empty('No measurements in this selection.'));
  const scale = Math.max(max, ...samples, 0) || 1;
  const list = node('ul', { className: 'analytics-bars' });
  for (const [label, row] of rows) {
    const item = node('li', {}, node('span', { text: label, className: 'analytics-bar-label' }));
    for (const [value, series, name] of row) {
      const text = format(value);
      const description = [label, name, text].filter(Boolean).join(' · ');
      const svg = svgChart(description, 240, 12, 'analytics-bar');
      svg.setAttribute('preserveAspectRatio', 'none');
      if (Number.isFinite(value)) {
        const width = 240 * value / scale;
        svg.append(chartMark('rect', {
          x: 0, y: 0, width, height: 12, class: 'analytics-mark-' + series,
        }, description));
      }
      item.append(node('div', { className: 'analytics-bar-row' }, svg,
        ...(values ? [node('span', { text })] : [])));
    }
    list.append(item);
  }
  return chartCard(title, ...(labels.length ? [legend(labels)] : []), list);
}

function trend(title, series, read, format, fixedMax = 0) {
  const values = series.map(read);
  const observed = values.filter(Number.isFinite);
  if (!observed.length) return chartCard(title, empty('No measurements in these buckets.'));
  const maximum = Math.max(fixedMax, ...observed) || 1;
  const description = series.map(({ label }, index) => label + ' ' + format(values[index])).join(', ');
  const svg = svgChart(title + ' · ' + description, 320, 116, 'analytics-trend');
  const x = (index) => 14 + index * 292 / (series.length - 1);
  const y = (value) => 95 - value / maximum * 76;
  for (const gridValue of [0, maximum / 2, maximum]) {
    svg.append(svgElement('line', { x1: 14, x2: 306, y1: y(gridValue), y2: y(gridValue), class: 'analytics-gridline' }));
  }
  const points = [];
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    if (Number.isFinite(values[index - 1])) {
      svg.append(svgElement('line', {
        x1: x(index - 1), x2: x(index), y1: y(values[index - 1]), y2: y(value), class: 'analytics-trend-line',
      }));
    }
    points.push(chartMark('circle', { cx: x(index), cy: y(value), r: 5, class: 'analytics-mark-0' },
      series[index].label + ' · ' + format(value)));
  });
  svg.append(...points);
  const last = series.length - 1;
  svg.append(svgElement('text', { x: x(0), y: 111 }, series[0].label),
    svgElement('text', { x: x(last), y: 111, 'text-anchor': 'end' }, series[last].label));
  return chartCard(title, svg);
}

function outputQuality({ quality, series }) {
  const { corpus, getOrigins } = quality;
  const comparisons = [
    ['Search → Get conversion', ({ quality }) => quality.searchToGetConversionRate, percent, 1],
    ['Mean reciprocal rank', ({ quality }) => quality.meanReciprocalRank, rank, 1],
    ['Zero-hit search', ({ quality }) => quality.zeroHitSearchRate, percent, 1],
    ['Tool calls', ({ totals }) => totals.calls, number],
  ];
  const trends = comparisons.map(([title, read, format, max]) => trend(title, series, read, format, max));
  const trendData = node('details', { className: 'analytics-details' },
    node('summary', { text: 'Comparison bucket values' }),
    table('Retrieval quality and call volume by UTC bucket',
      ['Bucket', ...comparisons.map(([title]) => title)],
      series.map((bucket) => [bucket.label, ...comparisons.map(([, read, format]) => format(read(bucket)))])),
  );
  return section('Output Quality',
    metrics([
      ['Search → Get conversion', percent(quality.searchToGetConversionRate)],
      ['Mean reciprocal rank (MRR)', rank(quality.meanReciprocalRank)],
      ['Zero-hit searches', percent(quality.zeroHitSearchRate)],
      ['Re-search', percent(quality.researchRate)],
      ['Unused memories', percent(corpus.unusedMemoryRatio)],
      ['Avg memory tokens', number(corpus.memories.averageTokens)],
    ]),
    node('div', { className: 'analytics-grid' }, ...trends),
    trendData,
    node('div', { className: 'analytics-grid' },
      bars('mem_get calls by origin', [['Search', getOrigins.search], ['Bootstrap', getOrigins.bootstrap], ['Direct', getOrigins.direct]]
        .map(([label, count], index) => [label, [[count, index]]])),
      bars('Stored memories by estimated token size', corpus.memories.distribution.map(({ label, count }) => [label, [[count, 0]]])),
    ),
  );
}

const cohorts = [['lite', 'Lite'], ['heavy', 'Heavy'], ['no', 'No memory use']];
const costMetrics = [
  ['Avg session cost (USD)', 'averageCostUsd', usd],
  ['Cache hit ratio', 'cacheHitRatio', percent, 1],
  ['Memory context tax', 'memoryContextTax', percent, 1],
  ['Avg turns per session', 'averageTurnsPerSession', number],
  ['Session count', 'sessionCount', number],
];

function taskCost(cost) {
  const charts = costMetrics.map(([label, key, format, max]) =>
    bars(label, cohorts.map(([cohort, name], index) => [name, [[cost.cohorts[cohort][key], index]]]), format, { max }));
  return section('Total Task Cost',
    node('div', { className: 'analytics-cost-status' },
      badge(cost.available ? 'ccusage available' : 'ccusage data unavailable', cost.available ? 'success' : ''),
      node('p', { className: 'muted', text: cost.reason ?? number(cost.matchedSessionCount) + ' sessions matched to local usage.' }),
    ),
    node('p', { className: 'muted', text: 'Lite sessions have 1–4 memory calls and Heavy sessions have 5 or more. Task complexity can influence both memory use and session cost.' }),
    table('Session comparison by memory use', ['Memory use', ...costMetrics.map(([title]) => title)],
      cohorts.map(([key, label]) => [label, ...costMetrics.map(([, field, format]) => format(cost.cohorts[key][field]))])),
    node('div', { className: 'analytics-grid' }, ...charts),
  );
}

const toolNames = ['mem_bootstrap', 'mem_search', 'mem_get', 'mem_remember', 'mem_note'];

function speedAndTokens({ tools, memoryDetour }) {
  const { count, durationMs, toolResultDurationMs } = memoryDetour;
  const toolChart = (title, key, format) => bars(title, toolNames.map((tool) => [tool, [
    [tools[tool]?.[key].avg, 0, 'Average'], [tools[tool]?.[key].p95, 1, 'p95'],
  ]]), format, { labels: ['Average', 'p95'] });
  return section('Speed & Tokens',
    node('div', { className: 'analytics-grid' },
      toolChart('Tool latency', 'durationMs', ms),
      toolChart('Estimated response tokens', 'responseTokens', number),
    ),
    table('Per-tool latency and payload', ['Tool', 'Calls', 'Avg ms', 'p95 ms', 'Avg tokens', 'p95 tokens'],
      toolNames.map((tool) => {
        const metric = tools[tool];
        return [tool, number(metric?.callCount ?? 0), number(metric?.durationMs.avg), number(metric?.durationMs.p95),
          number(metric?.responseTokens.avg), number(metric?.responseTokens.p95)];
      })),
    node('div', { className: 'card analytics-chart' },
      node('h4', { text: 'Memory Detour Duration' }),
      node('p', { className: 'muted', text: count
        ? number(count) + ' matched transcript detours. Timing starts at a memory search or get call.'
        : 'No memory calls could be matched to both a tool result and a next assistant turn in the indexed transcripts.' }),
      table('Transcript timing breakdown', ['From call to', 'Average', 'p95'], [
        ['Tool result', ms(toolResultDurationMs.avg), ms(toolResultDurationMs.p95)],
        ['Next assistant turn (end to end)', ms(durationMs.avg), ms(durationMs.p95)],
      ]),
    ),
  );
}

function dreamerPerformance(dreamer) {
  const { cost, repeatCompaction, velocity, searchImpressions, resurrection, human } = dreamer;
  const pricedRuns = cost.runs.filter(({ costUsd }) => Number.isFinite(costUsd)).length;
  const averageCost = pricedRuns ? cost.costUsd / pricedRuns : null;
  const churn = repeatCompaction.memories.map(({ memoryId, compactionCount }) => [memoryId, number(compactionCount)]);
  const distribution = Object.entries(dreamer.compactionCountDistribution).map(([count, memories]) => [count, [[memories, 0]]]);
  const byCount = dreamer.accessVelocityByCompactionCount.map(({ compactionCount, averageAccessesPerWeek }) =>
    [number(compactionCount), [[averageAccessesPerWeek, 0]]]);
  return section('Dreamer Performance (Cost, Efficiency & Quality)',
    node('h4', { text: 'Cost and usage' }),
    metrics([
      ['Total Dreamer cost', usd(cost.costUsd)],
      ['Avg Dreamer cost per priced run', usd(averageCost)],
      ['Input tokens', number(cost.inputTokens)],
      ['Output tokens', number(cost.outputTokens)],
    ]),
    node('p', { className: 'muted', text: `${number(cost.runCount)} HTTP and CLI runs · ${number(pricedRuns)} with cost data` }),
    node('h4', { text: 'Efficiency' }),
    node('div', { className: 'analytics-grid' },
      chartCard('Repeat-compaction churn',
        node('p', { text: number(repeatCompaction.count) + ' memories compacted at least twice.' }),
        churn.length ? table('Memories with repeated compactions', ['Memory ID', 'Compactions'], churn)
          : empty('No repeatedly compacted memories in this selection.'),
      ),
      bars('Memories by compaction count', distribution),
    ),
    node('h4', { text: 'Quality' }),
    metrics([
      ['Original Search → Get CTR', percent(searchImpressions.original.ctr)],
      ['Compacted Search → Get CTR', percent(searchImpressions.compacted.ctr)],
      ['Re-search after compacted get', percent(dreamer.compactedGetResearchRate)],
      ['Post-Dreamer resurrections', number(resurrection.count)],
      ['Human undo', number(human.undoCount)],
      ['Human edits', number(human.editCount)],
    ]),
    node('div', { className: 'analytics-grid' },
      bars('Average accesses/week before and after compaction', [
        ['Before', [[velocity.before, 0]]], ['After', [[velocity.after, 1]]],
      ]),
      bars('Age-normalized accesses/week by compaction count', byCount),
    ),
  );
}

export function renderAnalytics(report) {
  byId('analytics-report').replaceChildren(
    ...(report.series.some(({ completeTelemetry }) => !completeTelemetry)
      ? [node('p', { className: 'banner', text: 'Some comparison buckets extend beyond the telemetry retention period.' })]
      : []),
    outputQuality(report), taskCost(report.cost), speedAndTokens(report.speedAndTokens), dreamerPerformance(report.dreamer),
  );
  byId('analytics-status').textContent = 'UTC comparison period · ' + utcDay(report.start) + ' to ' + utcDay(report.end - 1);
}
