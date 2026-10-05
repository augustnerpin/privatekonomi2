// Nattens vakt: prishöjningar, nya abonnemang och möjliga dubbeldragningar, plus AI-texten till notisen.
// Ren logik utan nätverk (testas i supabase/tests/watch.test.mjs). rows = transaktioner som i tabellen
// (id, type, category, amount, description, tx_date, month, mkey, account, extra); utgift positivt = pengar ut.
// deno-lint-ignore-file no-explicit-any
import { type Obj, merchantBase, periodShift, dayDiff, PENDING_CARD_CAT } from '../_shared/finance.ts';

const kr = (n: number) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(n)).replace(/[  ]/g, ' ').replace(/−/g, '-') + ' kr';
const keyOf = (r: Obj) => (r.mkey ? String(r.mkey).split('|')[0] : merchantBase(r.description || r.category));
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const isExp = (r: Obj) => !r.deleted && r.type === 'expense' && Number(r.amount) > 0 && r.category !== PENDING_CARD_CAT;

// Butik → {namn, kategori, dragningar per period} för perioden pid och de sex före
function byMerchant(rows: Obj[], pid: string) {
  const periods = [0, 1, 2, 3, 4, 5, 6].map((i) => periodShift(pid, -i));
  const by: Obj = {};
  for (const r of rows.filter(isExp)) {
    const k = keyOf(r), m = by[k] ||= { key: k, name: r.description || r.category, cat: r.category, per: {} as Obj, first: r.month };
    if (r.month < m.first) m.first = r.month;
    if (r.month === pid) { m.name = r.description || m.name; m.cat = r.category; }
    if (periods.includes(r.month)) (m.per[r.month] ||= []).push(Number(r.amount));
  }
  return { by, periods };
}

// Fast kostnad som blivit dyrare: minst tre av de sex tidigare perioderna med ungefär samma belopp och högst
// ~en dragning per period (som detectRecurring i appen), och en enda dragning i perioden som är minst 10 % och 10 kr dyrare.
export function priceHikes(rows: Obj[], pid: string) {
  const { by, periods } = byMerchant(rows, pid), out: Obj[] = [];
  for (const m of Object.values(by) as Obj[]) {
    const hist = periods.slice(1).filter((p) => m.per[p]), cur = m.per[pid];
    if (hist.length < 3 || !cur || cur.length !== 1) continue;
    if (hist.reduce((s: number, p: string) => s + m.per[p].length, 0) / hist.length > 1.6) continue;
    const vals = hist.map((p: string) => m.per[p].reduce((a: number, b: number) => a + b, 0)), med = median(vals);
    if (vals.filter((v: number) => v >= med * 0.6 && v <= med * 1.6).length < vals.length - 1) continue;
    if (cur[0] > med * 1.1 && cur[0] - med >= 10) out.push({ key: m.key, name: m.name, cat: m.cat, typical: Math.round(med), current: Math.round(cur[0]) });
  }
  return out.sort((a, b) => (b.current - b.typical) - (a.current - a.typical));
}

// Nytt abonnemang: samma regler som detectNewSubs i appen. Ungefär samma belopp en gång i perioden och en gång
// i perioden före, aldrig tidigare; eller första dragningen någonsin i kategorin Prenumerationer.
export function newSubscriptions(rows: Obj[], pid: string) {
  const { by, periods } = byMerchant(rows, pid), out: Obj[] = [];
  for (const m of Object.values(by) as Obj[]) {
    const cur = m.per[pid], prev = m.per[periods[1]];
    if (!cur || cur.length !== 1 || !(cur[0] >= 20)) continue;
    if (m.first === pid && m.cat === 'Prenumerationer') { out.push({ key: m.key, name: m.name, cat: m.cat, amount: Math.round(cur[0]), why: 'first' }); continue; }
    if (!prev || prev.length !== 1 || periods.slice(2).some((p) => m.per[p]) || m.first < periods[1]) continue;
    if (Math.abs(cur[0] - prev[0]) > Math.max(cur[0], prev[0]) * 0.15) continue;
    out.push({ key: m.key, name: m.name, cat: m.cat, amount: Math.round(cur[0]), why: 'twice' });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

// Möjliga dubbeldragningar: en ny rad med samma butik, konto och belopp (minst 100 kr) som en annan rad inom två dagar
export function duplicateCharges(newRows: Obj[], recent: Obj[]) {
  const out: Obj[] = [], seen = new Set<string>();
  const pool = [...recent.filter(isExp), ...newRows.filter(isExp)];
  for (const a of newRows.filter(isExp)) {
    if (Number(a.amount) < 100) continue;
    const b = pool.find((x) => x.id !== a.id && x.account === a.account && keyOf(x) === keyOf(a) && Math.abs(Number(x.amount) - Number(a.amount)) < 0.005
      && Math.abs(dayDiff(x.tx_date, a.tx_date)) <= 2);
    if (!b) continue;
    const ids = [a.id, b.id].sort((x, y) => Number(x) - Number(y)), k = ids.join(':');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ids, name: a.description || a.category, amount: Number(a.amount), dates: [b.tx_date, a.tx_date].sort() });
  }
  return out;
}

// Notisrader i buildDigest-format. seen = sub_seen i appen ({butik: belopp} som användaren redan sagt OK till).
export function watchItems(p: { rows: Obj[]; newRows: Obj[]; pid: string; seen?: Obj }) {
  const items: Obj[] = [], seen = p.seen || {};
  for (const d of duplicateCharges(p.newRows, p.rows))
    items.push({ key: `dubbel:${d.ids.join(':')}`, line: `🔁 Dubbeldragning? ${d.name} ${kr(d.amount)} två gånger (${d.dates.join(' och ')})`, kind: 'dup' });
  for (const h of priceHikes(p.rows, p.pid)) if (seen[h.key] !== h.current)
    items.push({ key: `pris:${h.key}:${p.pid}`, line: `📈 ${h.name} har blivit dyrare: ${kr(h.current)} (brukar vara ${kr(h.typical)}) – ${kr((h.current - h.typical) * 12)} mer per år`, kind: 'price' });
  for (const n of newSubscriptions(p.rows, p.pid)) if (seen[n.key] == null)
    items.push({ key: `nyabo:${n.key}`, line: n.why === 'first' ? `🆕 Nytt abonnemang? ${n.name} ${kr(n.amount)} (${kr(n.amount * 12)}/år)` : `🆕 Ny återkommande kostnad: ${n.name} ${kr(n.amount)} två månader i rad (${kr(n.amount * 12)}/år)`, kind: 'newsub' });
  return items;
}

// ── AI-texten till notisen ──────────────────────────────────────────────
// Modellen får nattens händelser (redan framräknade) och skriver om dem till en kort notis med det viktigaste
// först. Den får inte hitta på något: varje tal i svaret måste finnas i underlaget, annars används regeltexten.
export const DIGEST_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'body'],
  properties: { title: { type: 'string', description: 'Max 40 tecken' }, body: { type: 'string', description: 'Max 3 korta rader' } },
};
export function digestPrompt(profile = '') {
  return `Du skriver kvällens/nattens push-notis i en svensk privatekonomiapp. Du får händelser som appen redan räknat fram, en per rad, i ungefärlig viktordning.
- Välj det som är viktigast för användaren just nu och lägg det först: pengar som kan vara fel (dubbeldragning, prishöjning, saknad dragning) och budget som spräcks väger tyngst; rutin (dagens köp) minst.
- title: max 40 tecken, säger det viktigaste. body: högst 3 korta rader, rak och vänlig svenska, gärna en konkret åtgärd ("kolla i appen", "säg upp eller förhandla").
- Använd bara belopp, datum och namn som står i händelserna. Räkna inte om, avrunda inte och hitta inte på något. Säg "+ fler i appen" om du utelämnar något viktigt.
- Ingen emoji i title; högst en per rad i body.${profile ? `\nOm användaren: ${profile}` : ''}`;
}
// Tal i texten (1 234 kr, 2026-10-04, 12 %) jämförs som siffersträngar
const nums = (s: string) => (String(s).replace(/(\d)[  ](?=\d{3}\b)/g, '$1').match(/\d+/g) || []).filter((n) => n.length >= 2);
export function checkAiDigest(ai: Obj | null, items: Obj[]) {
  if (!ai || typeof ai.title !== 'string' || typeof ai.body !== 'string') return null;
  const title = ai.title.trim().slice(0, 60), body = ai.body.trim().split('\n').slice(0, 4).join('\n').slice(0, 300);
  if (!title || !body) return null;
  const facts = new Set(nums(items.map((i) => i.line).join('\n')));
  if (nums(title + '\n' + body).some((n) => !facts.has(n))) return null;
  return { title, body };
}
