// Punkt 4: lån och skulder i förmögenheten
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, U, OTHER, R } from './helpers.mjs';

const snaps = () => ({ net_worth_snapshots: [
  { user_id: U, period: '2026-07', total: 1590000, amounts: { cash: 90000, apt: 1500000 }, deleted: false },
  { user_id: U, period: '2026-09', total: 1610000, amounts: { cash: 110000, apt: 1500000 }, deleted: false },
], loans: [{ user_id: OTHER, id: 'loan_x', name: 'Hemligt lån', netted_in_assets: false, deleted: false }],
   loan_balances: [{ user_id: OTHER, loan_id: 'loan_x', bal_date: '2026-01-01', value: 777777, deleted: false }] });

async function setupLoans(w) {
  const bo = await w.call('set_loan', { name: 'Bolån', lender: 'SEB', reference: '5329 33 15887', interest_pct: 3.6, amortization: 4530, secured_by: 'Lägenhet', netted_in_assets: true, balance: 2010000, balance_date: '2026-07-31' });
  await w.call('set_loan_balance', { loan: '53293315887', date: '2026-08-31', value: 2005470 });
  await w.call('set_loan_balance', { loan: 'bolån', date: '2026-09-30', value: 2000940 });
  await w.call('set_loan', { name: 'Billån', lender: 'Santander', balance: 100000, balance_date: '2026-08-15' });
  return bo;
}

test('skapa lån, skuldhistorik och uppslag', async () => {
  const w = await world(snaps());
  const bo = await setupLoans(w);
  assert.equal(bo.created, true); assert.deepEqual(bo.loan.secured_by, { key: 'apt', label: 'Lägenhet' });
  assert.equal(bo.loan.interest_monthly_estimate, 6030);
  const gl = await w.call('get_loans', { include_history: true }, R);
  assert.deepEqual(gl.loans.map((l) => l.name), ['Billån', 'Bolån']);
  const b = gl.loans[1];
  assert.deepEqual(b.balance, { value: 2000940, date: '2026-09-30' }); assert.equal(b.history.length, 3);
  assert.equal(gl.total_debt, 2100940); assert.equal(gl.total_amortization_monthly, 4530);
  assert.ok(!JSON.stringify(gl).includes('Hemligt'), 'annan användares lån syns inte');
  // Ändra, fel och ägarkontroll
  assert.equal((await w.call('set_loan', { loan: 'Bolån', interest_pct: 3.2 })).loan.interest_pct, 3.2);
  assert.equal(w.tables.loans.find((l) => l.name === 'Bolån').lender, 'SEB', 'fält som inte anges behålls');
  assert.match((await w.call('set_loan', { loan: 'Hemligt lån', interest_pct: 1 })).err, /Okänt lån "Hemligt lån". Finns: Billån, Bolån/);
  assert.match((await w.call('set_loan_balance', { loan: 'loan_x', value: 1 })).err, /Okänt lån/);
  assert.match((await w.call('set_loan', { name: 'bolån' })).err, /finns redan/);
  assert.match((await w.call('set_loan', { loan: 'Bolån', secured_by: 'Båt' })).err, /Okänd förmögenhetskategori "Båt"/);
  assert.match((await w.call('set_loan_balance', { loan: 'Bolån', value: -5 })).err, /minst 0/);
  const chg = await w.call('set_loan_balance', { loan: 'Bolån', date: '2026-10-31', value: 1996410 });
  assert.equal(chg.change_since_previous, -4530);
});

test('get_net_worth: tillgångar, skulder och netto när Lägenhet är netto', async () => {
  const w = await world(snaps());
  await setupLoans(w);
  const nw = await w.call('get_net_worth', {}, R);
  const [jul, sep] = nw.snapshots.filter((s) => s.period !== '2026-08');
  // Skulden när perioden börjar. Juli (25/6): bolånets första saldo är 31/7, så skulden räknas bakåt med två
  // amorteringar (30/6, 31/7); billånet (ingen amortering) finns inte än. Bolånet är redan avdraget i Lägenhet.
  assert.deepEqual([jul.assets, jul.liabilities, jul.liabilities_already_in_assets, jul.net, jul.gross_assets], [1590000, 2019060, 2019060, 1590000, 3609060]);
  assert.equal(jul.liabilities_estimated, true);
  // September (25/8): bolånet 2 010 000 (31/7), billånet 100 000 (15/8, inte avdraget någonstans) dras av.
  assert.deepEqual([sep.assets, sep.liabilities, sep.net, sep.gross_assets], [1610000, 2110000, 1510000, 3620000]);
  assert.deepEqual(sep.liabilities_by_loan, { Billån: 100000, Bolån: 2010000 });
  assert.equal(sep.total, 1610000, 'total är oförändrad (som i appen)');
  assert.equal(nw.latest.net, 1510000); assert.equal(nw.latest.total, 1610000);
  assert.match(nw.explanation, /dras inte av igen/);
  assert.ok(!JSON.stringify(nw).includes('777777'));
});

test('utan lån eller före migreringen: get_net_worth som förut', async () => {
  const w = await world(snaps());
  const nw = await w.call('get_net_worth');
  assert.equal(nw.snapshots[0].net, undefined); assert.equal(nw.loans, undefined);
  const old = await world({}, { missing: ['loans', 'loan_balances'] });
  const nw2 = await old.call('get_net_worth');
  assert.equal(nw2.latest.total, 100000); assert.match(nw2.loans_note, /schema.sql/);
  assert.match((await old.call('set_loan', { name: 'Bolån' })).err, /kör supabase\/schema.sql igen/);
  assert.match((await old.call('get_loans')).note, /schema.sql/);
});
