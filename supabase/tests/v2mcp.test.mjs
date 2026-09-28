// MCP v2: mål, manuella värden, förmögenhetskategorier, uppdelning i get_net_worth och taggar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, tx, U, R } from './helpers.mjs';

const snaps = [
  { user_id: U, period: '2026-09', total: 659000, amounts: { cash: 234000, stocks: 172500, pension: 55000, apt: 134000, klockor: 31000, ab: 31300, kontanter: 1200, other: 0 }, deleted: false },
  { user_id: U, period: '2026-10', total: 707104, amounts: { cash: 230000, stocks: 168000, pension: 58000, apt: 187604, klockor: 31000, ab: 31300, kontanter: 1200, other: 0 }, deleted: false },
];

test('set_net_worth_goal + get_goal_progress: krav per månad, plan och scenarier', async () => {
  const w = await world({ net_worth_snapshots: snaps, loans: [], loan_balances: [] });
  const r = await w.call('set_net_worth_goal', { amount: 950000, target_date: '2027-12', planned_savings: 10000 });
  assert.deepEqual(r.plan_starts_at, { period: '2026-10', total: 707104 });
  assert.deepEqual(w.state('goal_start'), { period: '2026-10', total: 707104 });
  const g = await w.call('get_goal_progress', {}, R);
  assert.equal(g.required_per_month, 16193); assert.equal(g.months_left, 15); assert.equal(g.plan.vs_plan, 0);
  assert.deepEqual(g.scenarios.map((s) => s.key), ['svagt', 'plan', 'bra']);
  assert.equal(g.scenarios[1].monthly_savings, 10000); assert.equal(g.scenarios[0].path, undefined);
  assert.match((await w.call('set_net_worth_goal', { amount: 1 }, R)).err, /bara läsa/);
});

test('set_asset_value och förmögenhetskategorier (CRUD)', async () => {
  const w = await world({ net_worth_snapshots: snaps, asset_values: [] });
  const r = await w.call('set_asset_value', { asset: 'Lägenhet', value: 1700000, date: '2026-09-28' });
  assert.equal(r.asset, 'apt'); assert.equal(w.tables.asset_values[0].value, 1700000);
  assert.match((await w.call('set_asset_value', { asset: 'Båt', value: 1 })).err, /Okänd/);
  const l = await w.call('list_net_worth_categories', {}, R);
  assert.deepEqual(l.categories.find((c) => c.key === 'apt').manual_value, { value: 1700000, date: '2026-09-28' });
  assert.equal(l.categories.find((c) => c.key === 'cash').latest, 230000);
  assert.deepEqual((await w.call('create_net_worth_category', { label: 'Bil' })).created, { key: 'bil', label: 'Bil' });
  assert.match((await w.call('create_net_worth_category', { label: 'bil' })).err, /finns redan/);
  await w.call('rename_net_worth_category', { category: 'bil', label: 'Bilen' });
  assert.equal(w.state('cats_nw').find((c) => c.key === 'bil').label, 'Bilen');
  assert.match((await w.call('delete_net_worth_category', { category: 'klockor' })).err, /confirm: true/);
  await w.call('delete_net_worth_category', { category: 'klockor', confirm: true });
  assert.ok(!w.state('cats_nw').some((c) => c.key === 'klockor'));
});

test('get_net_worth: uppdelning av förändringen', async () => {
  const w = await world({ net_worth_snapshots: snaps, transactions: [tx(50, U, 'savings', 10000, 'SEB', '2026-09-01', '2026-09')] });
  const n = await w.call('get_net_worth', {}, R);
  const s = n.breakdown.steps.at(-1);
  assert.equal(s.change, 48104); assert.equal(s.sparande, 15000); // 10 000 + testvärldens 5 000 till Avanza
  assert.equal(s.sparande + s.amortering + s.avkastning + s.omvardering + s.ovrigt, s.change);
  assert.equal(s.omvardering, 53604); // lägenhetens nya värde
});

test('taggar: filter, summering per tagg, update_transaction och bulk_update_transactions', async () => {
  const w = await world({ transactions: [
    tx(61, U, 'expense', 500, 'Resa', '2026-09-02', '2026-09', { extra: { tags: ['London'] } }),
    tx(62, U, 'expense', 300, 'Resa', '2026-09-03', '2026-09', { extra: { tags: ['London', 'Semester'] } }),
    tx(63, U, 'expense', 200, 'Resa', '2026-09-04', '2026-09'),
  ] });
  const lt = await w.call('list_transactions', { tag: 'london' }, R);
  assert.deepEqual(lt.transactions.map((t) => t.id).sort(), [61, 62]); assert.deepEqual(lt.transactions.find((t) => t.id === 62).tags, ['London', 'Semester']);
  const sm = await w.call('summarize_transactions', { group_by: 'tag', category: 'Resa' }, R);
  assert.deepEqual(Object.fromEntries(sm.groups.map((g) => [g.key, g.sum])), { London: 800, Semester: 300, '(ingen tagg)': 200 });
  await w.call('update_transaction', { id: 63, add_tags: ['Spanien'] });
  assert.deepEqual(w.txRow(63).extra.tags, ['Spanien']);
  await w.call('update_transaction', { id: 62, remove_tags: ['semester'] });
  assert.deepEqual(w.txRow(62).extra.tags, ['London']);
  const pre = await w.call('bulk_update_transactions', { filter: { category: 'Resa' }, changes: { add_tags: ['2026'] } });
  assert.equal(pre.would_update, 3);
  await w.call('bulk_update_transactions', { filter: { category: 'Resa' }, changes: { add_tags: ['2026'] }, dry_run: false, expected_count: 3 });
  assert.deepEqual(w.txRow(61).extra.tags, ['London', '2026']); assert.equal(w.txRow(61).category, 'Resa');
  await w.call('bulk_update_transactions', { ids: [61], changes: { tags: [] }, dry_run: false, expected_count: 1 });
  assert.equal(w.txRow(61).extra.tags, undefined);
});

test('get_net_worth: skulder per förmögenhetsbild vid periodstart, bakåträknade som i breakdown', async () => {
  const loans = [['A', 648491, 1167], ['B', 650300, 1100], ['C', 213605, 279]].map(([id, v, am], i) => ({ user_id: U, id, name: `Del ${i + 1}`, amortization: am, secured_by: 'apt', netted_in_assets: true, extra: {}, deleted: false }));
  const loan_balances = [['A', 648491], ['B', 650300], ['C', 213605]].map(([loan_id, value]) => ({ user_id: U, loan_id, bal_date: '2026-09-28', value, deleted: false }));
  const w = await world({ loans, loan_balances, net_worth_snapshots: [
    { user_id: U, period: '2026-08', total: 639000, amounts: { apt: 134000, cash: 505000 }, deleted: false }, ...snaps] });
  const n = await w.call('get_net_worth', {}, R);
  const by = Object.fromEntries(n.snapshots.map((x) => [x.period, x]));
  const now = 648491 + 650300 + 213605, am = 2546;
  // 2026-08 börjar 24/7: tre dragningar (28/7, 28/8, 28/9) före första saldot; 2026-09 (25/8): två; 2026-10 (25/9): en
  assert.equal(by['2026-08'].liabilities, now + 3 * am); assert.equal(by['2026-09'].liabilities, now + 2 * am); assert.equal(by['2026-10'].liabilities, now + am);
  assert.equal(by['2026-10'].liabilities_date, '2026-09-25'); assert.equal(by['2026-10'].liabilities_estimated, true);
  assert.equal(by['2026-10'].liabilities_by_loan['Del 1'], 648491 + 1167);
  assert.equal(by['2026-10'].gross_assets, 707104 + now + am); assert.equal(by['2026-10'].net, 707104);
  // Samma skuldförändring som breakdown räknar som amortering
  assert.equal(by['2026-09'].liabilities - by['2026-10'].liabilities, n.breakdown.steps.at(-1).amortering);
});
