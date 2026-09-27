// De ursprungliga verktygen: samma beteende som innan utbyggnaden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, W, R, U, OTHER } from './helpers.mjs';

test('autentisering, protokoll och behörighet', async () => {
  const w = await world();
  assert.equal((await w.h(new Request('https://x/mcp', { method: 'POST', body: '{}' }))).status, 401);
  assert.equal((await w.rpc('pkm_' + 'z'.repeat(40), 'ping')).status, 401);
  assert.ok((await w.rpc(W, 'ping', {}, 'bearer')).body.result);
  assert.equal((await w.rpc(W, 'initialize', { protocolVersion: '2025-06-18' })).body.result.protocolVersion, '2025-06-18');
  const notif = await w.h(new Request(`https://x/mcp/${W}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }));
  assert.equal(notif.status, 202);
  const lr = (await w.rpc(R, 'tools/list')).body.result.tools;
  assert.ok(lr.every((t) => t.annotations.readOnlyHint), 'läsnyckel ser bara läsverktyg');
  assert.match((await w.call('add_transaction', { amount: 1, type: 'expense', category: 'Gym' }, R)).err, /bara läsa/);
  const br = await w.h(new Request(`https://x/mcp/${W}`, { method: 'POST', body: JSON.stringify([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', id: 'b', method: 'nope' }]) }));
  const bj = await br.json(); assert.equal(bj.length, 2); assert.equal(bj[1].error.code, -32601);
  assert.equal((await w.h(new Request(`https://x/mcp?key=${R}`))).status, 200);
});

test('läsverktyg', async () => {
  const w = await world();
  const st = await w.call('get_settings');
  assert.ok(st.categories.expense.includes('Gym')); assert.deepEqual(st.budgets, { 'Mat (Butik)': 3000 });
  const lt = await w.call('list_transactions', { month: '2026-09' }, R);
  assert.equal(lt.count, 6); assert.ok(!JSON.stringify(lt).includes('HEMLIG'));
  assert.equal((await w.call('list_transactions', { search: 'anna' })).transactions[0].contact, 'Anna');
  assert.equal((await w.call('list_transactions', { type: 'expense', sort: 'amount_desc', limit: 1 })).transactions[0].amount, 2000);
  assert.equal((await w.call('list_transactions', { account: 'Lönekonto' })).count, 7);
  const sm = await w.call('summarize_transactions', { group_by: 'month' });
  assert.deepEqual(sm.groups.map((g) => [g.key, g.sum]), [['2026-08', 2000], ['2026-09', 2450]]);
  const mer = await w.call('summarize_transactions', { group_by: 'merchant', month: '2026-09' });
  assert.deepEqual(mer.groups[0], { key: 'ica nara', sum: 2000, count: 2, example: 'ICA NARA 2', avg: 1000, share_pct: 81.6 });
  const ms = await w.call('get_month_summary', { month: '2026-09' });
  assert.equal(ms.income, 40000); assert.equal(ms.expense, 2450); assert.equal(ms.savings, 5000); assert.equal(ms.balance, 32550);
  assert.equal(ms.moved_to_own_accounts, 3000); assert.equal(ms.start, '2026-08-25'); assert.equal(ms.end, '2026-09-24');
  assert.deepEqual(ms.categories.find((c) => c.category === 'Mat (Butik)'), { category: 'Mat (Butik)', spent: 2000, avg_3: 2000, budget: 3000, left: 1000 });
  assert.equal((await w.call('get_net_worth')).latest.total, 100000);
  assert.match((await w.call('list_transactions', { month: '2026-9' })).err, /Ogiltiga/);
  assert.match((await w.call('list_transactions', { foo: 1 })).err, /okänt fält/);
});

test('skrivverktyg och isolering mellan användare', async () => {
  const w = await world();
  assert.match((await w.call('add_transaction', { amount: 100, type: 'expense', category: 'Finns inte' })).err, /finns inte/);
  const add = await w.call('add_transaction', { amount: 129, type: 'expense', category: 'Gym', description: 'Friskis', date: '2026-09-24', account: 'amex' });
  assert.equal(add.created.month, '2026-09'); assert.equal(add.created.account, 'AMEX'); assert.ok(add.created.id > 99);
  assert.equal(w.txRow(add.created.id).user_id, U);
  const up = await w.call('update_transaction', { id: 2, category: 'Mat (Ute)', apply_to_same_merchant: true });
  assert.equal(up.learned_rule, 'ica nara|ut'); assert.equal(up.also_updated, 1);
  assert.equal(w.txRow(3).category, 'Mat (Ute)');
  assert.equal(w.state('merchant_rules')['ica nara|ut'].cat, 'Mat (Ute)');
  assert.equal((await w.call('update_transaction', { id: 6, date: '2026-08-26' })).updated.month, '2026-09');
  assert.match((await w.call('update_transaction', { id: 99, amount: 1 })).err, /Hittar ingen/);
  assert.match((await w.call('update_transaction', { id: 1, type: 'expense' })).err, /category/);
  assert.deepEqual(await w.call('delete_transaction', { ids: [7, 99, 12345] }), { deleted: [7], not_found: [99, 12345] });
  assert.equal(w.txRow(99).deleted, false);
  assert.deepEqual((await w.call('set_budget', { category: 'Gym', amount: 500 })).budgets, { 'Mat (Butik)': 3000, Gym: 500 });
  assert.deepEqual((await w.call('set_budget', { category: 'Mat (Butik)', amount: 0 })).budgets, { Gym: 500 });
  assert.equal(w.state('cat_budgets', OTHER)['Mat (Butik)'], 1);
  assert.equal((await w.call('set_net_worth', { period: '2026-08', values: { 'Aktier/fonder': 50000 } })).total, 150000);
  assert.match((await w.call('set_net_worth', { period: '2026-09', values: { bil: 1 } })).err, /Okänd/);
});

test('verktygslistan: läsnyckel ser bara läsverktyg, alla skrivverktyg nekas', async () => {
  const w = await world();
  const all = (await w.rpc(W, 'tools/list')).body.result.tools;
  const read = (await w.rpc(R, 'tools/list')).body.result.tools.map((t) => t.name);
  assert.equal(all.length, 27);
  assert.deepEqual(read.sort(), ['get_account_balances', 'get_loans', 'get_month_summary', 'get_net_worth', 'get_settings', 'list_contacts', 'list_rules', 'list_transactions', 'summarize_transactions']);
  for (const t of all) {
    assert.ok(t.description.length > 60 && /[åäö]/.test(t.description), `${t.name} har en svensk beskrivning`);
    assert.equal(t.inputSchema.type, 'object');
    if (!read.includes(t.name)) assert.match((await w.call(t.name, {}, R)).err, /bara läsa/, t.name);
  }
});
