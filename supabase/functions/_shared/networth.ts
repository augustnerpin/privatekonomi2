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
