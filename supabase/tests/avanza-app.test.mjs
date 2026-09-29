// Appens investeringsvy (index.html): visar serverns vy (investView) utan egna beräkningar, och bara fakta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appFns, fmt } from './app.mjs';
import { investView, normalizeSnapshot } from '../functions/_shared/avanza.ts';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const snap = normalizeSnapshot({
  date: '2026-09-29', total_value: 60000,
  accounts: [{ name: 'Fondkonto', type: 'ISK', value: 40000, cash: 10000, reserved_cash: 10000, since_purchase_kr: 3000 }, { name: 'Utökat lån ISK', type: 'ISK', value: 20000, cash: 0, since_purchase_kr: 1000, funded_by_loan: true }],
  holdings: [{ account: 'Fondkonto', name: 'Alibaba', kind: 'aktie', value: 30000 }, { account: 'Utökat lån ISK', name: 'XACT', kind: 'ETF', value: 20000 }],
});
const view = investView({ snaps: [{ snap_date: '2026-09-29', taken_at: 'x', data: snap }], settings: { interest_deduction_pct: 30, leverage: { since: '2026-06-25' } },
  loans: [{ id: 'L', interest_pct: 2.76, history: [{ date: '2026-09-28', value: 100000 }] }] });

test('appen: underkonton under Avanza ISK, hävstången och varningen visas; inga köp- eller säljråd', () => {
  const g = { ld: () => null, _invest: null, _avzPending: null, _sbUser: { id: 'u' }, esc, fmt, fmtSigned: (n) => (n >= 0 ? '+' : '') + fmt(n), jsArg: (s) => JSON.stringify(s), bankCall: async () => ({}), toast: () => {}, renderNetWorth: () => {}, localStorage: { setItem() {} } };
  const app = appFns(['pctTxt', 'invRow', 'invBlock', 'avanzaSubHtml', 'investHtml', 'investSettingsHtml', 'avzPasteHtml'], g);
  // _invest är en let i appen: sätts via funktionernas scope genom en ny instans med vyn som global
  const app2 = appFns(['pctTxt', 'invRow', 'invBlock', 'avanzaSubHtml', 'investHtml', 'investSettingsHtml', 'avzPasteHtml'], { ...g, _invest: { ...view, settings: {} }, _avzPending: null });
  const sub = app2.avanzaSubHtml({ id: 'avanza_isk' });
  assert.match(sub, /2 konton hos Avanza/); assert.match(sub, /Summa 60 000 kr = saldot ✓/);
  assert.equal(app2.avanzaSubHtml({ id: 'klarna' }), '');
  const h = app2.investHtml();
  assert.match(h, /Lånat kapital gav \+1 000 kr, kostade −/);
  assert.match(h, /Alibaba är 50 % av portföljen \(gräns 15 %\)/);
  assert.match(h, /Tillgängligt direkt/); assert.match(h, /ISK-skatt 2026 \(uppskattning\)/);
  assert.doesNotMatch(h, /rekommenderar|bör (köpa|sälja)|köp mer|sälj av/i);
  assert.match(app.investHtml(), /Ingen Avanza-bild ännu/);
});
