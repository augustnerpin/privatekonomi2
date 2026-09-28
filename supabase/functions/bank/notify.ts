// Nattens notis: en sammanfattning av det som hänt, högst en gång per händelse (nyckel i tabellen notifications).
// Ren logik utan nätverk (testas i supabase/tests/notify.test.mjs).
// deno-lint-ignore-file no-explicit-any
import { type Obj, dayDiff } from '../_shared/finance.ts';

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

export function buildDigest(p: { newRows: Obj[]; spent: Obj; budgets: Obj; period: Obj; today: string; conns: Obj[]; sent: Set<string>; loans?: Obj[]; goal?: Obj; pace?: Obj | null }) {
  const items: Obj[] = [];
  const add = (key: string, line: string, kind: string) => { if (!p.sent.has(key)) items.push({ key, line, kind }); };
  const rows = p.newRows.filter((r) => !r.deleted);

  for (const r of rows) if (r.type === 'income' && r.category === 'Lön') add(`lon:${r.id}`, `💰 Lönen har kommit: ${kr(r.amount)}`, 'salary');
  const exp = rows.filter((r) => r.type === 'expense' && r.amount > 0);
  if (exp.length) add(`dag:${p.today}`, `🧾 ${exp.length} ${exp.length === 1 ? 'nytt köp' : 'nya köp'} för ${kr(exp.reduce((s, r) => s + r.amount, 0))}`, 'day');
  for (const r of exp.filter((r) => r.amount >= BIG).sort((a, b) => b.amount - a.amount).slice(0, 2))
    add(`stort:${r.id}`, `Stort köp: ${kr(r.amount)} – ${r.description || r.category}`, 'big');
  const review = rows.filter((r) => r.extra?.review).length;
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
  const order = ['salary', 'budget', 'pace', 'goal', 'loan', 'consent', 'big', 'day', 'review'];
  items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const title = items[0].kind === 'salary' ? 'Lönen har kommit' : items.some((i) => i.kind === 'budget' || i.kind === 'pace') ? 'Koll på budgeten' : items[0].kind === 'loan' ? 'Ditt bolån' : items[0].kind === 'consent' ? 'Bankkopplingen' : 'Din ekonomi idag';
  const lines = items.slice(0, 4).map((i) => i.line);
  if (items.length > 4) lines.push(`+ ${items.length - 4} till i appen`);
  return { title, body: lines.join('\n'), keys: items.map((i) => i.key) };
}
