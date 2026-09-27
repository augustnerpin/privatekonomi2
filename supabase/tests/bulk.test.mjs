// Punkt 5: batch-uppdatering med förhandsgranskning
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, tx, U, OTHER } from './helpers.mjs';

const spain = () => ({ transactions: [
  tx(30, U, 'expense', 320, 'Spanien', '2026-07-02', '2026-07', { d: 'MERCADONA' }),
  tx(31, U, 'expense', 180, 'Spanien', '2026-07-03', '2026-07', { d: 'TAPAS BAR' }),
  tx(32, U, 'expense', 900, 'Resa', '2026-07-01', '2026-07', { d: 'SAS' }),
  tx(33, OTHER, 'expense', 50, 'Spanien', '2026-07-02', '2026-07', { d: 'ANNAN' }),
] });

test('dry_run är standard och skriver aldrig', async () => {
  const w = await world(spain());
  const pre = await w.noWrites(() => w.call('bulk_update_transactions', { filter: { category: 'Spanien' }, changes: { category: 'Resa' } }));
  assert.equal(pre.dry_run, true); assert.equal(pre.would_update, 2); assert.equal(pre.expected_count, 2);
  assert.deepEqual(pre.changes.map((x) => [x.id, x.before.category, x.after.category]), [[31, 'Spanien', 'Resa'], [30, 'Spanien', 'Resa']]);
  // Även utan expected_count, med fel antal eller med fel i urvalet: ingen skrivning
  await w.noWrites(() => w.call('bulk_update_transactions', { filter: { category: 'Spanien' }, changes: { category: 'Resa' }, dry_run: false }));
  await w.noWrites(() => w.call('bulk_update_transactions', { filter: { category: 'Spanien' }, changes: { category: 'Resa' }, dry_run: false, expected_count: 3 }));
  await w.noWrites(() => w.call('bulk_update_transactions', { filter: { category: 'Spanien' }, changes: { category: 'Finns inte' }, dry_run: false, expected_count: 2 }));
  assert.equal(w.txRow(30).category, 'Spanien');
});

test('skriver med dry_run: false och rätt expected_count', async () => {
  const w = await world(spain());
  assert.match((await w.call('bulk_update_transactions', { filter: { category: 'Spanien' }, changes: { category: 'Resa' }, dry_run: false })).err, /Ange expected_count \(2/);
  assert.match((await w.call('bulk_update_transactions', { filter: { category: 'Spanien' }, changes: { category: 'Resa' }, dry_run: false, expected_count: 5 })).err, /nu 2, inte 5/);
  const done = await w.call('bulk_update_transactions', { filter: { category: 'Spanien' }, changes: { category: 'Resa' }, dry_run: false, expected_count: 2 });
  assert.equal(done.updated, 2);
  assert.equal(w.txRow(30).category, 'Resa'); assert.equal(w.txRow(31).category, 'Resa');
  assert.equal(w.txRow(33).category, 'Spanien', 'annan användares rad rörs inte');
  assert.equal((await w.call('bulk_update_transactions', { filter: { category: 'Spanien' }, changes: { category: 'Resa' } })).would_update, 0);
});

test('ids, typbyte, konto och kontroller', async () => {
  const w = await world(spain());
  const pre = await w.call('bulk_update_transactions', { ids: [30, 32, 33, 404], changes: { category: 'Resa', account: 'AMEX' } });
  assert.deepEqual(pre.not_found, [33, 404], 'annan användares id räknas som saknat');
  assert.equal(pre.would_update, 2); // 30: kategori+konto, 32: bara konto
  assert.deepEqual(pre.changes.find((x) => x.id === 32).after, { account: 'AMEX' });
  const r = await w.call('bulk_update_transactions', { ids: [30, 32, 33, 404], changes: { category: 'Resa', account: 'AMEX' }, dry_run: false, expected_count: 2 });
  assert.equal(r.updated, 2); assert.equal(w.txRow(32).account, 'amex');
  // Typbyte kräver en kategori som finns för den nya typen
  assert.match((await w.call('bulk_update_transactions', { ids: [30], changes: { type: 'savings' } })).err, /1 rader skulle få en kategori som inte finns för sin typ: 30 \(sparande "Resa"\)/);
  assert.equal((await w.call('bulk_update_transactions', { ids: [30], changes: { type: 'savings', category: 'Avanza' } })).would_update, 1);
  assert.match((await w.call('bulk_update_transactions', { ids: [30], filter: { month: '2026-07' }, changes: { category: 'Resa' } })).err, /antingen ids eller filter/);
  assert.match((await w.call('bulk_update_transactions', { filter: {}, changes: { category: 'Resa' } })).err, /filter får inte vara tomt/);
  assert.match((await w.call('bulk_update_transactions', { ids: [30], changes: {} })).err, /changes är tomt/);
  assert.match((await w.call('bulk_update_transactions', { ids: [30], changes: { account: 'Nordea' } })).err, /Okänt konto "Nordea"/);
  assert.match((await w.call('bulk_update_transactions', { ids: [30], changes: { amount: 5 } })).err, /okänt fält "amount"/);
});

test('update_transaction med dry_run skriver inget och visar allt', async () => {
  const w = await world({ user_state: [{ user_id: U, key: 'merchant_rules', value: { 'ica nara|ut': { type: 'expense', cat: 'Mat (Butik)', t: 1 } }, deleted: false }] });
  const pre = await w.noWrites(() => w.call('update_transaction', { id: 2, category: 'Mat (Ute)', apply_to_same_merchant: true, dry_run: true }));
  assert.deepEqual(pre.would_update, { id: 2, before: { category: 'Mat (Butik)' }, after: { category: 'Mat (Ute)' } });
  assert.deepEqual(pre.would_learn_rule.before.category, 'Mat (Butik)'); assert.deepEqual(pre.would_learn_rule.after, { type: 'expense', category: 'Mat (Ute)' });
  assert.deepEqual(pre.would_also_update.map((x) => x.id), [3]);
  // Utan dry_run: samma resultat som förut
  const r = await w.call('update_transaction', { id: 2, category: 'Mat (Ute)', apply_to_same_merchant: true });
  assert.equal(r.also_updated, 1); assert.equal(w.txRow(3).category, 'Mat (Ute)');
});
