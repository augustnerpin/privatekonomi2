// Avanza-import och investeringsvy (functions/_shared/avanza.ts, MCP-verktygen och autogiro-notisen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { world, U } from './helpers.mjs';
import { investView, normalizeSnapshot, sumCheck, autogiroExpected, validateSnapshot } from '../functions/_shared/avanza.ts';
import { missingExpected, buildDigest } from '../functions/bank/notify.ts';
import { addBankDays } from '../functions/_shared/finance.ts';

// Sammanställningen 2026-09-29: totalt 177 731 kr, sju konton (ett dolt), 10 000 kr reserverat
const SNAP = {
  date: '2026-09-29T08:15:00+02:00', total_value: 177731,
  accounts: [
    { name: 'Fondkonto', type: 'ISK', value: 60000, cash: 10500, reserved_cash: 10000, since_purchase_kr: 8000, ytd_pct: 6.2, hidden: false },
    { name: 'Aktiekonto', type: 'ISK', value: 45000, cash: 500, reserved_cash: 0, since_purchase_kr: 5200, ytd_pct: 11.4, hidden: false },
    { name: 'Utökat lån ISK', type: 'ISK', value: 40231, cash: 500, reserved_cash: 0, since_purchase_kr: 1850, ytd_pct: 3.1, hidden: false },
    { name: 'Utökat lån sparkonto', type: 'sparkonto', value: 20000, cash: 20000, reserved_cash: 0, since_purchase_kr: 150, ytd_pct: null, hidden: false },
    { name: 'Avanza sparkonto', type: 'sparkonto', value: 10000, cash: 10000, reserved_cash: 0, since_purchase_kr: null, ytd_pct: null, hidden: false },
    { name: 'Depå', type: 'depå', value: 2500, cash: 0, reserved_cash: 0, since_purchase_kr: -300, ytd_pct: -4, hidden: false },
    { name: 'Gammal KF', type: 'KF', value: 1200, cash: 1200, reserved_cash: 0, since_purchase_kr: 0, ytd_pct: 0, hidden: true },
  ],
  holdings: [
    { account: 'Fondkonto', name: 'Avanza Global', kind: 'fond', quantity: 180, value: 30000, gain_kr: 5000, gain_pct: 20 },
    { account: 'Fondkonto', name: 'Spiltan Aktiefond Investmentbolag', kind: 'fond', quantity: 40, value: 19500, gain_kr: 3000, gain_pct: 18 },
    { account: 'Aktiekonto', name: 'Alibaba', kind: 'aktie', quantity: 250, value: 34658, gain_kr: 4200, gain_pct: 13.8 },
    { account: 'Aktiekonto', name: 'Investor B', kind: 'aktie', quantity: 30, value: 9842, gain_kr: 1000, gain_pct: 11.3 },
    { account: 'Utökat lån ISK', name: 'XACT OMXS30', kind: 'ETF', quantity: 90, value: 30000, gain_kr: 1500, gain_pct: 5.3 },
    { account: 'Utökat lån ISK', name: 'Länsförsäkringar Global Index', kind: 'fond', quantity: 20, value: 9731, gain_kr: 350, gain_pct: 3.7 },
    { account: 'Depå', name: 'Ericsson B', kind: 'aktie', quantity: 30, value: 2500, gain_kr: -300, gain_pct: -10.7 },
  ],
  monthly_savings: [
    { day: 25, amount: 10000, from: 'bank', to_account: 'Fondkonto' },
    { day: 27, amount: 5000, from: 'Avanza sparkonto', to_account: 'Utökat lån ISK' },
  ],
  dividends: { paid_total: 3400, pending: 0, ytd: 1100 },
  pending_orders: [{ account: 'Fondkonto', name: 'Avanza Global', amount: 10000, expected_date: '2026-09-30' }],
};
const clone = (x) => structuredClone(x);
const ACCOUNTS = [
  { id: 'lonekonto', name: 'Lönekonto', kind: 'bank', nw_cat: 'cash', balance: { date: '2026-09-28', value: 8446.22 } },
  { id: 'avanza_isk', name: 'Avanza ISK', kind: 'investment', nw_cat: 'stocks', sav_cat: 'Avanza', manual: true, balance: { date: '2026-09-28', value: 168000 } },
  { id: 'klarna', name: 'Klarna', kind: 'savings', nw_cat: 'cash', sav_cat: 'Klarna', manual: true, balance: { date: '2026-09-29', value: 190300 } },
];
const SETTINGS = { concentration_pct: 15, interest_deduction_pct: 30, funded_by_loan: ['Utökat lån ISK', 'Utökat lån sparkonto'], autogiro_grace_bank_days: 3,
  leverage: { since: '2026-06-25' }, isk: { tax_pct: 30, extra_pct: 1, min_pct: 1.25, years: { 2026: { gov_rate_pct: 2.55, tax_free: 300000 } } } };
const LOANS = [['L1', 648491], ['L2', 650300], ['L3', 213605]].map(([id, v]) => ({ user_id: U, id, name: id, interest_pct: 2.76, secured_by: 'apt', amortization: 1000, deleted: false, _v: v }));
async function setup(extra = {}, opts) {
  const w = await world({
    user_state: [
      { user_id: U, key: 'accounts', value: clone(ACCOUNTS), deleted: false },
      { user_id: U, key: 'invest_settings', value: clone(SETTINGS), deleted: false },
      { user_id: U, key: 'expected_tx', value: [{ id: 'exp_avanza', name: 'Sparande till Avanza', type: 'savings', cat: 'Avanza', days: 5, enabled: true }], deleted: false },
    ],
    account_balances: [{ user_id: U, account: 'avanza_isk', bal_date: '2026-09-28', value: 168000, source: 'manual', deleted: false }],
    loans: LOANS.map(({ _v, ...l }) => l),
    loan_balances: LOANS.map((l) => ({ user_id: U, loan_id: l.id, bal_date: '2026-09-28', value: l._v, deleted: false })),
    avanza_snapshots: [], backups: [],
    ...extra,
  }, opts);
  return w;
}

test('import 2026-09-29: dry_run är standard, förhandsgranskningen visar 177 731 kr och godkänd summakontroll, inget sparas', async () => {
  const w = await setup();
  const r = await w.noWrites(() => w.call('import_avanza_snapshot', { snapshot: clone(SNAP) }));
  assert.equal(r.saved, false); assert.equal(r.dry_run, true);
  assert.equal(r.preview.total_value, 177731); assert.equal(r.preview.balance_to_set, 177731);
  assert.equal(r.preview.sum_check.ok, true); assert.equal(r.preview.sum_check.diff, 0);
  assert.deepEqual(r.preview.current_balance, { value: 168000, date: '2026-09-28' });
  assert.ok(r.changes.some((c) => c.what === 'balance' && c.to === 177731));
  assert.deepEqual(r.changes.find((c) => c.what === 'expected_tx').added, ['Autogiro 10 000 kr till Fondkonto']);
  assert.match(r.preview.internal_savings_ignored[0], /intern flytt/);
  assert.ok(r.preview.warnings.some((x) => x.kind === 'concentration' && x.name === 'Alibaba' && x.share_pct === 19.5));
  assert.equal(w.tables.avanza_snapshots?.length || 0, 0);
});

test('import med dry_run: false sparar bilden, sätter Avanza ISK till 177 731 kr och gör autogirot till en förväntad transaktion', async () => {
  const w = await setup();
  const r = await w.call('import_avanza_snapshot', { snapshot: clone(SNAP), dry_run: false });
  assert.equal(r.saved, true);
  assert.equal(w.tables.avanza_snapshots.length, 1);
  assert.equal(w.tables.avanza_snapshots[0].snap_date, '2026-09-29');
  const bal = w.tables.account_balances.find((b) => b.account === 'avanza_isk' && b.bal_date === '2026-09-29');
  assert.deepEqual([bal.value, bal.source], [177731, 'import']);
  assert.deepEqual(w.state('accounts').find((a) => a.id === 'avanza_isk').balance, { value: 177731, date: '2026-09-29' });
  const ex = w.state('expected_tx');
  assert.equal(ex[0].id, 'exp_avanza'); // användarens egen post är kvar
  const ag = ex.filter((e) => e.source === 'avanza');
  assert.equal(ag.length, 1); // den interna flytten från Avanza sparkonto blir ingen förväntad banktransaktion
  assert.deepEqual([ag[0].name, ag[0].due_day, ag[0].amount, ag[0].grace_bank_days, ag[0].from_account], ['Autogiro 10 000 kr till Fondkonto', 25, 10000, 3, 'lonekonto']);
  // Backup av det som skrevs över
  assert.equal(w.tables.backups.length, 1); assert.equal(w.tables.backups[0].data.expected_tx.length, 1);
  // Ingen transaktion skapas av importen
  assert.equal(w.tables.transactions.length, 8);
});

test('en andra import av samma bild ändrar ingenting', async () => {
  const w = await setup();
  await w.call('import_avanza_snapshot', { snapshot: clone(SNAP), dry_run: false });
  const again = await w.noWrites(() => w.call('import_avanza_snapshot', { snapshot: clone(SNAP), dry_run: false }));
  assert.deepEqual([again.saved, again.duplicate, again.changed, again.changes.length], [false, true, false, 0]);
  // Samma innehåll i annan ordning och formatering är samma bild
  const shuffled = clone(SNAP); shuffled.accounts.reverse(); shuffled.holdings.reverse(); shuffled.accounts[0].value = 1200.0;
  assert.equal((await w.noWrites(() => w.call('import_avanza_snapshot', { snapshot: shuffled, dry_run: false }))).duplicate, true);
});

test('summan av kontona stämmer inte med totalvärdet: skillnaden visas och inget sparas', async () => {
  const w = await setup();
  const bad = clone(SNAP); bad.total_value = 177000;
  const r = await w.noWrites(() => w.call('import_avanza_snapshot', { snapshot: bad, dry_run: false }));
  assert.equal(r.saved, false); assert.equal(r.preview.sum_check.ok, false); assert.equal(r.preview.sum_check.diff, 731);
  assert.match(r.blocked, /skillnad \+731 kr\. Inget sparas/);
});

test('import kräver skrivbehörighet, och en bild som inte följer schemat avvisas', async () => {
  const w = await setup();
  const { R } = await import('./helpers.mjs');
  assert.match((await w.call('import_avanza_snapshot', { snapshot: clone(SNAP) }, R)).err, /bara läsa/);
  const bad = clone(SNAP); bad.accounts[0].type = 'Pension'; bad.holdings[0].account = 'Finns inte';
  assert.match((await w.call('import_avanza_snapshot', { snapshot: bad })).err, /ska vara en av ISK, KF, sparkonto, depå/);
  const bad2 = clone(SNAP); bad2.holdings[0].account = 'Finns inte';
  assert.match((await w.call('import_avanza_snapshot', { snapshot: bad2 })).err, /okänt konto "Finns inte"/);
  assert.deepEqual(validateSnapshot(clone(SNAP)), []);
});

test('5 000 kr från Avanza sparkonto till Utökat lån ISK ändrar varken sparande eller avkastning', async () => {
  const w = await setup({ net_worth_snapshots: [
    { user_id: U, period: '2026-09', total: 600000, amounts: { cash: 432000, stocks: 168000 }, deleted: false },
    { user_id: U, period: '2026-10', total: 609731, amounts: { cash: 432000, stocks: 177731 }, deleted: false },
  ] });
  await w.call('import_avanza_snapshot', { snapshot: clone(SNAP), dry_run: false });
  const before = await w.call('get_net_worth');
  const moved = clone(SNAP); moved.date = '2026-09-30T09:00:00+02:00';
  moved.accounts.find((a) => a.name === 'Avanza sparkonto').value -= 5000; moved.accounts.find((a) => a.name === 'Avanza sparkonto').cash -= 5000;
  moved.accounts.find((a) => a.name === 'Utökat lån ISK').value += 5000; moved.accounts.find((a) => a.name === 'Utökat lån ISK').cash += 5000;
  const txBefore = w.tables.transactions.length;
  const r = await w.call('import_avanza_snapshot', { snapshot: moved, dry_run: false });
  assert.equal(r.saved, true);
  const ch = r.preview.change_since_previous;
  assert.deepEqual([ch.value_change, ch.deposits, ch.return], [0, 0, 0]);
  assert.deepEqual(ch.by_account.map((x) => [x.name, x.change]), [['Avanza sparkonto', -5000], ['Utökat lån ISK', 5000]]);
  assert.equal(w.tables.account_balances.find((b) => b.account === 'avanza_isk' && b.bal_date === '2026-09-30').value, 177731);
  assert.equal(w.tables.transactions.length, txBefore);
  const after = await w.call('get_net_worth');
  for (const k of ['sparande', 'avkastning', 'change']) assert.equal(after.breakdown.total[k], before.breakdown.total[k], k);
});

test('autogiro 10 000 kr den 25:e utan dragning i banken ger en notis efter 3 bankdagar', () => {
  const ex = autogiroExpected(normalizeSnapshot(clone(SNAP)), [], { fromAccount: 'lonekonto' });
  const start = '2026-09-25'; // löneperioden 2026-10 börjar fredag 25/9
  assert.equal(addBankDays('2026-09-25', 3), '2026-09-30');
  assert.deepEqual(missingExpected(ex, [], '2026-09-30', start), []); // tredje bankdagen: inte ännu
  const miss = missingExpected(ex, [], '2026-10-01', start);
  assert.equal(miss.length, 1); assert.equal(miss[0].scheduled, '2026-09-25');
  // Dragningen syns i banken: ingen notis. Fel belopp eller annan mottagare räknas inte.
  const row = (o) => ({ type: 'savings', category: 'Avanza', amount: 10000, description: 'AVANZA BANK', tx_date: '2026-09-28', ...o });
  assert.deepEqual(missingExpected(ex, [row()], '2026-10-01', start), []);
  assert.equal(missingExpected(ex, [row({ amount: 5000 })], '2026-10-01', start).length, 1);
  assert.equal(missingExpected(ex, [row({ description: 'KLARNA BANK' })], '2026-10-01', start).length, 1);
  assert.deepEqual(missingExpected(ex, [row({ type: 'transfer', amount: -10000, category: 'Egen överföring' })], '2026-10-01', start), []);
  const d = buildDigest({ newRows: [], spent: {}, budgets: {}, period: { id: '2026-10', start, end: '2026-10-22' }, today: '2026-10-01', conns: [], sent: new Set(), missing: miss.map((e) => ({ ...e, from_name: 'Lönekonto', balance: 8446.22 })) });
  assert.equal(d.body, '⏰ Autogiro 10 000 kr till Fondkonto har inte dragits. Saldo på Lönekonto: 8 446 kr.');
  assert.deepEqual(d.keys, ['forvantad:avz_fondkonto_25:2026-10']);
  // Befintliga förväntade poster fungerar som förut
  assert.equal(missingExpected([{ id: 'x', name: 'X', type: 'savings', cat: 'Avanza', days: 5 }], [{ type: 'income', category: 'Lön', tx_date: '2026-09-25' }], '2026-09-30', start).length, 1);
});

test('en ny bild ersätter autogirona, behåller användarens poster och ett avstängt autogiro', () => {
  const s = normalizeSnapshot(clone(SNAP));
  const first = autogiroExpected(s, [{ id: 'mine', name: 'Egen', type: 'income' }]);
  first[1].enabled = false;
  const s2 = clone(s); s2.monthly_savings[0].amount = 12000;
  const next = autogiroExpected(s2, first);
  assert.deepEqual(next.map((e) => [e.id, e.name, e.enabled !== false]), [['mine', 'Egen', true], ['avz_fondkonto_25', 'Autogiro 12 000 kr till Fondkonto', false]]);
  assert.deepEqual(autogiroExpected({ ...s2, monthly_savings: [] }, next).map((e) => e.id), ['mine']);
});

test('get_investments: innehav, fördelning, topp 5, varning, utdelningar, hävstång, ISK-skatt och likviditet', async () => {
  const w = await setup();
  await w.call('import_avanza_snapshot', { snapshot: clone(SNAP), dry_run: false });
  const v = await w.call('get_investments');
  assert.equal(v.portfolio_value, 177731); // det dolda kontot räknas inte
  assert.deepEqual(v.top5.map((h) => [h.name, h.share_pct]), [['Alibaba', 19.5], ['Avanza Global', 16.88], ['XACT OMXS30', 16.88], ['Spiltan Aktiefond Investmentbolag', 10.97], ['Investor B', 5.54]]);
  assert.deepEqual(v.warnings.filter((x) => x.kind === 'concentration').map((x) => x.text), ['Alibaba är 19,5 % av portföljen (gräns 15 %)', 'Avanza Global är 16,9 % av portföljen (gräns 15 %)', 'XACT OMXS30 är 16,9 % av portföljen (gräns 15 %)']);
  const al = Object.fromEntries(v.allocation.map((x) => [x.key, x.value]));
  assert.deepEqual(al, { fond: 59231, aktie: 47000, ETF: 30000, reserverat: 10000, kontanter: 31500 });
  assert.equal(v.invested_capital, 177731 - 31500); // reserverade 10 000 kr räknas som investerat
  assert.equal(v.dividends.per_year[0].ytd, 1100);
  const lv = v.leverage;
  assert.deepEqual([lv.borrowed_capital, lv.return_kr, lv.interest_pct, lv.deduction_pct, lv.days], [58231, 2000, 2.76, 30, 96]);
  assert.equal(lv.cost_per_year_after_deduction, 1125.02); assert.equal(lv.cost_after_deduction, 295.9); assert.equal(lv.net, 1704.1);
  assert.equal(lv.text, 'Lånat kapital gav +2 000 kr, kostade −296 kr, netto +1 704 kr.');
  const t = v.isk_tax;
  assert.equal(t.schablon_pct, 3.55); assert.equal(t.tax_free, 300000); assert.equal(t.estimated, true); assert.match(t.note, /Uppskattning/);
  assert.equal(t.tax, 0); // under den skattefria nivån
  assert.equal(v.liquidity.available_now, 8446.22 + 190300 + 31500);
  // Gränsen går att ändra
  await w.call('set_investment_settings', { concentration_pct: 20 });
  assert.equal((await w.call('get_investments')).warnings.filter((x) => x.kind === 'concentration').length, 0);
  // get_net_worth tar med underkonton, lånat kapital och hävstångsnettot
  const nw = await w.call('get_net_worth');
  assert.equal(nw.avanza.balance_in_net_worth, 177731); assert.equal(nw.avanza.accounts.length, 7);
  assert.deepEqual([nw.avanza.borrowed_capital, nw.avanza.leverage_net], [58231, 1704.1]);
});

test('ISK-skatt: nivåerna kommer från inställningarna, och saknas de sägs det', () => {
  const s = normalizeSnapshot(clone(SNAP));
  const snaps = [{ snap_date: '2026-09-29', taken_at: '2026-09-29T06:15:00.000Z', data: s }];
  const v = investView({ snaps, settings: { isk: { tax_pct: 30, extra_pct: 1, min_pct: 1.25, years: { 2026: { gov_rate_pct: 2.55, tax_free: 50000 } } } } });
  // Kvartalen: 3 före bilden (saknar värden → senaste bilden), 1/10 prognos; plus 3 kvarvarande autogiron à 10 000 till Fondkonto
  assert.equal(v.isk_tax.deposits_planned, 30000);
  assert.equal(v.isk_tax.capital_base, (4 * (60000 + 45000 + 40231 + 1200) + 30000) / 4);
  assert.equal(v.isk_tax.tax, Math.round((v.isk_tax.capital_base - 50000) * 0.0355 * 0.3));
  const none = investView({ snaps, settings: { funded_by_loan: ['Utökat lån ISK'] } });
  assert.deepEqual(none.isk_tax.missing, ['isk.years.2026.gov_rate_pct', 'isk.years.2026.tax_free', 'isk.tax_pct', 'isk.extra_pct']);
  assert.match(none.leverage.notes.join(' '), /interest_deduction_pct|Ingen räntesats/);
});

test('dolda konton räknas med i saldot bara när användaren valt det', () => {
  const s = normalizeSnapshot(clone(SNAP));
  assert.equal(sumCheck(s).ok, true);
  const snaps = [{ snap_date: '2026-09-29', taken_at: 'x', data: s }];
  assert.equal(investView({ snaps, settings: {} }).portfolio_value, 177731);
  assert.equal(investView({ snaps, settings: { include_hidden: true } }).portfolio_value, 178931);
});

test('en Avanza-bild inom 5 dagar från periodgränsen tar bort varningen om avkastningen', async () => {
  const w = await setup({ net_worth_snapshots: [
    { user_id: U, period: '2026-09', total: 600000, amounts: { cash: 432000, stocks: 168000 }, deleted: false },
    { user_id: U, period: '2026-10', total: 609731, amounts: { cash: 432000, stocks: 177731 }, deleted: false },
  ], account_balances: [] });
  const step = (nw) => nw.breakdown.steps.find((x) => x.from === '2026-09');
  assert.ok(step(await w.call('get_net_worth')).warnings.some((x) => x.cat === 'stocks'));
  const a = clone(SNAP); a.date = '2026-08-26'; a.monthly_savings = [];
  const b = clone(SNAP); b.date = '2026-09-26';
  // Bilden från augusti sätter inte dagens saldo, men är ett känt värde vid periodgränsen 2026-08-25
  await w.call('import_avanza_snapshot', { snapshot: b, dry_run: false });
  await w.call('import_avanza_snapshot', { snapshot: a, dry_run: false });
  const nw = await w.call('get_net_worth');
  assert.ok(!(step(nw).warnings || []).some((x) => x.cat === 'stocks'));
  assert.equal(nw.avanza_returns[0].return, 0);
  // Saldoraderna finns per bilddatum; appens aktuella saldo (ett senare manuellt värde 2026-09-28) skrivs inte över av en äldre bild
  assert.deepEqual(w.tables.account_balances.filter((x) => x.account === 'avanza_isk').map((x) => [x.bal_date, x.value]).sort(), [['2026-08-26', 177731], ['2026-09-26', 177731]]);
  assert.deepEqual(w.state('accounts').find((x) => x.id === 'avanza_isk').balance, { value: 168000, date: '2026-09-28' });
});

test('koden kan bara läsa: inga anrop till Avanza', () => {
  for (const f of ['../functions/_shared/avanza.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /fetch\(|avanza\.se/i);
  }
});
