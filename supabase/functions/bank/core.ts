// Bankkoppling: tolkning, dubblettkontroll och kategorisering av transaktioner från Enable Banking.
// Ren logik utan Deno/nätverk, så att den kan testas i Node (supabase/tests/bank.test.mjs).
// deno-lint-ignore-file no-explicit-any
import { type Obj, CAT_KEY, DEF, TYPES, addDays, dayDiff, mkeyFor, periodForDate, autoCat, fallbackCat, storedAmount, today } from '../_shared/finance.ts';

// Bokfört saldo i första hand (som i bankens app), annars disponibelt
const BALANCE_ORDER = ['CLBD', 'ITBD', 'XPCD', 'ITAV', 'CLAV', 'OTHR'];
export function pickBalance(balances: Obj[] = []) {
  const sorted = [...balances].sort((a, b) => {
    const ia = BALANCE_ORDER.indexOf(a.balance_type), ib = BALANCE_ORDER.indexOf(b.balance_type);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const b = sorted[0]; if (!b) return null;
  const value = Number(b.balance_amount?.amount); if (!isFinite(value)) return null;
  return { value, date: b.reference_date || today() };
}

// Bankens transaktion → rad med bankens tecken (ut = negativt), som en rad ur ett kontoutdrag
export function mapTx(t: Obj) {
  const amt = Number(t.transaction_amount?.amount);
  if (!isFinite(amt) || amt === 0) return null;
  const raw = t.credit_debit_indicator === 'DBIT' ? -Math.abs(amt) : Math.abs(amt);
  let date = t.booking_date || t.value_date || t.transaction_date;
  if (!date) return null;
  const party = raw < 0 ? t.creditor?.name : t.debtor?.name;
  let desc = (Array.isArray(t.remittance_information) ? t.remittance_information.join(' ') : String(t.remittance_information || '')) || party || '';
  desc = desc.replace(/\s+/g, ' ').trim();
  // SEB-kortköp: "ICA KVANTUM /24-09-24" — datumet i texten är köpdagen (samma som vid import)
  const m = desc.match(/^(.*?)\s*\/(\d{2})-(\d{2})-(\d{2})$/);
  if (m) { desc = m[1].trim(); const d = `20${m[2]}-${m[3]}-${m[4]}`; if (dayDiff(d, date) <= 10) date = d; }
  const ref = String(t.entry_reference || t.transaction_id || `${date}|${raw}|${desc}`);
  return { ref, date, bookingDate: t.booking_date || date, raw, desc };
}

// Bankens tecken för en rad som redan finns i appen
export const rawOf = (r: Obj) => (r.type === 'income' || r.type === 'transfer' ? Number(r.amount) : -Number(r.amount));

// Matchar nya bankrader mot befintliga rader på samma konto: samma bankreferens, eller samma belopp
// inom ±4 dagar (kontoutdrag som importerats för hand har annan text och ibland annat datum).
// Varje befintlig rad används högst en gång, så två likadana köp samma dag blir båda kvar.
export function dedupe(fresh: Obj[], existing: Obj[]) {
  const refs = new Set(existing.map((r) => r.extra?.bank_ref).filter(Boolean));
  const pool = existing.filter((r) => !r.extra?.bank_ref).map((r) => ({ raw: Math.round(rawOf(r) * 100), date: r.tx_date, used: false }));
  const out: Obj[] = []; let dups = 0;
  for (const t of fresh) {
    if (refs.has(t.ref)) { dups++; continue; }
    const cents = Math.round(t.raw * 100);
    const hit = pool.find((p) => !p.used && p.raw === cents && (dayDiff(p.date, t.date) <= 4 || dayDiff(p.date, t.bookingDate) <= 4));
    if (hit) { hit.used = true; dups++; continue; }
    refs.add(t.ref); out.push(t);
  }
  return { fresh: out, dups };
}

// Hur många av bankkontots rader som redan finns på ett konto i appen (för att hitta rätt konto)
export function overlap(fresh: Obj[], existing: Obj[]) {
  return fresh.length - dedupe(fresh, existing).fresh.length;
}

// Nytt konto i appen för ett bankkonto som inte matchar något befintligt
export function newAppAccount(a: Obj, taken: Set<string>) {
  const num = String(a.account_id?.iban || a.account_id?.other?.identification || a.uid || '').replace(/\s/g, '');
  const last4 = num.slice(-4) || Math.random().toString(36).slice(2, 6);
  let id = `${String(a.aspsp || 'bank').toLowerCase().replace(/[^a-z]/g, '')}_${last4}`;
  while (taken.has(id)) id += 'x';
  const kind = a.cash_account_type === 'SVGS' ? 'savings' : a.cash_account_type === 'CARD' ? 'card' : 'bank';
  const name = `${a.name || a.product || a.aspsp || 'Konto'} ••${last4}`;
  return { id, name, kind, ...(num ? { number: num } : {}) };
}

// Kategorisering: inlärda regler → automatiska regler → AI (ai = async (groups) => items) → gissning
export async function categorize(s: Obj, rows: Obj[], accKind: (acc: string) => string, ai?: (groups: Obj[]) => Promise<Obj[]>) {
  const cats = (t: string) => (s[CAT_KEY[t]] || DEF[CAT_KEY[t]]) as string[];
  const valid = (type: string, cat: string) => TYPES.includes(type) && cats(type).includes(cat);
  const groups: Obj = {};
  for (const r of rows) {
    const mkey = mkeyFor(r.desc, r.raw);
    const k = r.account + '¦' + mkey;
    (groups[k] ||= { key: k, mkey, desc: r.desc, dir: r.raw < 0 ? 'ut' : 'in', accKind: accKind(r.account), rows: [], total: 0 });
    groups[k].rows.push(r); groups[k].total += r.raw;
  }
  const list = Object.values(groups) as Obj[];
  const rules = s.merchant_rules || {};
  const todo: Obj[] = [];
  for (const g of list) {
    const rule = rules[g.mkey];
    if (rule && valid(rule.type, rule.cat)) Object.assign(g, { type: rule.type, cat: rule.cat, conf: 'high', src: 'rule' });
    else { const a = autoCat(s, g); if (a) Object.assign(g, a); else todo.push(g); }
  }
  if (todo.length && ai) {
    try {
      const items = await ai(todo);
      for (const it of items) { const g = todo[it.k]; if (g && valid(it.type, it.cat)) Object.assign(g, { type: it.type, cat: it.cat, conf: it.conf === 'high' ? 'high' : 'low', src: 'ai' }); }
    } catch (e) { console.error('AI-kategorisering misslyckades', e); }
  }
  for (const g of list) if (!g.type) Object.assign(g, fallbackCat(s, g));
  return list;
}

// Rader som ska sparas i transactions (samma form som appens import)
export function toRows(uid: string, groups: Obj[], s: Obj, firstId: number) {
  const out: Obj[] = []; let n = 0;
  for (const g of groups) for (const r of g.rows) {
    out.push({
      user_id: uid, id: firstId + n++, type: g.type, amount: storedAmount(g.type, r.raw), description: r.desc, category: g.cat,
      tx_date: r.date, month: periodForDate(r.date, s.pay_periods || []), account: r.account, source: 'bank', import_id: null,
      hash: 'eb:' + r.ref, mkey: g.mkey, extra: { bank_ref: r.ref, ...(g.conf === 'low' ? { review: true } : {}) }, deleted: false,
    });
  }
  return out;
}

// Säkra regler lärs in, så att samma butik inte behöver AI nästa natt (appen gör likadant vid import)
export function learnRules(s: Obj, groups: Obj[]) {
  const rules = { ...(s.merchant_rules || {}) }; let n = 0;
  for (const g of groups) if (g.src === 'ai' && g.conf === 'high' && !rules[g.mkey]) { rules[g.mkey] = { type: g.type, cat: g.cat, t: Date.now() }; n++; }
  return n ? rules : null;
}

// Från vilket datum transaktioner hämtas: överlapp med förra hämtningen, annars ett år bakåt
export const fetchFrom = (lastDate?: string) => (lastDate ? addDays(lastDate, -7) : addDays(today(), -365));
