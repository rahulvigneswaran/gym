const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'gym.html'), 'utf8');
const source = html.match(/<script id="recomp-core">([\s\S]*?)<\/script>/)?.[1];
function core() {
  assert.ok(source, 'The portable analytics core must be embedded in gym.html');
  const context = vm.createContext({ TextEncoder, Date });
  vm.runInContext(source, context);
  return vm.runInContext('RecompCore', context);
}
const sets = (...pairs) => pairs.map(([weight, reps = 12]) => ({ weight: String(weight), reps: String(reps) }));
const target = { repMin: 12, repMax: 12 };
function estimate(pairs, prescription = target, options) {
  return core().estimateWorkingLoad(sets(...pairs), prescription, options);
}

test('progress source remains byte-for-byte intact', () => {
  const data = fs.readFileSync(path.join(root, 'recomp-2026-09-11.json'));
  assert.equal(createHash('sha256').update(data).digest('hex'), 'b96f4778e5ea7a7656dde6e8c226fd33ec0ffa6b742181e9ab741d140c558a4f');
});
test('raising load at target reps selects the final load, not the first', () => {
  const x = estimate([[5], [7.5], [10]]);
  assert.equal(x.weight, 10);
  assert.equal(x.pattern, 'raised');
  assert.equal(x.index, 2);
});
test('backing off selects the final load, not the maximum', () => {
  const x = estimate([[10], [7.5], [5]]);
  assert.equal(x.weight, 5);
  assert.equal(x.pattern, 'backed-off');
});
test('a heavier missed-rep attempt cannot become the best usable load', () => {
  const x = estimate([[5], [5], [10, 8]]);
  assert.equal(x.weight, 5);
  assert.equal(x.pattern, 'reps-short');
  assert.equal(x.missed, 1);
});
test('non-monotonic attempts still settle on the last successful target set', () => {
  assert.equal(estimate([[5], [10, 8], [7.5]]).weight, 7.5);
  assert.equal(estimate([[10], [5], [7.5]]).weight, 7.5);
});
test('a later failure at the same load rules out that earlier load', () => {
  assert.equal(estimate([[22.5], [30], [30, 7]]).weight, 22.5);
});
test('a failure after reducing the load does not recommend the earlier heavier load', () => {
  assert.equal(estimate([[10], [5, 8]]).weight, null);
});
test('all missed targets produce no confirmed weight, not zero or a guessed reduction', () => {
  const x = estimate([[10, 8], [7.5, 9], [5, 10]]);
  assert.equal(x.weight, null);
  assert.equal(x.confidence, 'none');
});
test('one successful set remains provisional; repeated target sets are identified', () => {
  assert.equal(estimate([[5]]).confidence, 'single');
  assert.equal(estimate([[5], [5], [5]]).confidence, 'repeated');
});
test('range targets use the displayed default, the top of the range', () => {
  assert.equal(estimate([[5, 12], [10, 10]], { repMin: 8, repMax: 12 }).weight, 5);
});
test('unknown historical targets never get guessed from the reps performed', () => {
  const x = estimate([[10, 8], [5, 8]], null);
  assert.equal(x.weight, null);
  assert.equal(x.pattern, 'unknown-target');
});
test('blank, negative, non-finite, zero-rep, undone and warmup sets are not load evidence', () => {
  const raw = [...sets([5]), { weight: '', reps: '12' }, { weight: '-10', reps: '12' },
    { weight: 'Infinity', reps: '12' }, { weight: '10kg', reps: '12' },
    { weight: '20', reps: '0' }, { weight: '30', reps: '12', done: false },
    { weight: '40', reps: '12', warmup: true }];
  assert.equal(core().estimateWorkingLoad(raw, target).weight, 5);
});
test('bodyweight is distinct from an unlogged weighted load', () => {
  assert.equal(core().estimateWorkingLoad([{ weight: '', reps: '12' }], target, { mode: 'body' }).weight, 0);
  assert.equal(core().estimateWorkingLoad([{ weight: '', reps: '12' }], target, { mode: 'dbPair' }).weight, null);
});
test('assistance uses inverse difficulty for later failed attempts', () => {
  assert.equal(estimate([[30], [20, 8]], target, { assistance: true }).weight, 30);
});
test('estimation does not modify original set objects', () => {
  const raw = sets([5], [10, 8]);
  raw.forEach(Object.freeze); Object.freeze(raw);
  const before = JSON.stringify(raw);
  core().estimateWorkingLoad(raw, target);
  assert.equal(JSON.stringify(raw), before);
});
test('unit conversion keeps zero and converts kg/lb without relabelling', () => {
  assert.ok(Math.abs(core().convertWeight(10, 'kg', 'lb') - 22.046226218) < .00001);
  assert.ok(Math.abs(core().convertWeight(22.046226218, 'lb', 'kg') - 10) < .00001);
  assert.equal(core().convertWeight(0, 'kg', 'lb'), 0);
});
test('rest uses a deadline and ceiling, never rings half a second early', () => {
  assert.equal(core().restRemaining({ endsAt: 10000 }, 9501), 1);
  assert.equal(core().restRemaining({ endsAt: 10000 }, 10000), 0);
  assert.equal(core().restRemaining({ endsAt: 10000 }, 999999), 0);
  assert.equal(core().restRemaining(null, 9000), 0);
});

const fixture = JSON.parse(fs.readFileSync(path.join(root, 'recomp-2026-09-11.json'), 'utf8'));
test('legacy targets are inferred from the anchored plan, not actual repetitions', () => {
  const log = fixture.history.find(l => l.date.startsWith('2026-08-31'));
  const entry = log.entries.find(e => e.exerciseId === 'back-squat');
  const p = core().inferPrescription(log, entry, fixture.program, '2026-08-24');
  assert.equal(p.repMax, 6);
  assert.equal(p.source, 'inferred');
});
test('ambiguous legacy targets without a calendar anchor stay unknown', () => {
  const log = fixture.history[0];
  assert.equal(core().inferPrescription(log, log.entries[0], fixture.program, null), null);
});
test('recorded targets win over subsequently edited programmes', () => {
  const p = core().inferPrescription({ focus: 'Changed' }, { exerciseId: 'x', repMin: 8, repMax: 8 }, { days: [] }, null);
  assert.equal(p.repMax, 8);
  assert.equal(p.source, 'recorded');
});
test('the actual lat-pulldown overshoot selects 37.5kg, not 45kg', () => {
  const log = fixture.history.find(l => l.date.startsWith('2026-08-31'));
  const entry = log.entries.find(e => e.exerciseId === 'lat-pulldown');
  const p = core().inferPrescription(log, entry, fixture.program, '2026-08-24');
  assert.equal(core().estimateWorkingLoad(entry.sets, p).weight, 37.5);
});
test('the actual skullcrusher overshoot selects 15kg, not 20kg', () => {
  const log = fixture.history.at(-1);
  const entry = log.entries.find(e => e.exerciseId === 'skullcrusher');
  const p = core().inferPrescription(log, entry, fixture.program, '2026-08-24');
  assert.equal(core().estimateWorkingLoad(entry.sets, p).weight, 15);
});
test('calendar export has local events, native display alarms, escaping and CRLF folding', () => {
  const value = core().calendarText([{ date: '2026-09-11', focus: 'Full Body #3', description: 'Row, press; lift\n' + 'é'.repeat(90) },
    { date: '2026-09-12', focus: 'Rest', description: 'Recovery' }], '09:00', new Date('2026-09-11T00:00:00Z'));
  assert.match(value, /BEGIN:VCALENDAR\r\n/);
  assert.equal((value.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(value, /DTSTART:20260911T090000/);
  assert.match(value, /TRIGGER:PT0S/);
  assert.match(value, /Row\\, press\\; lift\\n/);
  for (const line of value.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, 'RFC 5545 lines must fit 75 octets');
});