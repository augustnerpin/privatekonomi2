// Månadsbokslut, veckobrev och spenderingstakt: underlag som räknas fram på servern och skickas till AI:n.
// Ren logik utan nätverk (testas i supabase/tests/review.test.mjs). rows = transaktioner som i tabellen
// (type, category, amount, description, tx_date, month); expense/savings positivt = pengar ut.
// deno-lint-ignore-file no-explicit-any
import { type Obj, addDays, dayDiff, periodShift } from '../_shared/finance.ts';

const r0 = (n: number) => Math.round(n);
const sumType = (rows: Obj[], t: string) => rows.filter((r) => r.type === t).reduce((s, r) => s + Number(r.amount), 0);

// Underlag för en löneperiods bokslut: totaler, kategorier mot snittet av de tre föregående perioderna och budget
export function periodFacts(rows: Obj[], pid: string, budgets: Obj = {}) {
  const cur = rows.filter((r) => r.month === pid);
  const prev = [1, 2, 3].map((i) => periodShift(pid, -i)).filter((p) => rows.some((r) => r.month === p));
  const inc = sumType(cur, 'income'), exp = sumType(cur, 'expense'), sav = sumType(cur, 'savings');
  const cats: Obj = {};
  for (const r of cur.filter((r) => r.type === 'expense')) cats[r.category] = (cats[r.category] || 0) + Number(r.amount);
  const avg: Obj = {};
  for (const p of prev) for (const r of rows.filter((r) => r.month === p && r.type === 'expense')) avg[r.category] = (avg[r.category] || 0) + Number(r.amount) / prev.length;
  const names = [...new Set([...Object.keys(cats), ...Object.keys(avg), ...Object.keys(budgets)])];
  const by_category = names.map((c) => ({ category: c, spent: r0(cats[c] || 0), avg3: prev.length ? r0(avg[c] || 0) : null, budget: budgets[c] ? r0(budgets[c]) : null }))
    .filter((c) => c.spent || c.avg3 || c.budget).sort((a, b) => b.spent - a.spent);
  const prevExp = prev.length ? prev.reduce((s, p) => s + sumType(rows.filter((r) => r.month === p), 'expense'), 0) / prev.length : null;
  const top = cur.filter((r) => r.type === 'expense' && Number(r.amount) > 0).sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 8)
    .map((r) => ({ date: r.tx_date, description: r.description, category: r.category, amount: r0(Number(r.amount)) }));
  return {
    period: pid, transactions: cur.length, income: r0(inc), expense: r0(exp), savings: r0(sav), left: r0(inc - exp - sav),
    savings_rate_pct: inc > 0 ? Math.round((sav / inc) * 100) : null, expense_avg3: prevExp != null ? r0(prevExp) : null,
    by_category, top_expenses: top,
  };
}

// Veckans underlag: senaste 7 dagarna mot snittet för de fyra veckorna innan
export function weekFacts(rows: Obj[], today: string) {
  const from = addDays(today, -7), before = addDays(today, -35);
  const exp = rows.filter((r) => r.type === 'expense');
  const week = exp.filter((r) => r.tx_date >= from && r.tx_date < today);
  const earlier = exp.filter((r) => r.tx_date >= before && r.tx_date < from);
  const cats: Obj = {}; for (const r of week) cats[r.category] = (cats[r.category] || 0) + Number(r.amount);
  const usual: Obj = {}; for (const r of earlier) usual[r.category] = (usual[r.category] || 0) + Number(r.amount) / 4;
  return {
    from, to: addDays(today, -1), spent: r0(week.reduce((s, r) => s + Number(r.amount), 0)), usual_week: r0(earlier.reduce((s, r) => s + Number(r.amount), 0) / 4),
    by_category: Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, v]) => ({ category: c, spent: r0(v), usual: r0(usual[c] || 0) })),
    top: week.filter((r) => Number(r.amount) > 0).sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 5).map((r) => ({ date: r.tx_date, description: r.description, amount: r0(Number(r.amount)) })),
  };
}

// Spenderingstakt: utgifter hittills i perioden mot snittet för samma antal dagar i de tre föregående perioderna.
// starts = {period: startdatum}. Returnerar null om underlag saknas.
export function pace(rows: Obj[], pid: string, starts: Obj, today: string) {
  const day = Math.round(dayDiff(starts[pid], today)) + 1;
  const upTo = (p: string) => rows.filter((r) => r.month === p && r.type === 'expense' && dayDiff(starts[p], r.tx_date) < day && r.tx_date >= starts[p])
    .reduce((s, r) => s + Number(r.amount), 0);
  const prev = [1, 2, 3].map((i) => periodShift(pid, -i)).filter((p) => starts[p] && rows.some((r) => r.month === p));
  if (!prev.length || day < 1) return null;
  const avg = prev.reduce((s, p) => s + upTo(p), 0) / prev.length;
  return { day, cur: r0(upTo(pid)), avg: r0(avg) };
}

// Systemprompt för bokslutet
export function closingPrompt(ctx: { profile: string; memory: string[]; goal: string; previous: Obj | null }) {
  return `Du är användarens personliga ekonomicoach och skriver MÅNADSBOKSLUT för en avslutad löneperiod. Svenska, konkret, ärligt och uppmuntrande, utan floskler. Siffrorna i underlaget är facit; hitta aldrig på belopp.
- grade: A (mycket bra) till E (dåligt), utifrån sparande, budget och utveckling mot mål och snitt.
- headline: en mening (max 90 tecken). summary: 2–3 meningar om hur perioden gick.
- wins och concerns: högst 3 var, korta och specifika (kategori + belopp).
- actions: exakt 3 konkreta åtgärder för nästa period, var och en med mätbart mål (target, t.ex. "Mat (Ute) under 2 000 kr").
- followup: om förra bokslutets åtgärder finns — bedöm var och en (gjort/delvis/inte) med en kort kommentar utifrån siffrorna. Annars tom lista.
Överföringar räknas inte. "AMEX (väntande)" är kortköp som ännu inte importerats från AMEX-fakturan.${ctx.profile ? `\n\nPROFIL:\n${ctx.profile}` : ''}${ctx.memory.length ? `\n\nVAD DU VET OM ANVÄNDAREN:\n${ctx.memory.join('\n')}` : ''}${ctx.goal ? `\n\nMÅL: ${ctx.goal}` : ''}${ctx.previous ? `\n\nFÖRRA BOKSLUTETS ÅTGÄRDER (${ctx.previous.period}):\n${(ctx.previous.actions || []).map((a: Obj) => `- ${a.title}: ${a.target}`).join('\n')}` : ''}`;
}
export const CLOSING_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['grade', 'headline', 'summary', 'wins', 'concerns', 'actions', 'followup'],
  properties: {
    grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E'] }, headline: { type: 'string' }, summary: { type: 'string' },
    wins: { type: 'array', items: { type: 'string' } }, concerns: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'detail', 'target'], properties: { title: { type: 'string' }, detail: { type: 'string' }, target: { type: 'string' } } } },
    followup: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['action', 'result', 'comment'], properties: { action: { type: 'string' }, result: { type: 'string', enum: ['gjort', 'delvis', 'inte'] }, comment: { type: 'string' } } } },
  },
};
export const WEEKLY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'body', 'tip'],
  properties: { title: { type: 'string' }, body: { type: 'string' }, tip: { type: 'string' } },
};
export function weeklyPrompt(ctx: { profile: string; goal: string; closing: Obj | null }) {
  return `Du skriver ett kort VECKOBREV om användarens ekonomi (svenska, personligt, max 4 meningar i body). title: max 50 tecken. body: hur veckan gick jämfört med en vanlig vecka, med 1–2 konkreta siffror. tip: ett konkret tips för kommande vecka (max 1 mening), gärna kopplat till månadens åtgärder. Hitta aldrig på belopp.${ctx.profile ? `\n\nPROFIL:\n${ctx.profile}` : ''}${ctx.goal ? `\n\nMÅL: ${ctx.goal}` : ''}${ctx.closing ? `\n\nMÅNADENS ÅTGÄRDER:\n${(ctx.closing.actions || []).map((a: Obj) => `- ${a.title}: ${a.target}`).join('\n')}` : ''}`;
}

// Profilen som text (samma sektioner som appen)
export function profileText(p: Obj | null) {
  if (!p || typeof p !== 'object') return '';
  return Object.entries(p).filter(([k, v]) => k !== 'updated' && v && typeof v === 'object')
    .map(([k, v]) => `${k}: ${Object.entries(v as Obj).map(([f, x]) => `${f}=${x}`).join('; ')}`).join('\n');
}
