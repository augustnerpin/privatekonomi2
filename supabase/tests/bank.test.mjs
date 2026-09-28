// Bankkopplingens logik (functions/bank/core.ts): tolkning, dubbletter, kategorisering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBalance, mapTx, dedupe, overlap, newAppAccount, categorize, toRows, learnRules, markSavingsWithdrawals } from '../functions/bank/core.ts';

const ebTx = (amount, cd, date, text, o = {}) => ({
  entry_reference: o.ref || `${date}-${text}-${amount}`, transaction_amount: { amount: String(amount), currency: 'SEK' },
  credit_debit_indicator: cd, status: 'BOOK', booking_date: date, remittance_information: [text], ...o,
});
const S = {
  cats_exp: ['Mat (Butik)', 'Fest', 'Swish (privat)', 'Övrigt'], cats_inc: ['Lön', 'Övrigt'], cats_sav: ['Avanza'],
  cats_trf: ['Kreditkortsbetalning', 'Egen överföring'], owner_name: 'AUGUST NERPIN', pay_periods: [],
  merchant_rules: { 'partyland|ut': { type: 'expense', cat: 'Fest', t: 1 } },
};

test('mapTx: tecken, text och köpdatum i SEB-texten', () => {
  assert.deepEqual(mapTx(ebTx(187, 'DBIT', '2026-09-24', 'K*PARTYLAND')), { ref: '2026-09-24-K*PARTYLAND-187', date: '2026-09-24', bookingDate: '2026-09-24', raw: -187, desc: 'K*PARTYLAND' });
  const r = mapTx(ebTx(78.45, 'DBIT', '2026-09-24', 'ICA NARA B /26-09-22'));
  assert.equal(r.desc, 'ICA NARA B'); assert.equal(r.date, '2026-09-22'); assert.equal(r.bookingDate, '2026-09-24');
  assert.equal(mapTx(ebTx(29500, 'CRDT', '2026-09-25', 'LÖN')).raw, 29500);
  // Utan text: motpartens namn
  assert.equal(mapTx({ ...ebTx(100, 'DBIT', '2026-09-01', ''), remittance_information: [], creditor: { name: 'Hyresvärd AB' } }).desc, 'Hyresvärd AB');
  assert.equal(mapTx(ebTx(0, 'DBIT', '2026-09-01', 'NOLL')), null);
  // Överföring till konto: kontonummer + referens → bara kontonumret (som i kontoutdraget)
  assert.equal(mapTx(ebTx(6025, 'DBIT', '2026-09-25', '53293315887 224758863226')).desc, '53293315887');
});

test('dedupe: kontoutdrag som redan importerats dubbleras inte, två likadana köp blir kvar', () => {
  const existing = [
    { id: 1, type: 'expense', amount: 187, tx_date: '2026-09-22', extra: {} },           // CSV-import, annan dag
    { id: 2, type: 'income', amount: 29500, tx_date: '2026-09-25', extra: {} },
    { id: 3, type: 'expense', amount: 50, tx_date: '2026-09-20', extra: { bank_ref: 'r-old' } },
  ];
  const fresh = [
    mapTx(ebTx(187, 'DBIT', '2026-09-24', 'K*PARTYLAND')),       // = rad 1 (±4 dagar)
    mapTx(ebTx(29500, 'CRDT', '2026-09-25', 'LÖN')),             // = rad 2
    mapTx(ebTx(50, 'DBIT', '2026-09-20', 'X', { ref: 'r-old' })), // samma bankreferens
    mapTx(ebTx(35, 'DBIT', '2026-09-26', 'KAFFE', { ref: 'a' })),
    mapTx(ebTx(35, 'DBIT', '2026-09-26', 'KAFFE', { ref: 'b' })), // två likadana köp
    mapTx(ebTx(187, 'DBIT', '2026-09-24', 'K*PARTYLAND', { ref: 'p2' })), // ett till köp: rad 1 redan använd
  ];
  const { fresh: out, dups } = dedupe(fresh, existing);
  assert.equal(dups, 3);
  assert.deepEqual(out.map((t) => t.ref), ['a', 'b', 'p2']);
  assert.equal(overlap(fresh, existing), 3);
  // Borttagen bankrad kommer inte tillbaka; borttagen importerad rad matchar inte längre
  const gone = [{ id: 9, type: 'expense', amount: 99, tx_date: '2026-09-26', extra: { bank_ref: 'x' }, deleted: true }, { id: 8, type: 'expense', amount: 35, tx_date: '2026-09-26', extra: {}, deleted: true }];
  const r2 = dedupe([mapTx(ebTx(99, 'DBIT', '2026-09-26', 'X', { ref: 'x' })), mapTx(ebTx(35, 'DBIT', '2026-09-26', 'KAFFE', { ref: 'k' }))], gone);
  assert.deepEqual(r2.fresh.map((t) => t.ref), ['k']);
});

test('pickBalance: bokfört saldo först', () => {
  assert.deepEqual(pickBalance([{ balance_type: 'ITAV', balance_amount: { amount: '900' }, reference_date: '2026-09-27' }, { balance_type: 'CLBD', balance_amount: { amount: '1000.50' }, reference_date: '2026-09-27' }]), { value: 1000.5, date: '2026-09-27' });
  assert.equal(pickBalance([]), null);
});

test('newAppAccount: namn från produkten, typ och löpnummer', () => {
  const a = newAppAccount({ uid: 'u1', aspsp: 'SEB', name: 'Sparkonto', cash_account_type: 'SVGS', iban: 'SE45 5000 0000 0583 9825 7466' }, [{ id: 'seb_7466', name: 'x' }]);
  assert.deepEqual(a, { id: 'seb_7466x', name: 'Sparkonto (SEB)', kind: 'savings', number: 'SE4550000000058398257466' });
  // SEB: name = kontohavaren, product = kontot, CACC även för sparkonton, inget kontonummer
  const b = newAppAccount({ uid: '4fc58291-5673-4aac-8d03-7e3cb8f345bb', aspsp: 'SEB', name: 'AUGUST NERPIN', product: 'Enkla sparkontot', cash_account_type: 'CACC' }, [{ id: 'lonekonto', name: 'Enkla sparkontot (SEB)' }]);
  assert.deepEqual(b, { id: 'seb_45bb', name: 'Enkla sparkontot 2 (SEB)', kind: 'savings' });
});

test('kontoroller: AMEX-konto, bolånekonto och sparkonto räknas inte dubbelt', async () => {
  const acc = { lonekonto: { kind: 'bank' }, amexk: { kind: 'bank', role: 'card_payment' }, bolan: { kind: 'savings', role: 'mortgage' }, spar: { kind: 'savings', role: 'savings' } };
  const S2 = { ...S, cats_sav: ['Avanza', 'SEB'], merchant_rules: { '#53293380441|ut': { type: 'savings', cat: 'SEB' }, '#53293315887|ut': { type: 'expense', cat: 'Boende (Lån)' } }, cats_exp: [...S.cats_exp, 'Boende (Lån)'] };
  const rows = [
    { ...mapTx(ebTx(10000, 'DBIT', '2026-09-25', '53293380441 224830234577', { ref: 'l1' })), account: 'lonekonto' },
    { ...mapTx(ebTx(10000, 'CRDT', '2026-09-25', 'AUGUST NERPI', { ref: 's1' })), account: 'spar' },
    { ...mapTx(ebTx(6025, 'DBIT', '2026-09-25', '53293315887 224758863226', { ref: 'l2' })), account: 'lonekonto' },
    { ...mapTx(ebTx(6025, 'CRDT', '2026-09-25', 'AUGUST NERPI', { ref: 'b1' })), account: 'bolan' },
    { ...mapTx(ebTx(7930, 'DBIT', '2026-09-25', '51960273264 225717143320', { ref: 's2' })), account: 'spar' },
    { ...mapTx(ebTx(7930, 'CRDT', '2026-09-25', 'AUGUST NERPI', { ref: 'a1' })), account: 'amexk' },
    { ...mapTx(ebTx(5977.3, 'DBIT', '2026-10-07', 'AMERICAN EXPRESS', { ref: 'a2' })), account: 'amexk' },
    { ...mapTx(ebTx(5977.3, 'DBIT', '2026-09-07', '53290207161 162051819843', { ref: 'a3' })), account: 'amexk' },
    { ...mapTx(ebTx(60, 'DBIT', '2026-09-02', 'BETALSERVICE', { ref: 'a4' })), account: 'amexk' },
  ];
  const groups = await categorize(S2, rows, (id) => acc[id], async () => []);
  const out = toRows('u', groups, S2, 1);
  assert.equal(markSavingsWithdrawals(S2, out, (id) => acc[id]), 1);
  const by = Object.fromEntries(out.map((r) => [r.extra.bank_ref, [r.type, r.category, r.amount]]));
  assert.deepEqual(by.l1, ['savings', 'SEB', 10000]);          // sparande räknas på lönekontot
  assert.deepEqual(by.s1, ['transfer', 'Egen överföring', 10000]);
  assert.deepEqual(by.l2, ['expense', 'Boende (Lån)', 6025]);  // bolånekostnaden räknas när den sätts in
  assert.deepEqual(by.b1, ['transfer', 'Egen överföring', 6025]);
  assert.deepEqual(by.s2, ['transfer', 'Egen överföring', -7930]);
  assert.deepEqual(by.a1, ['savings', 'SEB', -7930]);          // uttag ur sparandet
  assert.deepEqual(by.a2, ['transfer', 'Kreditkortsbetalning', -5977.3]);
  assert.deepEqual(by.a3, ['transfer', 'Kreditkortsbetalning', -5977.3]); // fakturan till girnummer
  assert.deepEqual(by.a4, ['expense', 'Övrigt', 60]);                    // bankavgift = vanlig utgift
});

test('categorize: regler, automatiska regler, AI och gissning', async () => {
  const rows = [
    { ...mapTx(ebTx(187, 'DBIT', '2026-09-24', 'PARTYLAND')), account: 'lonekonto' },        // inlärd regel (K* spelar ingen roll)
    { ...mapTx(ebTx(5000, 'DBIT', '2026-09-24', 'AMERICAN EXPRESS')), account: 'lonekonto' }, // kortfakturan
    { ...mapTx(ebTx(200, 'DBIT', '2026-09-24', '46701234567')), account: 'lonekonto' },       // Swish mobil
    { ...mapTx(ebTx(99, 'DBIT', '2026-09-24', 'WILLYS UMEA')), account: 'lonekonto' },        // AI
    { ...mapTx(ebTx(42, 'DBIT', '2026-09-24', 'OKAND BUTIK')), account: 'lonekonto' },        // AI svarar ogiltigt → gissning
  ];
  let asked;
  const ai = async (groups) => { asked = groups.map((g) => g.desc); return [{ k: 0, type: 'expense', cat: 'Mat (Butik)', conf: 'high' }, { k: 1, type: 'expense', cat: 'Finns inte', conf: 'high' }]; };
  const groups = await categorize(S, rows, () => ({ kind: 'bank' }), ai);
  const by = Object.fromEntries(groups.map((g) => [g.desc, [g.type, g.cat, g.src]]));
  assert.deepEqual(asked, ['WILLYS UMEA', 'OKAND BUTIK']);
  assert.deepEqual(by['PARTYLAND'], ['expense', 'Fest', 'rule']);
  assert.deepEqual(by['AMERICAN EXPRESS'], ['transfer', 'Kreditkortsbetalning', 'auto']);
  assert.deepEqual(by['46701234567'], ['expense', 'Swish (privat)', 'auto']);
  assert.deepEqual(by['WILLYS UMEA'], ['expense', 'Mat (Butik)', 'ai']);
  assert.deepEqual(by['OKAND BUTIK'], ['expense', 'Övrigt', 'guess']);
  // Rader: utgift positivt, överföring med bankens tecken, osäkra markeras för granskning, löneperiod
  const out = toRows('u', groups, S, 1000);
  const amex = out.find((r) => r.description === 'AMERICAN EXPRESS');
  assert.equal(amex.amount, -5000); assert.equal(out.find((r) => r.description === 'PARTYLAND').amount, 187);
  assert.equal(out.find((r) => r.description === 'OKAND BUTIK').extra.review, true);
  assert.equal(out[0].month, '2026-09'); // 24 sep är dagen före lönen (25 sep) → september-perioden
  assert.deepEqual(new Set(out.map((r) => r.source)), new Set(['bank']));
  assert.deepEqual(Object.keys(learnRules(S, groups)).sort(), ['partyland|ut', 'willys umea|ut']);
  // Fel i AI:n: allt som inte har regel gissas, inget kraschar
  const g2 = await categorize(S, rows.slice(3), () => ({ kind: 'bank' }), async () => { throw new Error('nere'); });
  assert.deepEqual(g2.map((g) => g.src), ['guess', 'guess']);
});

test('bolån: amortering sänker skulden, räntan sparas, andra konton påverkar inte', async () => {
  const { loanUpdates } = await import('../functions/bank/core.ts');
  const acc = { bolan: { role: 'mortgage' }, lonekonto: { kind: 'bank' } };
  const loans = [{ id: 'L1', name: 'Bolån', extra: { pay_account: 'bolan' }, history: [{ date: '2026-09-01', value: 1800000 }] }];
  const rows = [
    { account: 'bolan', type: 'transfer', amount: -1500, description: 'AMORTERING 53293315887', tx_date: '2026-10-28' },
    { account: 'bolan', type: 'transfer', amount: -4525, description: 'RÄNTA 53293315887', tx_date: '2026-10-28' },
    { account: 'bolan', type: 'transfer', amount: 6025, description: 'AUGUST NERPI', tx_date: '2026-10-25' },
    { account: 'lonekonto', type: 'expense', amount: 999, description: 'AMORTERING X', tx_date: '2026-10-28' },
  ];
  const u = loanUpdates(rows, loans, (id) => acc[id]);
  assert.deepEqual(u.balances, [{ loan_id: 'L1', bal_date: '2026-10-28', value: 1798500 }]);
  assert.deepEqual(u.interest, { L1: { date: '2026-10-28', amount: 4525 } });
  // Utan känd skuld före dragningen gissas ingen ny skuld
  assert.deepEqual(loanUpdates(rows, [{ ...loans[0], history: [] }], (id) => acc[id]).balances, []);
});
