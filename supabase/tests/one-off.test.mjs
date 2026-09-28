// Engångsinkomster (extra.once / t.once, t.ex. skatteåterbäring, gåva): ingår i periodens inkomst men inte i snitt,
// prognoser, sparkvot eller kvar per dag. Appens egen kod (forecast, dailyBudget, recInc) och serverns (periodFacts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recurringIncome, oneOffIncome } from '../functions/_shared/finance.ts';
import { periodFacts } from '../functions/bank/review.ts';
import { appFns } from './app.mjs';

const ymdOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const parseLocalDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const periodShift = (ym, n) => { const [y, m] = ym.split('-').map(Number); const x = new Date(y, m - 1 + n, 1); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0'); };
const getPeriodStart = (ym) => ymdOf(new Date(...(([y, m]) => [y, m - 2, 25])(ym.split('-').map(Number)))); // löneperiod 25:e–24:e

let TXS = [];
const app = appFns(['isOnceInc', 'recInc', 'onceInc', 'median', 'ONE_OFF', 'periodEndDate', 'forecast', 'dailyBudget'], {
  getTxs: () => TXS, parseLocalDate, getPeriodStart, periodShift, ymdOf, todayLocal: () => '2026-10-01', currentPayPeriod: () => '2026-10',
  fixedCats: () => ({}), detectRecurring: () => [], mkeyBase: (t) => t.desc, getFixedCosts: () => [], getPlannedSavings: () => 10000, isFixedTx: () => false,
});
const tx = (id, month, type, cat, amount, extra = {}) => ({ id, month, type, cat, amount, date: month === '2026-10' ? '2026-09-26' : '2026-08-26', desc: cat, ...extra });

test('kvar per dag och prognos: skatteåterbäringen 8 000 kr ger inte mer att spendera', () => {
  const base = [tx(1, '2026-10', 'income', 'Lön', 30000), tx(2, '2026-10', 'expense', 'Mat (Butik)', 5000), tx(3, '2026-09', 'income', 'Lön', 30000)];
  TXS = base;
  const without = app.dailyBudget('2026-10');
  TXS = [...base, tx(4, '2026-10', 'income', 'Övrigt', 8000, { once: true })];
  const withOnce = app.dailyBudget('2026-10');
  assert.equal(withOnce.inc, 30000);
  assert.equal(withOnce.perDayBudget, without.perDayBudget);
  assert.equal(app.forecast('2026-10').free, without.free);
  // Som vanlig inkomst hade den gett 8 000 kr mer
  TXS = [...base, tx(4, '2026-10', 'income', 'Övrigt', 8000)];
  assert.equal(app.dailyBudget('2026-10').inc, 38000);
  // Snittet när lönen inte kommit än: bara vanliga inkomster från tidigare perioder
  TXS = [tx(3, '2026-09', 'income', 'Lön', 30000), tx(5, '2026-09', 'income', 'Gåva', 20000, { once: true })];
  const f = app.forecast('2026-10');
  assert.deepEqual([f.inc, f.incEst], [30000, true]);
});

test('sparkvot och snitt: utan engångsinkomster, både i appen och på servern', () => {
  const list = [tx(1, '2026-10', 'income', 'Lön', 30000), tx(2, '2026-10', 'income', 'Övrigt', 8000, { once: true }), tx(3, '2026-10', 'savings', 'Avanza', 6000)];
  assert.deepEqual([app.recInc(list), app.onceInc(list)], [30000, 8000]);
  assert.equal(app.isOnceInc({ type: 'expense', once: true }), false);
  const rows = list.map(({ cat, once, ...r }) => ({ ...r, category: cat, tx_date: r.date, extra: once ? { once: true } : {} }));
  assert.deepEqual([recurringIncome(rows), oneOffIncome(rows)], [30000, 8000]);
  const f = periodFacts(rows, '2026-10');
  assert.equal(f.income, 38000);             // periodens inkomst är det som faktiskt kom in
  assert.equal(f.savings_rate_pct, 20);      // 6 000 / 30 000, inte 6 000 / 38 000 = 16 %
  assert.equal(f.one_off_income, 8000);
});
