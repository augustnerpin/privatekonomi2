// Nattens notis: en sammanfattning av det som hänt, högst en gång per händelse (nyckel i tabellen notifications).
// Ren logik utan nätverk (testas i supabase/tests/notify.test.mjs).
// deno-lint-ignore-file no-explicit-any
import { type Obj, dayDiff, addBankDays, addDays } from '../_shared/finance.ts';

const kr = (n: number) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(n)).replace(/[  ]/g, ' ').replace(/−/g, '-') + ' kr';
const BIG = 1500; // köp från och med detta belopp nämns var för sig

// in: newRows = nya bankrader (som i transactions), spent = {kategori: förbrukat i perioden}, budgets = cat_budgets,
//     period = {id, start, end}, today = 'YYYY-MM-DD', conns = bankkopplingar, sent = redan skickade nycklar
// Plan mot måldatum (samma som goalPlan i appen): diff > 0 = före plan, null = nås inte i nuvarande takt
export function goalPlan(latest: Obj | null, goal: number, avgMonthly: number | null, goalYM: string) {
  if (!latest || !/^\d{4}-\d{2}$/.test(goalYM || '')) return null;
  const [gy, gm] = goalYM.split('-').map(Number), [ly, lm] = String(latest.period).split('-').map(Number);
  const months = (gy - ly) * 12 + (gm - lm) + 1, left = Math.max(goal - Number(latest.total), 0); // innevarande period räknas med
  if (left <= 0) return { done: true, months, left: 0 };
  if (months <= 0) return { late: true, months, left };
  const eta = avgMonthly && avgMonthly > 0 ? Math.ceil(left / avgMonthly) : null;
  return { months, left, need: left / months, eta, diff: eta != null ? months - eta : null };
}

export function buildDigest(p: { newRows: Obj[]; spent: Obj; budgets: Obj; period: Obj; today: string; conns: Obj[]; sent: Set<string>; loans?: Obj[]; goal?: Obj; pace?: Obj | null; missing?: Obj[]; salaryDate?: string | null; stale?: Obj[]; watch?: Obj[] }) {
  const items: Obj[] = [];
  const add = (key: string, line: string, kind: string) => { if (!p.sent.has(key)) items.push({ key, line, kind }); };
  const rows = p.newRows.filter((r) => !r.deleted);

  for (const r of rows) if (r.type === 'income' && r.category === 'Lön') add(`lon:${r.id}`, `💰 Lönen har kommit: ${kr(r.amount)}`, 'salary');
  const exp = rows.filter((r) => r.type === 'expense' && r.amount > 0);
  if (exp.length) add(`dag:${p.today}`, `🧾 ${exp.length} ${exp.length === 1 ? 'nytt köp' : 'nya köp'} för ${kr(exp.reduce((s, r) => s + r.amount, 0))}`, 'day');
  for (const r of exp.filter((r) => r.amount >= BIG).sort((a, b) => b.amount - a.amount).slice(0, 2))
    add(`stort:${r.id}`, `Stort köp: ${kr(r.amount)} – ${r.description || r.category}`, 'big');
  const review = rows.filter((r) => r.extra?.review).length;
  // Prishöjningar, nya abonnemang och dubbeldragningar (watch.ts)
  for (const w of p.watch || []) add(w.key, w.line, w.kind);
  if (review) add(`granska:${p.today}`, `🔎 ${review} ${review === 1 ? 'rad' : 'rader'} att granska i appen`, 'review');

  // Budgettakt: 80 % förbrukat klart före tiden, eller över budget (en gång per kategori och nivå och period)
  const total = Math.max(1, dayDiff(p.period.start, p.period.end) + 1), gone = Math.min(1, (dayDiff(p.period.start, p.today) + 1) / total);
  for (const [cat, budget] of Object.entries(p.budgets || {})) {
    const b = Number(budget), s = Number(p.spent[cat] || 0); if (!(b > 0)) continue;
    const day = Math.round(dayDiff(p.period.start, p.today)) + 1;
    if (s > b) add(`budget:${p.period.id}:${cat}:over`, `⚠️ ${cat}: ${kr(s)} av ${kr(b)} – över budget`, 'budget');
    else if (s >= 0.8 * b && s / b > gone + 0.2) add(`budget:${p.period.id}:${cat}:80`, `⚠️ ${cat}: ${kr(s)} av ${kr(b)} redan dag ${day}`, 'budget');
  }
  // BankID-samtycket
  for (const c of p.conns) {
    const days = Math.floor((Date.parse(c.valid_until) - Date.parse(p.today + 'T12:00:00Z')) / 864e5);
    if (c.status === 'expired' || days < 0) add(`samtycke:${c.id}:ute`, `🏦 ${c.aspsp}: samtycket har gått ut – förnya med BankID i inställningar`, 'consent');
    else if (days <= 3) add(`samtycke:${c.id}:3`, `🏦 ${c.aspsp}: samtycket går ut om ${days} dagar – förnya i inställningar`, 'consent');
    else if (days <= 14) add(`samtycke:${c.id}:14`, `🏦 ${c.aspsp}: samtycket går ut om ${days} dagar`, 'consent');
  }
  // Bolånet: villkorsändringsdag eller slut på bindningstiden om 30 respektive 7 dagar
  for (const l of p.loans || []) {
    const x = l.extra || {};
    for (const [date, what] of [[x.rate_change_date, 'villkorsändring'], [x.rate_type === 'bunden' ? x.fixed_until : null, 'bindningstiden går ut']] as [string, string][]) {
      if (!date) continue;
      const days = Math.round(dayDiff(p.today, date)) * (date >= p.today ? 1 : -1);
      if (days < 0 || days > 30) continue;
      const step = days <= 7 ? 7 : 30;
      add(`lan:${l.id}:${date}:${step}`, `🏠 ${l.name}: ${what} ${date} (om ${days} ${days === 1 ? 'dag' : 'dagar'}) – dags att jämföra räntor`, 'loan');
    }
  }
  // Förväntade transaktioner som uteblivit (en gång per period)
  // Autogiro till Avanza (grace_bank_days): "Autogiro 10 000 kr till Fondkonto har inte dragits. Saldo på Lönekonto: 8 446 kr."
  for (const e of p.missing || []) add(`forvantad:${e.id}:${p.period.id}`, e.grace_bank_days != null ? `⏰ ${e.name} har inte dragits.${e.from_name && e.balance != null ? ` Saldo på ${e.from_name}: ${kr(e.balance)}.` : ''}`
    : e.due_day ? `⏰ ${e.name} har inte kommit – skulle senast den ${e.due_day}:e` : `⏰ ${e.name} har inte kommit – ${Math.round(dayDiff(e.salary, p.today))} dagar sedan lönen`, 'expected');
  // Lönen har kommit men värdet på t.ex. Avanza har inte uppdaterats sedan dess (en gång per period)
  if (p.salaryDate && (p.stale || []).length) add(`uppdatera:${p.period.id}`, `📈 Lönen har kommit – uppdatera ${p.stale!.map((x: Obj) => `${x.name}${x.date ? ` (senast ${x.date})` : ''}`).join(', ')}`, 'update');
  // Takt: klart mer utgifter än vanligt vid samma dag i perioden (högst en gång per vecka)
  if (p.pace && p.pace.day >= 5 && p.pace.cur > p.pace.avg * 1.25 && p.pace.cur - p.pace.avg >= 1000)
    add(`takt:${p.period.id}:${Math.floor((p.pace.day - 1) / 7)}`, `📈 ${kr(p.pace.cur)} i utgifter hittills, ${kr(p.pace.cur - p.pace.avg)} mer än vanligt vid dag ${p.pace.day}`, 'pace');
  // Förmögenhetsmålet: säg till en gång per löneperiod om du ligger efter planen
  if (p.goal) {
    const g = goalPlan(p.goal.latest, p.goal.target, p.goal.avg, p.goal.date);
    if (g && !g.done && !g.late && (g.diff == null || g.diff < 0))
      add(`mal:${p.period.id}`, `🎯 Målet ${kr(p.goal.target)} till ${p.goal.date}: behöver +${kr(g.need!)}/mån, snittet är ${kr(p.goal.avg || 0)}/mån`, 'goal');
  }
  if (!items.length) return null;
  const order = ['salary', 'dup', 'expected', 'price', 'newsub', 'update', 'budget', 'pace', 'goal', 'loan', 'consent', 'big', 'day', 'review'];
  items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const title = items[0].kind === 'salary' ? 'Lönen har kommit' : items[0].kind === 'dup' ? 'Möjlig dubbeldragning' : items.some((i) => i.kind === 'budget' || i.kind === 'pace') ? 'Koll på budgeten' : items[0].kind === 'expected' ? 'Något har inte kommit' : items[0].kind === 'price' ? 'Något har blivit dyrare' : items[0].kind === 'newsub' ? 'Nytt abonnemang?' : items[0].kind === 'loan' ? 'Ditt bolån' : items[0].kind === 'consent' ? 'Bankkopplingen' : 'Din ekonomi idag';
  const lines = items.slice(0, 4).map((i) => i.line);
  if (items.length > 4) lines.push(`+ ${items.length - 4} till i appen`);
  return { title, body: lines.join('\n'), keys: items.map((i) => i.key), items };
}

// Förväntade transaktioner (expected_tx): [{id, name, type, cat, match?, days | due_day}]. Fönstret är antingen
// `days` dagar efter att lönen kom in i perioden, eller en fast dag i månaden (`due_day`, t.ex. 28 = "senast den 28:e";
// första gången den dagen infaller i perioden, klämd till månadens sista dag). Returnerar de som uteblivit.
// Autogiron från Avanza-bilden (source 'avanza') har dessutom grace_bank_days (notis först när så många bankdagar gått
// efter dagen), amount (dragningen ska vara samma belopp, ±1 kr), types (sparande eller överföring) och match ('avanza').
export function dueDateIn(periodStart: string, dueDay: number) {
  const [y, m] = periodStart.split('-').map(Number);
  const at = (yy: number, mm: number) => { const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate(); return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(dueDay, last)).padStart(2, '0')}`; };
  const d = at(y, m);
  return d >= periodStart ? d : m === 12 ? at(y + 1, 1) : at(y, m + 1);
}
export function missingExpected(expected: Obj[], rows: Obj[], today: string, periodStart?: string) {
  const live = rows.filter((r) => !r.deleted);
  const salary = live.filter((r) => r.type === 'income' && (r.category ?? r.cat) === 'Lön').map((r) => r.tx_date ?? r.date).sort()[0];
  return (expected || []).filter((e) => e && e.enabled !== false).map((e) => {
    let due: string | null = null;
    if (e.due_day && periodStart) due = dueDateIn(periodStart, Number(e.due_day));
    else if (!e.due_day && salary) due = new Date(Date.parse(salary + 'T00:00:00Z') + (Number(e.days) || 5) * 864e5).toISOString().slice(0, 10);
    const day = due;
    if (due && e.grace_bank_days != null) { due = addBankDays(due, Number(e.grace_bank_days)); if (today <= due) return null; }
    if (!due || today < due) return null;
    const q = String(e.match || '').toLowerCase(), types: string[] = Array.isArray(e.types) ? e.types : [e.type];
    const hit = live.some((r) => types.includes(r.type) && (!e.cat || (r.category ?? r.cat) === e.cat) && (!q || String(r.description ?? r.desc ?? '').toLowerCase().includes(q))
      && (e.amount == null || Math.abs(Math.abs(Number(r.amount)) - Number(e.amount)) <= 1) && (e.grace_bank_days == null || !day || (r.tx_date ?? r.date) >= addDays(day, -3)));
    return hit ? null : { ...e, salary: salary || null, due, ...(e.grace_bank_days != null ? { scheduled: day } : {}) };
  }).filter(Boolean) as Obj[];
}
