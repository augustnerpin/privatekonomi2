// Buggfixar som inte får komma tillbaka.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, W, U } from './helpers.mjs';

test('löneperiod: långfredag är bankfri, skärtorsdag och annandag pingst är vardagar', async () => {
  const w = await world();
  // 2026: annandag pingst 25 maj (måndag) → lönen den 25:e, inte fredagen innan
  assert.equal((await w.call('get_month_summary', { month: '2026-06' })).start, '2026-05-25');
  // 2027: 25 mars är skärtorsdag (vardag), långfredag 26 mars
  assert.equal((await w.call('get_month_summary', { month: '2027-04' })).start, '2027-03-25');
});

test('update_transaction: oförändrad kategori som tagits bort ur listan godtas', async () => {
  const w = await world({ user_state: [{ user_id: U, key: 'cats_exp', value: ['Gym'], deleted: false }] });
  const r = await w.call('update_transaction', { id: 2, amount: 1300 });
  assert.ok(!r.err, r.err);
  assert.equal(w.txRow(2).amount, 1300);
  assert.equal(w.txRow(2).category, 'Mat (Butik)');
  // Att välja en kategori som inte finns stoppas fortfarande
  assert.match((await w.call('update_transaction', { id: 3, category: 'Finns inte' })).err, /finns inte/);
});

test('set_net_worth: borttagna kategorier räknas inte in i totalen', async () => {
  const w = await world({
    user_state: [{ user_id: U, key: 'cats_nw', value: [{ key: 'cash', label: 'Bank' }], deleted: false }],
    net_worth_snapshots: [{ user_id: U, period: '2026-08', total: 150000, amounts: { cash: 100000, klockor: 50000 }, deleted: false }],
  });
  const r = await w.call('set_net_worth', { period: '2026-08', values: { cash: 90000 } });
  assert.equal(r.total, 90000);
});

test('tom batch ger Invalid Request', async () => {
  const w = await world();
  const r = await w.h(new Request(`https://x/mcp/${W}`, { method: 'POST', body: '[]' }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, -32600);
});
