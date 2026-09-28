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

test('delete_transaction: motpartens överföringslänk tas bort', async () => {
  const { tx } = await import('./helpers.mjs');
  const w = await world({ transactions: [
    tx(60, U, 'transfer', -3000, 'Egen överföring', '2026-09-10', '2026-09', { extra: { transfer_pair_id: 61 } }),
    tx(61, U, 'transfer', 3000, 'Egen överföring', '2026-09-10', '2026-09', { account: 'amex', extra: { transfer_pair_id: 60, note: 'kvar' } }),
  ] });
  const r = await w.call('delete_transaction', { ids: [60] });
  assert.deepEqual(r.deleted, [60]);
  assert.deepEqual(w.txRow(61).extra, { note: 'kvar' });
});

test('bulk_update_transactions: rader i borttagen kategori kan få nytt konto', async () => {
  const w = await world({ user_state: [{ user_id: U, key: 'cats_exp', value: ['Gym'], deleted: false }] });
  const r = await w.call('bulk_update_transactions', { ids: [2, 3], changes: { account: 'AMEX' }, dry_run: false, expected_count: 2 });
  assert.ok(!r.err, r.err);
  assert.equal(w.txRow(2).account, 'amex');
  assert.equal(w.txRow(2).category, 'Mat (Butik)');
});

test('set_loan/get_loans: räntetyp, bindningstid, villkorsändringsdag och betalkonto', async () => {
  const w = await world({ loans: [], loan_balances: [] });
  await w.call('set_loan', { name: 'Bolån', interest_pct: 3.2, rate_type: 'bunden', fixed_until: '2027-03-01', rate_change_date: '2026-12-01', pay_account: 'Lönekonto', balance: 1800000, balance_date: '2026-09-01' });
  const l = (await w.call('get_loans')).loans[0];
  assert.equal(l.rate_type, 'bunden'); assert.equal(l.fixed_until, '2027-03-01'); assert.equal(l.rate_change_date, '2026-12-01'); assert.equal(l.pay_account, 'lonekonto');
  assert.match((await w.call('set_loan', { loan: 'Bolån', pay_account: 'Finns inte' })).err, /Okänt konto/);
});

test('MCP-nyckel som gått ut nekas; utan utgångsdatum gäller den', async () => {
  const { M } = await import('./helpers.mjs');
  const EXP = 'pkm_' + 'e'.repeat(40);
  const w = await world({ mcp_tokens: [{ id: 't9', user_id: U, scope: 'read', token_hash: await M.sha256hex(EXP), expires_at: '2020-01-01T00:00:00Z' }] });
  const r = await w.rpc(EXP, 'ping');
  assert.equal(r.status, 401); assert.match(r.body.error, /gått ut/);
  assert.ok((await w.rpc(W, 'ping')).body.result);
});
