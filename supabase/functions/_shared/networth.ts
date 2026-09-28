// Förmögenhet räknad från källorna i stället för att matas in för hand (samma regler som appen).
//  • Konton: senaste saldo per konto (account_balances, annars accounts[].balance) → kontots nw_cat
//    (standard: bank/sparkonto → cash, investering → stocks, kort → inget)
//  • Tillgångar med manuellt värde (asset_values): senaste värde per kategori (t.ex. lägenheten)
//  • Lån: skulden dras från kategorin lånet "hör till" (secured_by), annars från "other"
//  • Kategorier utan någon källa behåller värdet från förra förmögenhetsbilden
// Konvention: en förmögenhetsbild för löneperioden P = läget när P börjar (samma som de manuella).
// deno-lint-ignore-file no-explicit-any
import type { Obj } from './finance.ts';

export const DEF_NW_CATS = [
  { key: 'cash', label: 'Likvidamedel' }, { key: 'stocks', label: 'Aktier/fonder' }, { key: 'apt', label: 'Lägenhet' },
  { key: 'pension', label: 'Pension' }, { key: 'klockor', label: 'Klockor' }, { key: 'ab', label: 'AB' },
  { key: 'kontanter', label: 'Kontanter' }, { key: 'other', label: 'Övrigt' },
];
export function nwCatOf(a: Obj) {
  if (a.nw_cat !== undefined) return a.nw_cat || null;
  return a.kind === 'investment' ? 'stocks' : a.kind === 'card' ? null : 'cash';
}
// Senaste värde på eller före datum ur rader {date|bal_date|val_date, value}
export function valueAt(rows: Obj[], date: string) {
  let best: Obj | null = null;
  for (const r of rows) {
    const d = r.date || r.bal_date || r.val_date;
    if (d && d <= date && (!best || d > best.date)) best = { date: d, value: Number(r.value) };
  }
  return best;
}

export function computeNetWorth(p: { accounts: Obj[]; balances: Obj[]; assets: Obj[]; loans: Obj[]; cats?: Obj[]; prev?: Obj | null; date: string }) {
  const cats = p.cats?.length ? p.cats : DEF_NW_CATS;
  const amounts: Obj = {}, sources: Obj = {}, detail: Obj[] = [];
  for (const c of cats) amounts[c.key] = 0;
  const src = (k: string, s: string) => { sources[k] = sources[k] ? (sources[k].includes(s) ? sources[k] : sources[k] + '+' + s) : s; };
  for (const a of p.accounts || []) {
    const k = nwCatOf(a); if (!k || !(k in amounts)) continue;
    const b = valueAt(p.balances.filter((x) => x.account === a.id), p.date) || (a.balance && a.balance.date <= p.date ? a.balance : null);
    if (!b) continue;
    amounts[k] += Number(b.value); src(k, 'konton'); detail.push({ kind: 'account', id: a.id, name: a.name, cat: k, value: Number(b.value), date: b.date });
  }
  const byAsset: Obj = {};
  for (const r of p.assets || []) if (!r.deleted) (byAsset[r.asset] ||= []).push(r);
  for (const [k, rows] of Object.entries(byAsset) as [string, Obj[]][]) {
    if (!(k in amounts)) continue;
    const v = valueAt(rows, p.date); if (!v) continue;
    amounts[k] += v.value; src(k, 'värde'); detail.push({ kind: 'asset', cat: k, value: v.value, date: v.date });
  }
  for (const l of p.loans || []) {
    const d = valueAt(l.history || [], p.date); if (!d) continue;
    const k = l.secured_by && l.secured_by in amounts ? l.secured_by : 'other' in amounts ? 'other' : cats[0].key;
    amounts[k] -= d.value; src(k, 'lån'); detail.push({ kind: 'loan', id: l.id, name: l.name, cat: k, value: -d.value, date: d.date });
  }
  for (const c of cats) if (!sources[c.key] && p.prev && p.prev[c.key] != null) { amounts[c.key] = Number(p.prev[c.key]); sources[c.key] = 'förra'; }
  for (const k of Object.keys(amounts)) amounts[k] = Math.round(amounts[k] * 100) / 100;
  const total = Math.round(Object.values(amounts).reduce((s: number, v: any) => s + v, 0) * 100) / 100;
  return { date: p.date, amounts, total, sources, detail };
}

// Avkastning på ett investeringskonto kopplat till en sparkategori (sav_cat): senaste värde − första värde −
// insättningar däremellan (sparande i kategorin; uttag är negativt sparande)
export function accountReturn(a: Obj, balances: Obj[], txs: Obj[]) {
  const rows = balances.filter((x) => x.account === a.id).map((x) => ({ date: x.bal_date || x.date, value: Number(x.value) })).sort((x, y) => x.date.localeCompare(y.date));
  if (!a.sav_cat || rows.length < 1) return null;
  const first = rows[0], last = rows[rows.length - 1];
  const deposits = txs.filter((t) => t.type === 'savings' && (t.category ?? t.cat) === a.sav_cat && (t.tx_date ?? t.date) > first.date && (t.tx_date ?? t.date) <= last.date)
    .reduce((s, t) => s + Number(t.amount), 0);
  return { from: first.date, to: last.date, start: first.value, value: last.value, deposits: Math.round(deposits), return: Math.round(last.value - first.value - deposits) };
}

// ── Vad förändringen består av (mellan två förmögenhetsbilder) ─────────
// Förmögenhetsbilden för P = läget när P börjar, så förändringen P → nästa bild beror på perioderna däremellan.
//  sparande   = sparandetransaktioner i perioderna (utom kategorin Amortering)
//  amortering = lånens minskade skuld mellan datumen; saknas skuldhistorik: sparkategorin Amortering
//  avkastning = förändring i aktier/fonder + pension − insättningar dit (sparkategorier kopplade till
//               investeringskonton, t.ex. Avanza) − kända pensionsinbetalningar
//  omvärdering= förändring i övriga tillgångar (lägenhet, klockor, AB …) − amorteringen (lånen hör till dem)
//  övrigt     = resten (t.ex. pengar som blev kvar eller togs från bufferten), så att summan stämmer exakt
export const LIQUID = ['cash', 'kontanter'], INVEST = ['stocks', 'pension'];
export const AMORT_CAT = 'Amortering';
export function decompose(p: { snaps: Obj[]; txs: Obj[]; loans: Obj[]; starts: Obj; investCats: string[]; pensionPerMonth?: number }) {
  const snaps = [...p.snaps].sort((a, b) => a.period.localeCompare(b.period));
  const steps: Obj[] = [];
  const amt = (s: Obj, k: string) => Number((s.amounts || s)[k] || 0);
  const keys = (s: Obj) => Object.keys(s.amounts || s).filter((k) => !['period', 'total', 'auto'].includes(k));
  for (let i = 1; i < snaps.length; i++) {
    const A = snaps[i - 1], B = snaps[i];
    const months = p.txs.filter((t) => t.month >= A.period && t.month < B.period);
    const sav = (f: (t: Obj) => boolean) => Math.round(months.filter((t) => t.type === 'savings' && f(t)).reduce((s, t) => s + Number(t.amount), 0));
    const cat = (t: Obj) => t.category ?? t.cat;
    const sparande = sav((t) => cat(t) !== AMORT_CAT);
    const dA = p.starts[A.period], dB = p.starts[B.period];
    let amortering = 0, fromLoans = false;
    if (dA && dB) for (const l of p.loans) {
      const a = valueAt(l.history || [], dA), b = valueAt(l.history || [], dB);
      if (a && b && a.date >= (l.history?.[0]?.date || '') && a.date !== b.date) { amortering += a.value - b.value; fromLoans = true; }
    }
    if (!fromLoans) amortering = sav((t) => cat(t) === AMORT_CAT);
    amortering = Math.round(amortering);
    const nMonths = new Set(months.map((t) => t.month)).size || 1;
    const deposits = sav((t) => p.investCats.includes(cat(t))) + Math.round((p.pensionPerMonth || 0) * nMonths);
    const inv = (s: Obj) => INVEST.reduce((x, k) => x + amt(s, k), 0);
    const avkastning = Math.round(inv(B) - inv(A) - deposits);
    const manual = [...new Set([...keys(A), ...keys(B)])].filter((k) => !LIQUID.includes(k) && !INVEST.includes(k));
    const omvardering = Math.round(manual.reduce((x, k) => x + amt(B, k) - amt(A, k), 0) - amortering);
    const change = Math.round(Number(B.total) - Number(A.total));
    const ovrigt = change - sparande - amortering - avkastning - omvardering;
    steps.push({ from: A.period, to: B.period, start: Math.round(Number(A.total)), end: Math.round(Number(B.total)), change, sparande, amortering, avkastning, omvardering, ovrigt });
  }
  const sum = (k: string) => steps.reduce((s, x) => s + x[k], 0);
  const total = steps.length ? { from: steps[0].from, to: steps[steps.length - 1].to, start: steps[0].start, end: steps[steps.length - 1].end, change: sum('change'),
    sparande: sum('sparande'), amortering: sum('amortering'), avkastning: sum('avkastning'), omvardering: sum('omvardering'), ovrigt: sum('ovrigt') } : null;
  return { steps, total };
}
