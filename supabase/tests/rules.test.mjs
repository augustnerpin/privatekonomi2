// Punkt 6: inlärda regler
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, tx, U, OTHER, R } from './helpers.mjs';

const rules = () => ({
  user_state: [
    { user_id: U, key: 'merchant_rules', value: {
      'ica nara|ut': { type: 'expense', cat: 'Mat (Butik)', t: 1700000000000 },
      '#51960273264|ut': { type: 'transfer', cat: 'Egen överföring', t: 1700000000000 },
      'gammal|ut': { type: 'expense', cat: 'Spanien', t: 1 },
    }, deleted: false },
    { user_id: OTHER, key: 'merchant_rules', value: { 'hemlig|ut': { type: 'expense', cat: 'Gym', t: 1 } }, deleted: false },
  ],
  transactions: [
    tx(40, U, 'transfer', -2000, 'Egen överföring', '2026-09-02', '2026-09', { d: '51960273264', mkey: '#51960273264|ut' }),
    tx(41, U, 'transfer', -2500, 'Egen överföring', '2026-09-12', '2026-09', { d: '51960273264', mkey: '#51960273264|ut' }),
  ],
});

test('list_rules visar mönster, riktning, träffar och om regeln är aktiv', async () => {
  const w = await world(rules());
  const l = await w.call('list_rules', {}, R);
  assert.equal(l.count, 3); assert.equal(l.inactive, 1);
  const k = l.rules.find((r) => r.id === '#51960273264|ut');
  assert.deepEqual([k.pattern, k.direction, k.type, k.category, k.hits, k.active], ['#51960273264', 'ut', 'transfer', 'Egen överföring', 2, true]);
  assert.ok(k.updated.startsWith('2023-11-14'));
  assert.equal(l.rules.find((r) => r.id === 'ica nara|ut').hits, 2);
  assert.equal(l.rules.find((r) => r.id === 'gammal|ut').active, false, 'Spanien finns inte som utgiftskategori');
  assert.ok(!JSON.stringify(l).includes('hemlig'));
  assert.equal((await w.call('list_rules', { search: 'ica' })).count, 1);
  assert.equal((await w.call('list_rules', { type: 'transfer' })).count, 1);
});

test('update_transaction returnerar regel-id och kan ångras direkt', async () => {
  const w = await world(rules());
  const r = await w.call('update_transaction', { id: 40, type: 'savings', category: 'SEB' });
  assert.equal(r.learned_rule, '#51960273264|ut'); assert.equal(r.rule_id, '#51960273264|ut');
  assert.equal(r.previous_rule.category, 'Egen överföring');
  assert.deepEqual(r.undo, { tool: 'update_rule', arguments: { id: '#51960273264|ut', type: 'transfer', category: 'Egen överföring' } });
  assert.equal(w.state('merchant_rules')['#51960273264|ut'].cat, 'SEB');
  await w.call(r.undo.tool, r.undo.arguments);
  assert.deepEqual(w.state('merchant_rules')['#51960273264|ut'].cat, 'Egen överföring');
  // Ny butik utan regel: ångra = ta bort
  const n = await w.call('update_transaction', { id: 3, category: 'Mat (Ute)' });
  assert.equal(n.previous_rule.category, 'Mat (Butik)');
  const fresh = await world({ transactions: [tx(60, U, 'expense', 99, 'Övrigt', '2026-09-02', '2026-09', { d: 'NY BUTIK', mkey: 'ny butik|ut' })] });
  const f = await fresh.call('update_transaction', { id: 60, category: 'Gym' });
  assert.equal(f.previous_rule, null); assert.deepEqual(f.undo, { tool: 'delete_rule', arguments: { id: 'ny butik|ut' } });
  assert.ok(fresh.state('merchant_rules')['ny butik|ut'].created, 'ny regel får created');
});

test('update_rule och delete_rule', async () => {
  const w = await world(rules());
  const pre = await w.noWrites(() => w.call('update_rule', { id: '#51960273264', type: 'savings', category: 'SEB', apply_to_existing: true, dry_run: true }));
  assert.equal(pre.rule_id, '#51960273264|ut', 'mönster utan riktning godtas när det är entydigt');
  assert.deepEqual(pre.transactions.map((t) => t.id), [40, 41]);
  const up = await w.call('update_rule', { id: '#51960273264|ut', type: 'savings', category: 'SEB', apply_to_existing: true });
  assert.equal(up.updated_transactions, 2); assert.equal(w.txRow(41).type, 'savings'); assert.equal(w.txRow(41).category, 'SEB');
  assert.match((await w.call('update_rule', { id: 'ica nara|ut', category: 'Finns inte' })).err, /Kategorin "Finns inte" finns inte för utgift/);
  assert.match((await w.call('update_rule', { id: 'ica nara|ut', type: 'income' })).err, /Ange även category/);
  assert.match((await w.call('update_rule', { id: 'hemlig|ut', category: 'Gym' })).err, /Hittar ingen regel/);
  const del = await w.call('delete_rule', { id: 'ica nara|ut' });
  assert.equal(w.state('merchant_rules')['ica nara|ut'], undefined);
  assert.equal(w.txRow(2).category, 'Mat (Butik)', 'transaktioner rörs inte');
  assert.equal((await w.call(del.undo.tool, del.undo.arguments)).created, true);
  assert.equal(w.state('merchant_rules')['ica nara|ut'].cat, 'Mat (Butik)');
  assert.match((await w.call('delete_rule', { id: 'hemlig|ut' })).err, /Hittar ingen regel/);
  assert.equal(w.state('merchant_rules', OTHER)['hemlig|ut'].cat, 'Gym');
  assert.match((await w.call('update_rule', { id: 'x', type: 'expense', category: 'Gym' })).err, /mönster\|ut/);
});
