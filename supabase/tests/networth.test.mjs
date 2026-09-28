// Förmögenhet från saldon, manuella värden och lån (functions/_shared/networth.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNetWorth, accountReturn, nwCatOf, valueAt } from '../functions/_shared/networth.ts';

// Samma läge som förmögenhetsbilden 2026-10 (707 104 kr)
const accounts = [
  { id: 'lonekonto', kind: 'bank' }, { id: 'amex', kind: 'card' }, { id: 'seb_45bb', kind: 'bank' },
  { id: 'seb_8f8e', kind: 'savings' }, { id: 'seb_1dfa', kind: 'savings' },
  { id: 'avanza_isk', kind: 'investment', nw_cat: 'stocks', sav_cat: 'Avanza', manual: true },
  { id: 'klarna', kind: 'savings', nw_cat: 'cash', manual: true },
];
const balances = [
  ['lonekonto', 8446.22], ['seb_45bb', 8449], ['seb_8f8e', 0], ['seb_1dfa', 2279.75], ['avanza_isk', 168000], ['klarna', 210825.03],
].map(([account, value]) => ({ account, bal_date: '2026-09-28', value }));
const assets = [['apt', 1700000], ['klockor', 31000], ['ab', 31300], ['kontanter', 1200], ['pension', 58000]].map(([asset, value]) => ({ asset, val_date: '2026-09-28', value }));
const loans = [['L1', 648491], ['L2', 650300], ['L3', 213605]].map(([id, v]) => ({ id, secured_by: 'apt', history: [{ date: '2026-09-28', value: v }] }));

test('computeNetWorth: konton, manuella värden och lån ger samma som förmögenhetsbilden', () => {
  const r = computeNetWorth({ accounts, balances, assets, loans, date: '2026-09-28', prev: null });
  assert.deepEqual(r.amounts, { cash: 230000, stocks: 168000, apt: 187604, pension: 58000, klockor: 31000, ab: 31300, kontanter: 1200, other: 0 });
  assert.equal(r.total, 707104);
  assert.equal(r.sources.apt, 'värde+lån');
  assert.equal(r.sources.cash, 'konton');
});

test('computeNetWorth: bara saldon före datumet, och kategorier utan källa behåller förra värdet', () => {
  const r = computeNetWorth({ accounts, balances: [...balances, { account: 'klarna', bal_date: '2026-10-05', value: 1 }], assets: [], loans: [], date: '2026-09-30', prev: { apt: 187000, other: 5 } });
  assert.equal(r.amounts.cash, 230000);                 // saldot 2026-10-05 räknas inte
  assert.equal(r.amounts.apt, 187000); assert.equal(r.sources.apt, 'förra');
  assert.equal(r.amounts.pension, 0);                   // varken källa eller förra värde
  // Lån utan tillgång dras från Övrigt
  const r2 = computeNetWorth({ accounts: [], balances: [], assets: [], loans: [{ id: 'X', history: [{ date: '2026-09-01', value: 100 }] }], date: '2026-09-30' });
  assert.equal(r2.amounts.other, -100);
});

test('nwCatOf, valueAt och avkastning på Avanza', () => {
  assert.equal(nwCatOf({ kind: 'bank' }), 'cash'); assert.equal(nwCatOf({ kind: 'investment' }), 'stocks'); assert.equal(nwCatOf({ kind: 'card' }), null); assert.equal(nwCatOf({ kind: 'bank', nw_cat: '' }), null);
  assert.deepEqual(valueAt([{ bal_date: '2026-01-01', value: 1 }, { bal_date: '2026-03-01', value: 3 }, { bal_date: '2026-02-01', value: 2 }], '2026-02-15'), { date: '2026-02-01', value: 2 });
  const bal = [{ account: 'avanza_isk', bal_date: '2026-01-01', value: 100000 }, { account: 'avanza_isk', bal_date: '2026-09-28', value: 168000 }];
  const txs = [{ type: 'savings', category: 'Avanza', amount: 10000, tx_date: '2026-03-01' }, { type: 'savings', category: 'Avanza', amount: 40000, tx_date: '2026-06-01' }, { type: 'savings', category: 'SEB', amount: 999, tx_date: '2026-06-01' }];
  assert.deepEqual(accountReturn(accounts[5], bal, txs), { from: '2026-01-01', to: '2026-09-28', start: 100000, value: 168000, deposits: 50000, return: 18000 });
});
