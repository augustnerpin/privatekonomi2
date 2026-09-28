// Vad förändringen består av (decompose i functions/_shared/networth.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decompose } from '../functions/_shared/networth.ts';

const snaps = [
  { period: '2026-08', total: 600000, amounts: { cash: 200000, stocks: 150000, pension: 50000, apt: 200000 } },
  { period: '2026-09', total: 626000, amounts: { cash: 202000, stocks: 162000, pension: 52000, apt: 210000 } },
];
const starts = { '2026-08': '2026-07-24', '2026-09': '2026-08-25' };
const txs = [
  { month: '2026-08', type: 'savings', category: 'Avanza', amount: 10000 },
  { month: '2026-08', type: 'savings', category: 'SEB', amount: 2000 },
  { month: '2026-08', type: 'savings', category: 'Amortering', amount: 2500 },
  { month: '2026-08', type: 'expense', category: 'Mat', amount: 999 },
  { month: '2026-09', type: 'savings', category: 'Avanza', amount: 7777 }, // efter bild 2026-09: räknas inte
];

test('decompose: sparande, amortering (från kategorin), avkastning, omvärdering och övrigt summerar till förändringen', () => {
  const d = decompose({ snaps, txs, loans: [], starts, investCats: ['Avanza'], pensionPerMonth: 2000 });
  const s = d.steps[0];
  assert.deepEqual(s, { from: '2026-08', to: '2026-09', start: 600000, end: 626000, change: 26000, sparande: 12000, amortering: 2500,
    avkastning: 14000 - 10000 - 2000, omvardering: 10000 - 2500, ovrigt: 26000 - 12000 - 2500 - 2000 - 7500 });
  assert.equal(s.sparande + s.amortering + s.avkastning + s.omvardering + s.ovrigt, s.change);
  assert.deepEqual(d.total, { ...s });
});

test('decompose: amortering från lånens skuldhistorik när den finns', () => {
  const loans = [{ id: 'L', history: [{ date: '2026-07-20', value: 1000000 }, { date: '2026-08-25', value: 997000 }] }];
  const d = decompose({ snaps, txs, loans, starts, investCats: ['Avanza'] });
  assert.equal(d.steps[0].amortering, 3000);
  assert.equal(d.steps[0].omvardering, 10000 - 3000);
});

test('decompose med riktiga lån: skulden räknas bakåt → amortering 2 546, omvärdering 51 058 (sep → okt 2026)', async () => {
  const { debtAt } = await import('../functions/_shared/networth.ts');
  const loans = [['A', 648491, 1167], ['B', 650300, 1100], ['C', 213605, 279]].map(([id, v, am]) => ({ id, amortization: am, secured_by: 'apt', history: [{ date: '2026-09-28', value: v }] }));
  // Före dragningen 28/9 var skulden en amortering högre, 25/8 två
  assert.deepEqual(debtAt(loans[0], '2026-09-25'), { date: '2026-09-25', value: 648491 + 1167, estimated: true });
  assert.equal(debtAt(loans[0], '2026-08-25').value, 648491 + 2 * 1167);
  assert.deepEqual(debtAt(loans[0], '2026-09-30'), { date: '2026-09-28', value: 648491, estimated: false });
  const real = [
    { period: '2026-09', total: 659000, amounts: { ab: 31300, apt: 134000, cash: 234000, other: 0, stocks: 172500, klockor: 31000, pension: 55000, kontanter: 1200 } },
    { period: '2026-10', total: 707104, amounts: { ab: 31300, apt: 187604, cash: 230000, other: 0, stocks: 168000, klockor: 31000, pension: 58000, kontanter: 1200 } },
  ];
  const d = decompose({ snaps: real, txs: [], loans, starts: { '2026-09': '2026-08-25', '2026-10': '2026-09-25' }, investCats: ['Avanza'] });
  assert.equal(d.steps[0].amortering, 2546); assert.equal(d.steps[0].omvardering, 51058);
});

test('decompose: varning när aktier/pension saknar värde nära periodgränsen', () => {
  const d = decompose({ snaps, txs, loans: [], starts, investCats: ['Avanza'], valueDates: { stocks: ['2026-07-25', '2026-08-20'], pension: ['2026-07-24'] } });
  // stocks: 25/7 (1 dag från 24/7) ok, 20/8 (5 dagar från 25/8) ok; pension saknar värde nära 25/8
  assert.deepEqual(d.steps[0].warnings, [{ cat: 'pension', period: '2026-09', boundary: '2026-08-25', gap_days: 32 }]);
  assert.equal(d.total.warnings.length, 1);
  assert.equal(decompose({ snaps, txs, loans: [], starts, investCats: [] }).steps[0].warnings, undefined);
});
