// Manuella saldon/värden: uppskattat tills bekräftat, senast uppdaterad, äldre än 6 månader
// (valueStatus/manualValues i functions/_shared/networth.ts och valueStatusApp i appen).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueStatus, manualValues } from '../functions/_shared/networth.ts';
import { appFns } from './app.mjs';

const TODAY = '2026-09-29';
const accounts = [{ id: 'lonekonto', name: 'Lönekonto', kind: 'bank' }, { id: 'klarna', name: 'Klarna', kind: 'savings', manual: true }, { id: 'avanza_isk', name: 'Avanza ISK', kind: 'investment', manual: true }];
const balances = [
  { account: 'lonekonto', bal_date: '2026-09-28', value: 8446.22, source: 'bank' },
  { account: 'klarna', bal_date: '2026-09-28', value: 210825.03, source: 'manual' },
  { account: 'avanza_isk', bal_date: '2026-09-28', value: 168000, source: 'manual', confirmed: true },
];
const assets = [
  { asset: 'apt', val_date: '2026-02-01', value: 1700000 },            // äldre än 6 månader
  { asset: 'klockor', val_date: '2026-04-01', value: 31000, confirmed: true },
];

test('Klarna 210 825 kr är uppskattat tills det bekräftats; bankens saldo räknas inte som manuellt', () => {
  const mv = manualValues({ accounts, balances, assets, today: TODAY });
  const by = Object.fromEntries(mv.map((x) => [x.id, x]));
  assert.equal(by.lonekonto, undefined);
  assert.deepEqual([by.klarna.value, by.klarna.updated, by.klarna.estimated, by.klarna.stale], [210825.03, '2026-09-28', true, false]);
  assert.deepEqual([by.avanza_isk.estimated, by.avanza_isk.stale], [false, false]);
  assert.deepEqual([by.apt.name, by.apt.updated, by.apt.estimated, by.apt.stale], ['Lägenhet', '2026-02-01', true, true]);
  assert.deepEqual([by.klockor.estimated, by.klockor.stale], [false, false]);
  // Gränsen: exakt 6 månader gammalt är inte "äldre än 6 månader"
  assert.equal(valueStatus({ date: '2026-03-29' }, 'asset', TODAY).stale, false);
  assert.equal(valueStatus({ date: '2026-03-28' }, 'asset', TODAY).stale, true);
  assert.equal(valueStatus({ date: '2026-09-28', source: 'import' }, 'account', TODAY).manual, false);
});

test('appen: samma status, och raden visar "uppdaterad", "uppskattat", "äldre än 6 mån" och Bekräfta', () => {
  const ymdOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const app = appFns(['STALE_MONTHS', 'valueStatusApp', 'valueTag', 'valueStatusHtml'], { todayLocal: () => TODAY, ymdOf, esc, jsArg: (s) => esc(JSON.stringify(String(s))) });
  for (const [v, kind] of [[{ date: '2026-09-28', source: 'manual' }, 'account'], [{ date: '2026-02-01' }, 'asset'], [{ date: '2026-03-29' }, 'asset'], [{ date: '2026-03-28' }, 'asset'], [{ date: '2026-09-28', source: 'bank' }, 'account'], [{ date: '2026-04-01', confirmed: true }, 'asset']]) {
    const s = valueStatus(v, kind, TODAY), a = app.valueStatusApp(v, kind);
    assert.deepEqual([a.manual, a.estimated, a.stale], [s.manual, s.estimated, s.stale], JSON.stringify(v));
  }
  const h = app.valueStatusHtml({ date: '2026-02-01', value: 1700000 }, 'asset', 'apt');
  assert.match(h, /uppdaterad 2026-02-01/); assert.match(h, /uppskattat/); assert.match(h, /äldre än 6 mån/); assert.match(h, /Bekräfta/);
  const ok = app.valueStatusHtml({ date: '2026-09-01', value: 1, confirmed: true }, 'asset', 'apt');
  assert.match(ok, /uppdaterad 2026-09-01/); assert.doesNotMatch(ok, /uppskattat|Bekräfta|äldre/);
  assert.equal(app.valueStatusHtml({ date: '2026-09-28', value: 1, source: 'bank' }, 'acc', 'lonekonto'), '');
});
