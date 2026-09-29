// Sparande utifrån kontotyp (applySavingsModel i functions/bank/core.ts): de fem testfallen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySavingsModel, splitMortgageRows, savingsByPeriod } from '../functions/bank/core.ts';

const S = {
  owner_name: 'AUGUST NERPIN',
  cats_exp: ['Boende (Lån)', 'AMEX (väntande)', 'Övrigt'], cats_sav: ['Avanza', 'SEB', 'Klarna', 'Amortering', 'Annat'],
  accounts: [
    { id: 'lonekonto', kind: 'bank', number: '53290207161' },
    { id: 'amexk', kind: 'bank', role: 'card_payment', number: '51960273264' },
    { id: 'bolan', kind: 'passage', role: 'mortgage', number: '53293315887' },
    { id: 'spar', kind: 'savings', sav_cat: 'SEB', number: '53293380441' },
    { id: 'avanza', kind: 'investment', sav_cat: 'Avanza', match: ['AVANZA BANK', 'AVANZA'], manual: true },
    { id: 'klarna', kind: 'savings', sav_cat: 'Klarna', match: ['KLARNA BANK'], manual: true },
  ],
};
let id = 1;
// Rad som den ligger efter kategorisering (utan modellen): type/category/amount enligt appens konvention
const row = (account, type, category, amount, tx_date, description, extra = {}) => ({ id: id++, account, type, category, amount, tx_date, month: '2026-10', description, extra, deleted: false });
// Summa sparande efter att modellens ändringar tillämpats
function savingsAfter(rows) {
  const ch = new Map(applySavingsModel(rows, S).map((c) => [c.id, c.after]));
  return rows.filter((r) => !r.deleted).reduce((s, r) => { const a = ch.get(r.id) || r; return s + (a.type === 'savings' ? Number(a.amount) : 0); }, 0);
}

test('1: lönekonto → sparkonto → lönekonto → Avanza = +10 000 (inte +20 000)', () => {
  const rows = [
    row('lonekonto', 'savings', 'SEB', 10000, '2026-10-01', '53293380441'),        // regeln gav +SEB
    row('spar', 'transfer', 'Egen överföring', 10000, '2026-10-01', 'AUGUST NERPI'),
    row('spar', 'transfer', 'Egen överföring', -10000, '2026-10-05', '53290207161'),
    row('lonekonto', 'transfer', 'Egen överföring', 10000, '2026-10-05', 'AUGUST NERPI'), // regeln gav neutral
    row('lonekonto', 'savings', 'Avanza', 10000, '2026-10-06', 'AVANZA BANK'),
  ];
  assert.equal(rows.reduce((s, r) => s + (r.type === 'savings' ? r.amount : 0), 0), 20000); // före: dubbelräknat
  assert.equal(savingsAfter(rows), 10000);
  const ch = applySavingsModel(rows, S);
  assert.deepEqual(ch.find((c) => c.id === rows[3].id).after, { type: 'savings', category: 'SEB', amount: -10000 });
  // Körs igen på resultatet: inga fler ändringar
  const applied = rows.map((r) => { const c = ch.find((x) => x.id === r.id); return c ? { ...r, ...c.after, extra: { ...r.extra, ...(c.pair_id ? { transfer_pair_id: c.pair_id } : {}) } } : r; });
  assert.deepEqual(applySavingsModel(applied, S), []);
});

test('2: Klarna → lönekonto → Avanza, samma belopp = 0', () => {
  const rows = [
    row('lonekonto', 'income', 'Övrigt', 5000, '2026-10-02', 'KLARNA BANK AB'),
    row('lonekonto', 'savings', 'Avanza', 5000, '2026-10-03', 'AVANZA BANK'),
    row('lonekonto', 'expense', 'Övrigt', 379, '2026-10-03', 'K*KLARNA MEM'),    // kortköp: inte Klarna-kontot
  ];
  assert.equal(savingsAfter(rows), 0);
  const ch = applySavingsModel(rows, S);
  assert.deepEqual(ch.map((c) => [c.description, c.after.category, c.after.amount]), [['KLARNA BANK AB', 'Klarna', -5000]]);
});

test('3: sparkonto → Avanza direkt = 0', () => {
  const rows = [row('spar', 'savings', 'Avanza', 8000, '2026-10-04', 'AVANZA BANK')]; // ut från sparkontot (regeln gav +Avanza)
  assert.equal(savingsAfter(rows), 0);
  assert.deepEqual(applySavingsModel(rows, S)[0].after, { type: 'transfer', category: 'Egen överföring', amount: -8000 });
});

test('4: bolånedragning 6 025 = ränta 3 479 (utgift) + Amortering 2 546, inget annat sparande', () => {
  const loans = [['A', 648491, 1167], ['B', 650300, 1100], ['C', 213605, 279]].map(([lid, v, am]) => ({ id: lid, interest_pct: 2.76, amortization: am, extra: { pay_account: 'bolan' }, history: [{ date: '2026-09-28', value: v }] }));
  const pay = row('lonekonto', 'expense', 'Boende (Lån)', 6025, '2026-10-25', '53293315887', { bank_ref: 'x' });
  const inn = row('bolan', 'transfer', 'Egen överföring', 6025, '2026-10-25', 'AUGUST NERPI');
  const draw = row('bolan', 'transfer', 'Egen överföring', -2596, '2026-10-28', 'LÅN 48500366');
  let n = 1000; const split = splitMortgageRows(S, [pay, inn, draw], loans, () => n++).rows;
  const ch = applySavingsModel(split, S);
  const final = split.map((r) => ({ ...r, ...(ch.find((c) => c.id === r.id)?.after || {}) })).filter((r) => !r.deleted);
  assert.deepEqual(final.filter((r) => r.type === 'savings').map((r) => [r.category, r.amount]), [['Amortering', 2546]]);
  assert.deepEqual(final.filter((r) => r.type === 'expense').map((r) => [r.category, r.amount]), [['Boende (Lån)', 3479]]);
  assert.ok(final.filter((r) => r.account === 'bolan').every((r) => r.type === 'transfer'));
});

test('5: sparkonto → AMEX-konto 7 930 = −7 930 sparande + 7 930 utgift AMEX (väntande)', () => {
  const rows = [
    row('spar', 'expense', 'AMEX (väntande)', 7930, '2026-09-25', '51960273264'),
    row('amexk', 'transfer', 'Egen överföring', 7930, '2026-09-25', 'AUGUST NERPI'),
  ];
  const ch = applySavingsModel(rows, S);
  const final = rows.map((r) => ({ ...r, ...(ch.find((c) => c.id === r.id)?.after || {}) }));
  assert.deepEqual(final.map((r) => [r.account, r.type, r.category, r.amount]), [['spar', 'expense', 'AMEX (väntande)', 7930], ['amexk', 'savings', 'SEB', -7930]]);
  assert.equal(savingsAfter(rows), -7930);
});

test('rader utan motpart (äldre sparrader utan text) ändras inte; tabellen per period', () => {
  const rows = [row('lonekonto', 'savings', 'Annat', 7000, '2025-07-25', ''), row('lonekonto', 'transfer', 'Egen överföring', 3000, '2025-07-26', 'AUGUST NERPI')];
  assert.deepEqual(applySavingsModel(rows, S), []);
  const t = savingsByPeriod(rows, []); assert.deepEqual(t, [{ period: '2026-10', before: 7000, after: 7000, diff: 0 }]);
});

test('6: överföring till AMEX-kontot med eget meddelande ("VIN FARMOR") blir AMEX (väntande), även i appen', async () => {
  const pay = () => [
    row('lonekonto', 'expense', 'Bjuda andra/presenter', 375, '2026-09-29', 'VIN FARMOR 122657943444', { review: true }), // AI:ns gissning
    row('amexk', 'transfer', 'Egen överföring', 375, '2026-09-29', 'VIN FARMOR'),
    row('lonekonto', 'transfer', 'Kreditkortsbetalning', -500, '2026-09-10', 'VIN'),                                     // redan avräknad: rörs inte
    row('amexk', 'transfer', 'Egen överföring', 500, '2026-09-10', 'VIN'),
  ];
  const rows = pay();
  const ch = applySavingsModel(rows, S);
  const c = ch.find((x) => x.id === rows[0].id);
  assert.deepEqual(c.after, { type: 'expense', category: 'AMEX (väntande)', amount: 375 });
  assert.equal(c.clear_review, true);
  assert.equal(ch.find((x) => x.id === rows[2].id)?.after?.category ?? 'Kreditkortsbetalning', 'Kreditkortsbetalning');
  assert.equal(ch.find((x) => x.id === rows[1].id)?.after?.type ?? 'transfer', 'transfer'); // AMEX-kontots sida neutral
  // Appens egen kod ger samma
  const { appFns } = await import('./app.mjs');
  const descNumber = (d) => { const m = String(d || '').replace(/\s/g, '').match(/^\d{6,}$/); return m ? m[0] : null; };
  const app = appFns(['accClassApp', 'rawOfTx', 'applySavingsModelApp'], {
    getAccounts: () => S.accounts, getOwnerName: () => S.owner_name, getSavCats: () => S.cats_sav, getExpCats: () => S.cats_exp, descNumber,
    parseLocalDate: (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }, AMORT_CAT: 'Amortering', PENDING_CARD_CAT: 'AMEX (väntande)',
  });
  const txs = pay().map(({ category, tx_date, description, extra, ...r }) => ({ ...r, cat: category, date: tx_date, desc: description, ...extra }));
  const a = app.applySavingsModelApp(txs).find((x) => x.id === txs[0].id);
  assert.deepEqual(a.after, { type: 'expense', cat: 'AMEX (väntande)', amount: 375 });
  assert.equal(app.applySavingsModelApp(txs).find((x) => x.id === txs[2].id), undefined);
});
