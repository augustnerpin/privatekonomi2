// Punkt 2: konton och saldohistorik
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, U, OTHER, R } from './helpers.mjs';

const withAccounts = () => ({ user_state: [
  { user_id: U, key: 'accounts', value: [{ id: 'lonekonto', name: 'Lönekonto', kind: 'bank', balance: { value: 12000, date: '2026-09-20' } }, { id: 'amex', name: 'AMEX', kind: 'card' }], deleted: false },
] , account_balances: [{ user_id: OTHER, account: 'lonekonto', bal_date: '2026-09-25', value: 999999, deleted: false }] });

test('skapa och ändra konton med nya typer', async () => {
  const w = await world(withAccounts());
  const sav = await w.call('set_account', { name: 'SEB sparkonto', kind: 'savings', number: '53293380441' });
  assert.equal(sav.created, true); assert.equal(sav.account.kind, 'savings');
  const inv = await w.call('set_account', { name: 'Avanza', kind: 'investment' });
  const accs = w.state('accounts');
  assert.equal(accs.length, 4); assert.equal(accs[0].balance.value, 12000, 'befintliga fält behålls');
  assert.equal((await w.call('set_account', { account: 'avanza', name: 'Avanza ISK' })).account.name, 'Avanza ISK');
  assert.match((await w.call('set_account', { account: inv.account.id, name: 'lönekonto' })).err, /finns redan/);
  assert.match((await w.call('set_account', { name: 'X' })).err, /name och kind/);
  assert.match((await w.call('set_account', { kind: 'crypto', name: 'X' })).err, /kind: ska vara en av bank, card, savings, investment/);
  assert.match((await w.call('set_account', { account: 'Finns ej', kind: 'bank' })).err, /Okänt konto "Finns ej". Finns: Lönekonto/);
  const st = await w.call('get_settings', {}, R);
  assert.deepEqual(st.accounts.map((a) => a.kind), ['bank', 'card', 'savings', 'investment']);
  assert.equal(st.accounts.find((a) => a.name === 'SEB sparkonto').number, '53293380441');
});

test('saldohistorik och senaste saldo', async () => {
  const w = await world(withAccounts());
  await w.call('set_account', { name: 'SEB sparkonto', kind: 'savings' });
  await w.call('set_account_balance', { account: 'SEB sparkonto', date: '2026-07-31', value: 50000 });
  await w.call('set_account_balance', { account: 'SEB sparkonto', date: '2026-08-31', value: 55000 });
  const old = await w.call('set_account_balance', { account: 'SEB sparkonto', date: '2026-08-15', value: 52000 });
  assert.equal(old.is_latest, false, 'ett äldre datum ändrar inte det aktuella saldot');
  await w.call('set_account_balance', { account: 'SEB sparkonto', date: '2026-08-31', value: 55500 }); // samma datum skrivs över
  const lk = await w.call('set_account_balance', { account: 'lonekonto', date: '2026-09-10', value: 8000 });
  assert.equal(lk.is_latest, false, 'appens saldo 2026-09-20 är nyare');
  const all = await w.call('get_account_balances', {}, R);
  const sav = all.accounts.find((a) => a.name === 'SEB sparkonto');
  assert.deepEqual(sav.history.map((h) => [h.date, h.value]), [['2026-07-31', 50000], ['2026-08-15', 52000], ['2026-08-31', 55500]]);
  assert.deepEqual(sav.balance, { value: 55500, date: '2026-08-31' });
  const lon = all.accounts.find((a) => a.id === 'lonekonto');
  assert.deepEqual(lon.history.map((h) => [h.date, h.value, h.source]), [['2026-09-10', 8000, 'mcp'], ['2026-09-20', 12000, 'app']]);
  assert.ok(!JSON.stringify(all).includes('999999'), 'annan användares saldo syns inte');
  const one = await w.call('get_account_balances', { account: 'SEB sparkonto', date_from: '2026-08-01' });
  assert.equal(one.accounts.length, 1); assert.equal(one.accounts[0].history.length, 2);
  const st = await w.call('get_settings');
  assert.deepEqual(st.accounts.find((a) => a.name === 'SEB sparkonto').balance, { value: 55500, date: '2026-08-31' });
  assert.deepEqual(w.state('accounts').find((a) => a.name === 'SEB sparkonto').balance, { value: 55500, date: '2026-08-31' }, 'appen får senaste saldot');
});

test('före migreringen: tydligt fel för skrivning, läsning fungerar', async () => {
  const w = await world(withAccounts(), { missing: ['account_balances'] });
  assert.match((await w.call('set_account_balance', { account: 'lonekonto', value: 1 })).err, /kör supabase\/schema.sql igen/);
  const st = await w.call('get_settings');
  assert.deepEqual(st.accounts[0].balance, { value: 12000, date: '2026-09-20' });
  assert.match((await w.call('get_account_balances')).note, /schema.sql/);
});
