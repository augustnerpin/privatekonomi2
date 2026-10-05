// Nattens vakt (functions/bank/watch.ts): prishöjningar, nya abonnemang, dubbeldragningar och AI-notisens kontroll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceHikes, newSubscriptions, duplicateCharges, watchItems, checkAiDigest } from '../functions/bank/watch.ts';
import { buildDigest } from '../functions/bank/notify.ts';

let id = 1;
const row = (month, description, amount, extra = {}) => ({ id: id++, type: 'expense', category: 'Prenumerationer', amount, description, tx_date: month + '-05', month, mkey: null, account: 'lonekonto', ...extra });
const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

test('prishöjning: Netflix 129 → 149 kr efter fyra stabila månader', () => {
  const rows = [...months.slice(1).map((m) => row(m, 'NETFLIX.COM', 129)), row('2026-10', 'NETFLIX.COM', 149)];
  const h = priceHikes(rows, '2026-10');
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].name, h[0].typical, h[0].current], ['NETFLIX.COM', 129, 149]);
});

test('prishöjning: inte vid två dragningar i perioden, små höjningar eller vanlig handel', () => {
  const stable = months.slice(2).map((m) => row(m, 'SPOTIFY', 119));
  assert.equal(priceHikes([...stable, row('2026-10', 'SPOTIFY', 119), row('2026-10', 'SPOTIFY', 119)], '2026-10').length, 0);
  assert.equal(priceHikes([...stable, row('2026-10', 'SPOTIFY', 125)], '2026-10').length, 0); // +6 kr
  const ica = months.flatMap((m) => [row(m, 'ICA NARA', 300), row(m, 'ICA NARA', 250), row(m, 'ICA NARA', 400)]);
  assert.equal(priceHikes([...ica, row('2026-10', 'ICA NARA', 900)], '2026-10').length, 0);
});

test('nytt abonnemang: samma belopp två perioder i rad och aldrig förut', () => {
  const rows = [row('2026-09', 'K*STORYTEL', 229), row('2026-10', 'K*STORYTEL', 229), ...months.map((m) => row(m, 'HYRA', 9000))];
  const n = newSubscriptions(rows, '2026-10');
  assert.deepEqual(n.map((x) => [x.name, x.amount, x.why]), [['K*STORYTEL', 229, 'twice']]);
  // Har funnits tidigare → inte nytt
  assert.equal(newSubscriptions([row('2026-03', 'K*STORYTEL', 229), ...rows], '2026-10').length, 0);
  // Första dragningen i Prenumerationer räcker
  assert.equal(newSubscriptions([row('2026-10', 'DISNEY PLUS', 109)], '2026-10')[0].why, 'first');
  assert.equal(newSubscriptions([row('2026-10', 'BAUHAUS', 109, { category: 'Hem' })], '2026-10').length, 0);
});

test('dubbeldragning: samma butik, konto och belopp inom två dagar', () => {
  const a = row('2026-10', 'K*ELGIGANTEN', 1299, { tx_date: '2026-10-03' }), b = row('2026-10', 'K*ELGIGANTEN', 1299, { tx_date: '2026-10-04' });
  const d = duplicateCharges([b], [a]);
  assert.equal(d.length, 1); assert.deepEqual(d[0].dates, ['2026-10-03', '2026-10-04']);
  // Båda nya i natt → en träff, inte två
  assert.equal(duplicateCharges([a, b], []).length, 1);
  // Under 100 kr, annat konto, fyra dagar isär eller väntande AMEX-rad → ingen träff
  assert.equal(duplicateCharges([row('2026-10', 'PRESSBYRAN', 45)], [row('2026-10', 'PRESSBYRAN', 45)]).length, 0);
  assert.equal(duplicateCharges([{ ...b, account: 'amex' }], [a]).length, 0);
  assert.equal(duplicateCharges([{ ...b, tx_date: '2026-10-07' }], [a]).length, 0);
  assert.equal(duplicateCharges([{ ...b, category: 'AMEX (väntande)' }], [a]).length, 0);
});

test('watchItems: OK i appen (sub_seen) tystar prishöjningen tills priset ändras igen', () => {
  const rows = [...months.slice(1).map((m) => row(m, 'NETFLIX.COM', 129)), row('2026-10', 'NETFLIX.COM', 149)];
  assert.equal(watchItems({ rows, newRows: [], pid: '2026-10' }).filter((i) => i.kind === 'price').length, 1);
  assert.equal(watchItems({ rows, newRows: [], pid: '2026-10', seen: { 'netflix com': 149 } }).length, 0);
  assert.equal(watchItems({ rows, newRows: [], pid: '2026-10', seen: { 'netflix com': 139 } }).length, 1);
});

test('buildDigest: dubbeldragning först med egen rubrik, items följer med till AI:n', () => {
  const watch = [{ key: 'dubbel:1:2', line: '🔁 Dubbeldragning? X 1 299 kr två gånger', kind: 'dup' }, { key: 'pris:n:2026-10', line: '📈 N har blivit dyrare', kind: 'price' }];
  const d = buildDigest({ newRows: [], spent: {}, budgets: {}, period: { id: '2026-10', start: '2026-09-25', end: '2026-10-24' }, today: '2026-10-05', conns: [], sent: new Set(), watch });
  assert.equal(d.title, 'Möjlig dubbeldragning');
  assert.ok(d.body.startsWith('🔁'));
  assert.deepEqual(d.keys, ['dubbel:1:2', 'pris:n:2026-10']);
  assert.equal(d.items.length, 2);
});

test('checkAiDigest: godtar omskriven text men inte påhittade tal', () => {
  const items = [{ line: '📈 Netflix har blivit dyrare: 149 kr (brukar vara 129 kr) – 240 kr mer per år' }, { line: '🧾 3 nya köp för 1 245 kr' }];
  assert.deepEqual(checkAiDigest({ title: 'Netflix höjde priset', body: 'Netflix kostar nu 149 kr i stället för 129 kr – 240 kr mer per år.\nSäg upp eller förhandla i appen.' }, items),
    { title: 'Netflix höjde priset', body: 'Netflix kostar nu 149 kr i stället för 129 kr – 240 kr mer per år.\nSäg upp eller förhandla i appen.' });
  assert.ok(checkAiDigest({ title: 'Inköp', body: '3 nya köp för 1 245 kr' }, items)); // tusentalsavgränsare
  assert.equal(checkAiDigest({ title: 'Netflix', body: 'Höjningen är 15 %' }, items), null);
  assert.equal(checkAiDigest({ title: 'Netflix', body: 'Du betalar 1 788 kr per år' }, items), null);
  assert.equal(checkAiDigest(null, items), null);
  assert.equal(checkAiDigest({ title: '', body: 'x' }, items), null);
});
