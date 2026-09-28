// Underlag för bokslut, veckobrev och takt (functions/bank/review.ts) + taktnotisen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodFacts, weekFacts, pace, profileText } from '../functions/bank/review.ts';
import { buildDigest } from '../functions/bank/notify.ts';

const r = (month, type, category, amount, tx_date, description = 'x') => ({ month, type, category, amount, tx_date, description });
const rows = [
  r('2026-09', 'income', 'Lön', 30000, '2026-08-25'), r('2026-09', 'expense', 'Mat (Ute)', 2500, '2026-09-01', 'MAX'),
  r('2026-09', 'expense', 'Resa', 4000, '2026-09-10', 'SAS'), r('2026-09', 'savings', 'Avanza', 5000, '2026-08-26'),
  r('2026-08', 'expense', 'Mat (Ute)', 1500, '2026-08-01'), r('2026-07', 'expense', 'Mat (Ute)', 1000, '2026-07-01'),
  r('2026-06', 'expense', 'Mat (Ute)', 500, '2026-06-01'),
];

test('periodFacts: totaler, snitt av tre perioder och budget', () => {
  const f = periodFacts(rows, '2026-09', { 'Mat (Ute)': 2000, Gym: 400 });
  assert.equal(f.income, 30000); assert.equal(f.expense, 6500); assert.equal(f.savings, 5000); assert.equal(f.left, 18500);
  assert.equal(f.savings_rate_pct, 17); assert.equal(f.expense_avg3, 1000);
  assert.deepEqual(f.by_category.find((c) => c.category === 'Mat (Ute)'), { category: 'Mat (Ute)', spent: 2500, avg3: 1000, budget: 2000 });
  assert.deepEqual(f.by_category.find((c) => c.category === 'Gym'), { category: 'Gym', spent: 0, avg3: 0, budget: 400 });
  assert.equal(f.top_expenses[0].description, 'SAS');
});

test('weekFacts: senaste 7 dagarna mot snittveckan', () => {
  const w = weekFacts([r('2026-10', 'expense', 'Mat (Ute)', 700, '2026-10-02'), r('2026-10', 'expense', 'Fest', 300, '2026-10-03'), r('2026-09', 'expense', 'Mat (Ute)', 1600, '2026-09-20')], '2026-10-04');
  assert.equal(w.from, '2026-09-27'); assert.equal(w.to, '2026-10-03'); assert.equal(w.spent, 1000); assert.equal(w.usual_week, 400);
  assert.deepEqual(w.by_category[0], { category: 'Mat (Ute)', spent: 700, usual: 400 });
});

test('pace: utgifter hittills mot samma dag i tidigare perioder, och notis vid klart högre takt', () => {
  const starts = { '2026-10': '2026-09-25', '2026-09': '2026-08-25', '2026-08': '2026-07-24', '2026-07': '2026-06-25' };
  const pr = [
    r('2026-10', 'expense', 'x', 4000, '2026-09-26'), r('2026-10', 'expense', 'x', 1000, '2026-09-30'),
    r('2026-09', 'expense', 'x', 2000, '2026-08-27'), r('2026-09', 'expense', 'x', 9000, '2026-09-20'), // efter dag 6: räknas inte
    r('2026-08', 'expense', 'x', 1000, '2026-07-26'),
  ];
  const p = pace(pr, '2026-10', starts, '2026-09-30');
  assert.deepEqual(p, { day: 6, cur: 5000, avg: 1500 });
  const d = buildDigest({ newRows: [], spent: {}, budgets: {}, period: { id: '2026-10', start: '2026-09-25', end: '2026-10-22' }, today: '2026-09-30', conns: [], sent: new Set(), pace: p });
  assert.deepEqual(d.keys, ['takt:2026-10:0']);
  assert.match(d.body, /5 000 kr i utgifter hittills, 3 500 kr mer än vanligt vid dag 6/);
  // Nära det vanliga → ingen notis
  assert.equal(buildDigest({ newRows: [], spent: {}, budgets: {}, period: { id: '2026-10', start: '2026-09-25', end: '2026-10-22' }, today: '2026-09-30', conns: [], sent: new Set(), pace: { day: 6, cur: 1700, avg: 1500 } }), null);
});

test('profileText', () => {
  assert.equal(profileText({ work: { gross: '42000', employer: 'Skocentrum' }, updated: '2026-09-28', housing: { type: 'bostadsrätt' } }), 'work: gross=42000; employer=Skocentrum\nhousing: type=bostadsrätt');
  assert.equal(profileText(null), '');
});
