// Punkt 8: namn på Swish-mottagare
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, tx, U, OTHER, R } from './helpers.mjs';

const setup = () => ({ transactions: [
  tx(80, U, 'expense', 150, 'Swish (privat)', '2026-09-02', '2026-09', { d: '46709876543', mkey: '#46709876543|ut' }),
  tx(81, U, 'expense', 250, 'Swish (privat)', '2026-09-09', '2026-09', { d: '46709876543', mkey: '#46709876543|ut' }),
  tx(82, U, 'income', 400, 'Övrigt', '2026-09-10', '2026-09', { d: '46709876543' }),
  tx(83, U, 'transfer', -5000, 'Egen överföring', '2026-09-03', '2026-09', { d: '51960273264' }),
  tx(84, OTHER, 'expense', 1, 'Swish (privat)', '2026-09-03', '2026-09', { d: '0705555555' }),
] });

test('set_contact sparar i transaktionernas format och syns i list/summarize/sökning', async () => {
  const w = await world(setup());
  const r = await w.call('set_contact', { phone: '070-987 65 43', name: 'Erik' });
  assert.deepEqual(r, { number: '46709876543', name: 'Erik', kind: 'mobil', matched_transactions: 3 });
  assert.equal(w.state('contact_names')['46709876543'], 'Erik'); assert.equal(w.state('contact_names')['0709876543'], undefined);
  const lt = await w.call('list_transactions', { search: 'erik' }, R);
  assert.equal(lt.count, 3);
  assert.deepEqual([lt.transactions[0].contact, lt.transactions[0].number, lt.transactions[0].description], ['Erik', '46709876543', '46709876543']);
  const sm = await w.call('summarize_transactions', { group_by: 'merchant', month: '2026-09' });
  const g = sm.groups.find((x) => x.key === 'Erik');
  assert.deepEqual([g.sum, g.count, g.number], [400, 2, '46709876543']);
  assert.equal((await w.call('list_transactions', { search: '0701234567' })).transactions[0].contact, 'Anna', 'befintligt namn fungerar som förut');
});

test('list_contacts med summor och namnlösa nummer', async () => {
  const w = await world(setup());
  const before = await w.call('list_contacts', {}, R);
  assert.deepEqual(before.contacts, [{ number: '0701234567', name: 'Anna', kind: 'mobil', transactions: 1, total_out: 450, total_in: 0 }]);
  assert.deepEqual(before.unnamed.map((u) => [u.number, u.kind, u.transactions, u.total_out, u.total_in]), [['46709876543', 'mobil', 3, 400, 400], ['51960273264', 'konto', 1, 5000, 0]]);
  assert.ok(!JSON.stringify(before).includes('0705555555'), 'annan användares nummer syns inte');
  await w.call('set_contact', { phone: '5196 0273264', name: 'Sparkonto Nordea' });
  const after = await w.call('list_contacts');
  assert.equal(after.count, 2); assert.equal(after.unnamed.length, 1);
  assert.equal(after.contacts.find((x) => x.number === '51960273264').kind, 'konto');
});

test('byta, ta bort och fel', async () => {
  const w = await world(setup());
  await w.call('set_contact', { phone: '46709876543', name: 'Erik' });
  await w.call('set_contact', { phone: '0709876543', name: 'Erik S' });
  assert.deepEqual(w.state('contact_names'), { '0701234567': 'Anna', '46709876543': 'Erik S' });
  const rm = await w.call('set_contact', { phone: '+46 70 987 65 43', name: '' });
  assert.deepEqual(rm.removed, ['46709876543']); assert.equal(w.state('contact_names')['46709876543'], undefined);
  assert.equal((await w.call('set_contact', { phone: '0761112233', name: 'Ny' })).matched_transactions, 0);
  assert.equal(w.state('contact_names')['0761112233'], 'Ny', 'utan transaktioner sparas numret som angivet');
  assert.match((await w.call('set_contact', { phone: 'abc', name: 'X' })).err, /ser inte ut som ett telefon- eller kontonummer/);
  assert.match((await w.call('set_contact', { phone: '0701234567', name: 'X' }, R)).err, /bara läsa/);
  assert.equal(w.state('contact_names', OTHER), undefined);
});
