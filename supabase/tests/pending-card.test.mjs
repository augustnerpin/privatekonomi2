// AMEX (väntande): när kortutdraget för perioden importeras ersätts periodens väntande rader av utdragets köp
// (settlePendingCard i functions/_shared/finance.ts och settlePendingCardApp i appen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlePendingCard, PENDING_CARD_CAT } from '../functions/_shared/finance.ts';
import { appFns } from './app.mjs';

const P = PENDING_CARD_CAT;
// Period 2026-10: tre betalningar till AMEX-kontot = 8 449 kr väntande, plus en vanlig utgift
const period = () => [
  { id: 1, type: 'expense', cat: P, amount: 400, month: '2026-10', account: 'lonekonto' },
  { id: 2, type: 'expense', cat: P, amount: 7930, month: '2026-10', account: 'seb_1dfa' },
  { id: 3, type: 'expense', cat: P, amount: 119, month: '2026-10', account: 'lonekonto' },
  { id: 4, type: 'expense', cat: 'Mat (Butik)', amount: 1000, month: '2026-10', account: 'lonekonto' },
  { id: 5, type: 'expense', cat: P, amount: 2500, month: '2026-09', account: 'lonekonto' }, // annan period: rörs inte
];
// Utdragets köp för perioden (samma pengar som de väntande betalningarna)
const statement = [
  { id: 10, type: 'expense', cat: 'Mat (Ute)', amount: 5000, month: '2026-10', account: 'amex', source: 'import' },
  { id: 11, type: 'expense', cat: 'Shopping', amount: 3449, month: '2026-10', account: 'amex', source: 'import' },
];
const expenses = (txs, m) => txs.filter((t) => t.month === m && t.type === 'expense').reduce((s, t) => s + t.amount, 0);
const app = appFns(['settlePendingCardApp', 'pendingCardIn'], { PENDING_CARD_CAT: P, getTxs: () => [] });

test('2026-10: 8 449 kr väntande visas, och importen av utdraget ger inga dubbla utgifter', () => {
  const txs = period();
  assert.deepEqual(app.pendingCardIn('2026-10', txs), { sum: 8449, n: 3 });
  assert.equal(expenses(txs, '2026-10'), 9449);
  // Import: köpen läggs till och de väntande raderna i samma period blir kortbetalningar
  txs.push(...statement.map((t) => ({ ...t })));
  const ids = app.settlePendingCardApp(txs, '2026-10', 'Kreditkortsbetalning');
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(expenses(txs, '2026-10'), 1000 + 8449); // inte 1000 + 8449 + 8449
  assert.deepEqual(app.pendingCardIn('2026-10', txs), { sum: 0, n: 0 });
  assert.deepEqual(txs.filter((t) => ids.includes(t.id)).map((t) => [t.type, t.cat, t.amount]), [['transfer', 'Kreditkortsbetalning', -400], ['transfer', 'Kreditkortsbetalning', -7930], ['transfer', 'Kreditkortsbetalning', -119]]);
  assert.equal(expenses(txs, '2026-09'), 2500);
  assert.deepEqual(app.settlePendingCardApp(txs, '2026-10', 'Kreditkortsbetalning'), []); // en gång till: inget
});

test('servern: samma regel på bankrader (category), t.ex. en ny betalning efter att utdraget redan importerats', () => {
  const rows = period().map(({ cat, ...r }) => ({ ...r, category: cat }));
  assert.deepEqual(settlePendingCard(rows, ['2026-10']), [1, 2, 3]);
  assert.equal(rows.filter((r) => r.month === '2026-10' && r.type === 'expense').reduce((s, r) => s + r.amount, 0), 1000);
  assert.equal(rows.find((r) => r.id === 5).category, P);
  assert.deepEqual(settlePendingCard(rows, []), []);
});
