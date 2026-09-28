// Förmögenhetsmålet mot plan (samma regler som appen). Perioder = löneperioder 'YYYY-MM'; förmögenhetsbilden för P
// är läget när P börjar, så målet "senast 2027-12" nås vid slutet av 2027-12 och innevarande period räknas med.
//  • krav per månad = (mål − nu) / månader kvar
//  • planlinje: rak linje från bilden när målet sattes (goal_start) till målet vid måldatumets slut
//  • scenarier månad för månad till måldatumet:
//      svagt = snittsparande senaste 12 perioderna, 0 % avkastning
//      plan  = planerat sparande, 6 %/år på aktier/fonder + pension
//      bra   = planerat sparande, 9 %/år
//    Alla scenarier: + amortering (lånens amortering/mån) och kända inbetalningar (known_inflows)
// deno-lint-ignore-file no-explicit-any
import type { Obj } from './finance.ts';

export const monthsBetween = (a: string, b: string) => { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); };
export const addMonths = (ym: string, n: number) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
const INVEST = ['stocks', 'pension'];

// Kända inbetalningar under period p: monthly (från/till) eller engång (date = period)
export function inflowsIn(inflows: Obj[], p: string) {
  let invest = 0, other = 0;
  for (const x of inflows || []) {
    const hit = x.monthly ? (!x.from || p >= x.from) && (!x.to || p <= x.to) : x.date === p;
    if (!hit) continue;
    if (INVEST.includes(x.nw_cat)) invest += Number(x.amount) || 0; else other += Number(x.amount) || 0;
  }
  return { invest, other };
}

export function simulate(p: { latest: Obj; months: number; monthly: number; ratePct: number; amort: number; inflows: Obj[]; goal: number }) {
  const a = p.latest.amounts || p.latest;
  let invest = INVEST.reduce((s, k) => s + (Number(a[k]) || 0), 0), other = Number(p.latest.total) - invest, reached: string | null = null;
  const r = Math.pow(1 + p.ratePct / 100, 1 / 12) - 1;
  const path: Obj[] = [];
  for (let m = 0; m < p.months; m++) {
    const per = addMonths(p.latest.period, m);
    const inf = inflowsIn(p.inflows, per);
    invest = invest * (1 + r) + p.monthly + inf.invest;
    other += p.amort + inf.other;
    const total = invest + other;
    path.push({ period: addMonths(per, 1), value: Math.round(total) }); // läget när nästa period börjar
    if (!reached && total >= p.goal) reached = per;
  }
  return { projected: Math.round(invest + other), reached, path };
}

// goal_start = {period}: förmögenhetsbilden som planen och framsteget räknas från. Totalen läses från bilden varje gång,
// så rättelser av startbilden slår igenom. Äldre goal_start med fryst total används bara om bilden saknas.
export function resolveGoalStart(gs: Obj | null | undefined, snaps: Obj[]) {
  if (!gs || !/^\d{4}-\d{2}$/.test(String(gs.period || ''))) return null;
  const snap = (snaps || []).find((x) => x.period === gs.period && !x.deleted);
  if (snap) return { period: gs.period, total: Number(snap.total), from: 'snapshot' };
  return isFinite(Number(gs.total)) && gs.total != null ? { period: gs.period, total: Number(gs.total), from: 'stored' } : null;
}

// Framsteg = andel av vägen från förmögenheten när målet sattes (start = resolveGoalStart) till målet, inte från 0 kr.
// Under startvärdet = 0 %. Utan start: null (procenten går inte att räkna ut ärligt).
export function goalPct(goal: number, start: Obj | null | undefined, total: number) {
  if (!start || !isFinite(Number(start.total)) || !isFinite(Number(total))) return null;
  const span = goal - Number(start.total), moved = Number(total) - Number(start.total);
  const pct = span > 0 ? Math.min(100, Math.max(0, (moved / span) * 100)) : Number(total) >= goal ? 100 : 0;
  return { progress_pct: Math.round(pct * 10) / 10, start: { period: start.period, total: Number(start.total) }, moved_since_start: Math.round(moved) };
}

export function goalProgress(p: { goal: number; goalDate: string; start?: Obj | null; latest: Obj | null; plannedSavings: number; inflows: Obj[]; savingsLast12: number; amortMonthly: number }) {
  if (!p.latest || !/^\d{4}-\d{2}$/.test(p.goalDate || '')) return null;
  const latest = p.latest, total = Number(latest.total);
  const monthsLeft = Math.max(0, monthsBetween(latest.period, p.goalDate) + 1);
  const left = Math.max(p.goal - total, 0);
  const start = p.start && p.start.period <= latest.period ? p.start : { period: latest.period, total };
  const span = monthsBetween(start.period, p.goalDate) + 1;
  const planAt = (per: string) => span > 0 ? Number(start.total) + (p.goal - Number(start.total)) * Math.min(1, Math.max(0, monthsBetween(start.period, per) / span)) : p.goal;
  const planNow = Math.round(planAt(latest.period));
  const planLine = span > 0 ? Array.from({ length: span + 1 }, (_, i) => ({ period: addMonths(start.period, i), value: Math.round(planAt(addMonths(start.period, i))) })) : [];
  const scen = (key: string, label: string, monthly: number, ratePct: number) => {
    const s = simulate({ latest, months: monthsLeft, monthly, ratePct, amort: p.amortMonthly, inflows: p.inflows, goal: p.goal });
    return { key, label, monthly_savings: Math.round(monthly), return_pct: ratePct, projected: s.projected, gap: s.projected - p.goal, reaches_goal: s.reached, path: s.path };
  };
  return {
    goal: p.goal, goal_date: p.goalDate, current: Math.round(total), current_period: latest.period, left: Math.round(left), months_left: monthsLeft,
    required_per_month: monthsLeft ? Math.round(left / monthsLeft) : null, done: left <= 0,
    progress_pct: goalPct(p.goal, start, total)?.progress_pct ?? null,
    plan: { start, value_now: planNow, vs_plan: Math.round(total - planNow), line: planLine },
    scenarios: [scen('svagt', 'Svagt', p.savingsLast12, 0), scen('plan', 'Plan', p.plannedSavings, 6), scen('bra', 'Bra', p.plannedSavings, 9)],
  };
}

// Snittsparande per period de senaste 12 avslutade perioderna (utan amortering)
export function avgSavings12(txs: Obj[], currentPeriod: string) {
  const from = addMonths(currentPeriod, -12);
  const sum = txs.filter((t) => t.type === 'savings' && t.month >= from && t.month < currentPeriod && (t.category ?? t.cat) !== 'Amortering').reduce((s, t) => s + Number(t.amount), 0);
  return sum / 12;
}
