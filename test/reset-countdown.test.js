const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

function fixture() {
  let now = Date.parse('2026-10-03T04:00:00Z');
  class Clock extends Date { static now() { return now; } }
  const context = {
    Date: Clock,
    usageWindows: data => data.windows,
    compactWindowLabel: label => label === 'Weekly' ? 'Week' : '5h',
    displayWindowLabel: label => label,
    windowOrder: window => window.label === 'Weekly' ? 1 : 0,
    accountElements: new Map(), accountStates: new Map()
  };
  vm.runInNewContext(source.slice(source.indexOf('function formatResetTime('), source.indexOf('function renderLimitWindows(')) + '\n' +
    source.slice(source.indexOf('function updateCountdowns('), source.indexOf('function measureContentHeight(')), context);
  return { context, advance(ms) { now += ms; } };
}

test('both providers display every reported reset with the exact local time on hover', () => {
  const { context: c } = fixture();
  for (const windows of [
    [{ label: '5-hour', resetAt: '2026-10-03T04:01:05Z' }, { label: 'Weekly', resetAt: '2026-10-05T06:00:00Z' }],
    [{ label: 'Weekly', resetAt: '2026-10-09T04:00:00Z' }]
  ]) {
    const elements = { summary: {} };
    c.renderResetSummary(elements, { windows });
    assert.equal(elements.summary.className, 'account-summary');
    assert.equal(elements.summary.textContent.split('\n').length, windows.length);
    for (const window of windows) {
      assert.ok(elements.summary.title.includes(c.getWindowReset(window, true)));
      assert.ok(elements.summary.textContent.includes(c.formatResetCountdown(c.getResetDate(window))));
    }
  }
});

test('cached, stale and sign-in-required readings tick without rebuilding allowance nodes', () => {
  const f = fixture(); const c = f.context;
  for (const kind of ['ok', 'stale', 'disconnected']) {
    const reset = {}; const node = { dataset: { label: '5-hour' }, querySelector: () => reset };
    const elements = { summary: {}, limitGrid: { querySelectorAll: () => [] }, shortLimits: { querySelectorAll: () => [node] } };
    c.accountElements.set('account', elements);
    c.accountStates.set('account', { kind, data: { windows: [{ label: '5-hour', resetAt: new Date(c.Date.now() + 65000).toISOString() }] } });
    c.updateCountdowns();
    assert.equal(elements.summary.textContent, '5h · 1m 5s');
    f.advance(1000); c.updateCountdowns();
    assert.equal(elements.summary.textContent, '5h · 1m 4s');
    assert.equal(reset.textContent, 'resets in 1m 4s');
    f.advance(70000); c.updateCountdowns();
    assert.equal(elements.summary.textContent, '5h · reset due');
    assert.equal(reset.textContent, 'reset due');
  }
});

test('unknown reset times remain explicit and countdown follows absolute time across sleep', () => {
  const f = fixture(); const c = f.context; const elements = { summary: {} };
  c.renderResetSummary(elements, { windows: [{ label: 'Weekly', resetAt: 'invalid' }] });
  assert.ok(elements.summary.textContent.includes('reset not reported'));
  const date = c.getResetDate({ resetAt: '2026-10-03T06:00:00Z' });
  assert.equal(c.formatResetCountdown(date), '2h 0m');
  f.advance(90 * 60000);
  assert.equal(c.formatResetCountdown(date), '30m 0s');
});

 test('pending operations retain their status text even with previous usage data', () => {
  const { context: c } = fixture();
  const elements = { summary: { textContent: 'Loading…', className: 'account-summary pending' } };
  c.accountElements.set('account', elements);
  c.accountStates.set('account', { kind: 'pending', data: { windows: [{ label: 'Weekly', resetAt: '2026-10-09T04:00:00Z' }] } });
  c.updateCountdowns();
  assert.equal(elements.summary.textContent, 'Loading…');
  assert.equal(elements.summary.className, 'account-summary pending');
 });
