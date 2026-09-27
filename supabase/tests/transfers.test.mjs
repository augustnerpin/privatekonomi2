// Punkt 3: överföringar med båda sidor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, tx, U, OTHER, R } from './helpers.mjs';

const T = (id, amount, account, date, uid = U) => tx(id, uid, 'transfer', amount, 'Egen överföring', date, '2026-09', { account, d: 'Överföring' });
const setup = () => ({
  user_state: [{ user_id: U, key: 'accounts', value: [{ id: 'lonekonto', name: 'Lönekonto', kind: 'bank' }, { id: 'amex', name: 'AMEX', kind: 'card' }, { id: 'sav', name: 'SEB sparkonto', kind: 'savings', number: '5329 33 80441' }], deleted: false }],
  transactions: [
    T(10, -5000, 'lonekonto', '2026-09-01'), T(11, 5000, 'sav', '2026-09-03'),          // tydligt par
    T(12, -2000, 'lonekonto', '2026-09-05'), T(13, 2000, 'sav', '2026-09-06'), T(14, 2000, 'amex', '2026-09-06'), // tvetydigt
    T(15, -700, 'lonekonto', '2026-09-10'), T(16, 700, 'sav', '2026-09-14'),            // 4 dagar isär
    T(17, -900, 'lonekonto', '2026-09-11'), T(18, 900, 'lonekonto', '2026-09-11'),      // samma konto
    T(19, -300, 'lonekonto', '2026-09-12'),                                              // motpart saknas
    T(20, 300, 'sav', '2026-09-12', OTHER),                                              // annan användare
  ],
});

test('from/to i list_transactions, add och update', async () => {
  const w = await world(setup());
  const lt = await w.call('list_transactions', { type: 'transfer', month: '2026-09' }, R);
  const t10 = lt.transactions.find((t) => t.id === 10), t11 = lt.transactions.find((t) => t.id === 11);
  assert.equal(t10.from_account, 'Lönekonto'); assert.equal(t10.to_account, null);
  assert.equal(t11.to_account, 'SEB sparkonto'); assert.equal(t11.from_account, null);
  assert.equal(lt.transactions.find((t) => t.id === 5).from_account, 'Lönekonto', 'befintliga överföringar får from från tecknet');
  assert.ok(!('from_account' in (await w.call('list_transactions', { type: 'expense', limit: 1 })).transactions[0]), 'bara överföringar får fälten');
  const add = await w.call('add_transaction', { amount: -1000, type: 'transfer', category: 'Egen överföring', date: '2026-09-15', to_account: '53293380441' });
  assert.equal(add.created.from_account, 'Lönekonto'); assert.equal(add.created.to_account, 'SEB sparkonto', 'kontonummer matchar kontot');
  assert.equal(w.txRow(add.created.id).extra.to_account, 'sav');
  const ext = await w.call('add_transaction', { amount: -500, type: 'transfer', category: 'Egen överföring', to_account: 'Nordnet 1234' });
  assert.equal(ext.created.to_account, 'Nordnet 1234', 'konto utanför appen sparas som fritext');
  assert.match((await w.call('add_transaction', { amount: 5, type: 'expense', category: 'Gym', to_account: 'sav' })).err, /bara överföringar/);
  await w.call('update_transaction', { id: 19, to_account: 'Nordnet 1234' });
  assert.equal(w.txRow(19).extra.to_account, 'Nordnet 1234');
  await w.call('update_transaction', { id: 19, to_account: '' });
  assert.equal(w.txRow(19).extra.to_account, undefined);
});

test('match_transfers föreslår utan att skriva, länkar med confirm', async () => {
  const w = await world(setup());
  const pre = await w.noWrites(() => w.call('match_transfers', { month: '2026-09' }));
  assert.equal(pre.dry_run, true);
  assert.deepEqual(pre.pairs.map((p) => [p.from.id, p.to.id, p.days_apart]), [[10, 11, 2]]);
  assert.equal(pre.ambiguous.length, 1); assert.equal(pre.ambiguous[0].out.id, 12);
  assert.deepEqual(pre.ambiguous[0].candidates.map((c) => c.id).sort(), [13, 14]);
  assert.deepEqual(pre.unmatched.examples.map((u) => u.id).sort((a, b) => a - b), [5, 15, 16, 17, 18, 19]);
  assert.ok(!JSON.stringify(pre).includes('"id":20'), 'annan användares rad används aldrig');
  const done = await w.call('match_transfers', { month: '2026-09', confirm: true });
  assert.equal(done.linked, 1);
  assert.deepEqual([w.txRow(10).extra.transfer_pair_id, w.txRow(11).extra.transfer_pair_id], [11, 10]);
  assert.deepEqual([w.txRow(11).extra.from_account, w.txRow(11).extra.to_account], ['lonekonto', 'sav']);
  const lt = await w.call('list_transactions', { type: 'transfer', month: '2026-09' });
  const t11 = lt.transactions.find((t) => t.id === 11);
  assert.equal(t11.pair_id, 10); assert.equal(t11.from_account, 'Lönekonto'); assert.equal(t11.to_account, 'SEB sparkonto');
  // Andra körningen hittar inget nytt, och summeringarna är oförändrade
  assert.equal((await w.call('match_transfers', { month: '2026-09' })).pairs.length, 0);
  // Tvetydigt par väljs manuellt
  assert.match((await w.call('match_transfers', { link: [{ out_id: 12, in_id: 14 }] })).err, /kräver confirm/);
  assert.match((await w.call('match_transfers', { confirm: true, link: [{ out_id: 17, in_id: 18 }] })).err, /passar inte ihop/);
  assert.match((await w.call('match_transfers', { confirm: true, link: [{ out_id: 10, in_id: 13 }] })).err, /10 är redan länkad/);
  assert.equal((await w.call('match_transfers', { confirm: true, link: [{ out_id: 12, in_id: 14 }] })).linked, 1);
  assert.equal(w.txRow(14).extra.transfer_pair_id, 12); assert.equal(w.txRow(13).extra.transfer_pair_id, undefined);
});

test('länk tas bort när en sida byter typ eller delas upp', async () => {
  const w = await world(setup());
  await w.call('match_transfers', { confirm: true });
  await w.call('update_transaction', { id: 11, type: 'savings', category: 'SEB' });
  assert.equal(w.txRow(11).extra.transfer_pair_id, undefined); assert.equal(w.txRow(10).extra.transfer_pair_id, undefined);
  assert.equal(w.txRow(11).extra.from_account, undefined);
});
