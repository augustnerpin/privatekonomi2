// Punkt 1: split_transaction
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, tx, U, OTHER, R } from './helpers.mjs';

const mortgage = () => ({ transactions: [
  tx(50, U, 'expense', 6030, 'Boende (Lån)', '2026-09-01', '2026-09', { d: 'SBAB', mkey: 'sbab|ut', hash: 'h50', import_id: 'imp1', extra: { note: 'bolån' } }),
  tx(51, OTHER, 'expense', 6030, 'Boende (Lån)', '2026-09-01', '2026-09', { d: 'SBAB' }),
] });
const parts = [
  { amount: 1500, type: 'expense', category: 'Boende (Lån)', description: 'Ränta' },
  { amount: -4530, type: 'transfer', category: 'Bostad, lån & tillgångar', description: 'Amortering' },
];

test('delar en bolånebetalning i ränta och amortering', async () => {
  const w = await world(mortgage());
  const r = await w.call('split_transaction', { id: 50, parts });
  assert.equal(r.parts.length, 2);
  const orig = w.txRow(50);
  assert.equal(orig.deleted, true, 'originalet mjukraderas så att andra enheter tar bort det');
  assert.deepEqual(orig.extra.split_into, r.parts.map((p) => p.id));
  const [p1, p2] = r.parts.map((p) => w.txRow(p.id));
  for (const p of [p1, p2]) {
    assert.equal(p.user_id, U); assert.equal(p.deleted, false);
    assert.equal(p.tx_date, '2026-09-01'); assert.equal(p.month, '2026-09'); assert.equal(p.account, 'lonekonto'); assert.equal(p.source, 'import');
    assert.equal(p.hash, 'h50', 'hash ärvs så att omimport inte lägger in originalet igen');
    assert.equal(p.import_id, 'imp1'); assert.equal(p.mkey, null); assert.equal(p.extra.split_mkey, 'sbab|ut');
    assert.equal(p.extra.parent_id, 50); assert.equal(p.extra.note, 'bolån');
  }
  assert.equal(p1.type, 'expense'); assert.equal(p1.amount, 1500); assert.equal(p1.description, 'Ränta');
  assert.equal(p2.type, 'transfer'); assert.equal(p2.amount, -4530);
  // Delarna syns med spårning, originalet inte
  const lt = await w.call('list_transactions', { month: '2026-09' }, R);
  assert.ok(!lt.transactions.some((t) => t.id === 50));
  assert.deepEqual(lt.transactions.filter((t) => t.parent_id === 50).map((t) => t.split).sort(), ['1/2', '2/2']);
  // Månadssammanställningen: utgiften blir bara räntan, amorteringen räknas som flyttad
  const ms = await w.call('get_month_summary', { month: '2026-09' });
  assert.equal(ms.expense, 2450 + 1500); assert.equal(ms.moved_to_own_accounts, 3000 + 4530);
});

test('summakontroll med teckenkonvention', async () => {
  const w = await world(mortgage());
  const bad = await w.call('split_transaction', { id: 50, parts: [parts[0], { ...parts[1], amount: -4400 }] });
  assert.match(bad.err, /Delarnas summa \(5 900\) matchar inte originalbeloppet \(6 030\)/);
  // Fel tecken på amorteringen (positivt = pengar in för en överföring)
  const sign = await w.call('split_transaction', { id: 50, parts: [parts[0], { ...parts[1], amount: 4530 }] });
  assert.match(sign.err, /Delarnas summa \(-3 030\)/);
  // Öresfel räknas också
  assert.match((await w.call('split_transaction', { id: 50, parts: [{ ...parts[0], amount: 1500.01 }, parts[1]] })).err, /Skillnad: 0,01/);
  // Två utgifter som summerar rätt, och inkomst mot inkomst
  assert.ok(!(await w.call('split_transaction', { id: 50, parts: [{ ...parts[0], amount: 6000 }, { ...parts[0], amount: 30 }] })).err);
  assert.ok(!(await w.call('split_transaction', { id: 1, parts: [{ amount: 39000, type: 'income', category: 'Lön' }, { amount: 1000, type: 'income', category: 'Övrigt' }] })).err);
  assert.equal(w.txRow(1).deleted, true);
});

test('dry_run skriver aldrig, och fel lämnar allt orört', async () => {
  const w = await world(mortgage());
  const pre = await w.noWrites(() => w.call('split_transaction', { id: 50, parts, dry_run: true }));
  assert.equal(pre.dry_run, true); assert.equal(pre.parts[1].amount, -4530);
  await w.noWrites(() => w.call('split_transaction', { id: 50, parts: [parts[0], { ...parts[1], amount: -1 }] }));
  await w.noWrites(() => w.call('split_transaction', { id: 50, parts: [parts[0], { ...parts[1], category: 'Finns inte' }] }));
});

test('ägarkontroll och övriga fel', async () => {
  const w = await world(mortgage());
  assert.match((await w.call('split_transaction', { id: 51, parts })).err, /Hittar ingen transaktion med id 51/);
  assert.equal(w.txRow(51).deleted, false);
  assert.match((await w.call('split_transaction', { id: 50, parts: [parts[0]] })).err, /minst 2/);
  assert.match((await w.call('split_transaction', { id: 50, parts: [parts[0], { ...parts[1], category: 'Gym' }] })).err, /Del 2: Kategorin "Gym" finns inte för överföring/);
  const r = await w.call('split_transaction', { id: 50, parts });
  assert.match((await w.call('split_transaction', { id: r.parts[0].id, parts: [{ amount: 1000, type: 'expense', category: 'Boende (Lån)' }, { amount: 500, type: 'expense', category: 'Boende (Lån)' }] })).err, /redan en del av en uppdelning/);
  assert.match((await w.call('split_transaction', { id: 50, parts })).err, /Hittar ingen/);
  assert.match((await w.call('split_transaction', { id: 50, parts }, R)).err, /bara läsa/);
});
