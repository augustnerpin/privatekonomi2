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
