// Målet mot plan och scenarier (functions/_shared/goal.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalProgress, simulate, inflowsIn, monthsBetween, addMonths, avgSavings12 } from '../functions/_shared/goal.ts';

const latest = { period: '2026-10', total: 707104, amounts: { stocks: 168000, pension: 58000, cash: 230000, apt: 187604, klockor: 31000, ab: 31300, kontanter: 1200, other: 0 } };
const inflows = [{ name: 'Tjänstepension', amount: 2000, monthly: true, nw_cat: 'pension' }, { name: 'Klumpsumma', amount: 25000, date: '2027-01', nw_cat: 'cash' }];

test('krav per månad räknar med innevarande period: (950 000 − 707 104) / 15 ≈ 16 193', () => {
  const g = goalProgress({ goal: 950000, goalDate: '2027-12', start: null, latest, plannedSavings: 10000, inflows: [], savingsLast12: 5000, amortMonthly: 0 });
  assert.equal(g.months_left, 15); assert.equal(g.required_per_month, 16193); assert.equal(g.left, 242896);
  assert.equal(g.plan.vs_plan, 0); // planen startar nu
  assert.equal(g.plan.line[0].value, 707104); assert.equal(g.plan.line.at(-1).period, '2028-01'); assert.equal(g.plan.line.at(-1).value, 950000);
});

test('plan mot utfall: före/efter planlinjen', () => {
  const start = { period: '2026-04', total: 584340 };
  const g = goalProgress({ goal: 950000, goalDate: '2027-12', start, latest, plannedSavings: 10000, inflows: [], savingsLast12: 5000, amortMonthly: 0 });
  // 21 månader från 2026-04 till slutet av 2027-12; 6 av dem har gått → planen 584 340 + 365 660 × 6/21 = 688 814
  assert.equal(g.plan.value_now, 688814); assert.equal(g.plan.vs_plan, 707104 - 688814);
});

test('scenarier: svagt < plan < bra, kända inbetalningar och amortering räknas', () => {
  const g = goalProgress({ goal: 950000, goalDate: '2027-12', start: null, latest, plannedSavings: 10000, inflows, savingsLast12: 4000, amortMonthly: 2546 });
  const [svagt, plan, bra] = g.scenarios;
  // svagt: 0 % → 707 104 + 15 × (4 000 + 2 000 + 2 546) + 25 000
  assert.equal(svagt.projected, 707104 + 15 * (4000 + 2000 + 2546) + 25000);
  assert.ok(plan.projected > svagt.projected && bra.projected > plan.projected);
  assert.equal(plan.monthly_savings, 10000); assert.equal(bra.return_pct, 9);
  assert.ok(plan.reaches_goal === null || plan.reaches_goal <= '2027-12');
});

test('hjälpfunktioner', () => {
  assert.equal(monthsBetween('2026-10', '2027-12'), 14); assert.equal(addMonths('2026-11', 2), '2027-01');
  assert.deepEqual(inflowsIn(inflows, '2027-01'), { invest: 2000, other: 25000 }); assert.deepEqual(inflowsIn(inflows, '2027-02'), { invest: 2000, other: 0 });
  assert.equal(simulate({ latest: { period: '2026-10', total: 100, amounts: { stocks: 100 } }, months: 12, monthly: 0, ratePct: 12, amort: 0, inflows: [], goal: 1e9 }).projected, 112);
  assert.equal(avgSavings12([{ type: 'savings', month: '2026-05', amount: 12000, category: 'Avanza' }, { type: 'savings', month: '2026-05', amount: 999, category: 'Amortering' }, { type: 'savings', month: '2026-10', amount: 5000, category: 'Avanza' }], '2026-10'), 1000);
});

// Framsteg räknas från förmögenheten när målet sattes, inte från 0 (705k → 950k: 704 558 kr är 0 %, inte 74 %)
import { goalPct } from '../functions/_shared/goal.ts';
import { appFns, fmt, mLabel } from './app.mjs';
test('målprocent: andel av vägen från goal_start, samma i appen och på servern', () => {
  const start = { period: '2026-10', total: 707104 };
  assert.equal(goalPct(950000, start, 704558).progress_pct, 0);
  assert.equal(goalPct(950000, start, 704558).moved_since_start, -2546);
  assert.equal(goalPct(950000, start, 828552).progress_pct, 50);
  assert.equal(goalPct(950000, start, 990000).progress_pct, 100);
  assert.equal(goalPct(950000, null, 704558), null);
  assert.equal(goalProgress({ goal: 950000, goalDate: '2027-12', start, latest: { ...latest, total: 704558 }, plannedSavings: 10000, inflows: [], savingsLast12: 0, amortMonthly: 0 }).progress_pct, 0);
  let NWS = [{ period: '2026-09', total: 659000 }, { period: '2026-10', total: 707104 }];
  const state = { goal_start: start };
  const app = appFns(['goalStartApp', 'goalPctApp', 'goalPctTxt'], { ld: (k, d) => state[k] ?? d, getGoal: () => 950000, getNWs: () => NWS, fmt, mLabel });
  assert.equal(app.goalPctApp(704558).pct, 0);
  assert.match(app.goalPctTxt(app.goalPctApp(704558)), /^0 % av vägen 707 104 → 950 000 kr \(när målet sattes 2026-10; 2 546 kr under startvärdet\)$/);
  assert.equal(Math.round(app.goalPctApp(828552).pct), 50);
  delete state.goal_start; // utan goal_start: från första förmögenhetsbilden, och det står i texten
  assert.match(app.goalPctTxt(app.goalPctApp(704558)), /första förmögenhetsbilden 2026-09/);
});

// goal_start pekar på en period; totalen läses från bilden, så rättelser av startbilden slår igenom
import { resolveGoalStart } from '../functions/_shared/goal.ts';
test('goal_start: oktoberbilden rättad från 707 104 till 693 764 kr ger inte "under startvärdet"', () => {
  const snaps = [{ period: '2026-09', total: 659000 }, { period: '2026-10', total: 693764 }];
  for (const gs of [{ period: '2026-10' }, { period: '2026-10', total: 707104 }]) { // ny form och äldre form med fryst total
    const st = resolveGoalStart(gs, snaps);
    assert.deepEqual(st, { period: '2026-10', total: 693764, from: 'snapshot' });
    assert.deepEqual([goalPct(950000, st, 693764).progress_pct, goalPct(950000, st, 693764).moved_since_start], [0, 0]);
  }
  assert.deepEqual(resolveGoalStart({ period: '2026-10', total: 707104 }, []), { period: '2026-10', total: 707104, from: 'stored' }); // bilden borttagen
  assert.equal(resolveGoalStart({ period: '2026-10' }, []), null);
  assert.equal(resolveGoalStart(null, snaps), null);
  const g = goalProgress({ goal: 950000, goalDate: '2027-12', start: resolveGoalStart({ period: '2026-10' }, snaps), latest: { ...latest, total: 693764 }, plannedSavings: 10000, inflows: [], savingsLast12: 0, amortMonthly: 0 });
  assert.deepEqual([g.plan.start.total, g.plan.vs_plan, g.progress_pct], [693764, 0, 0]);
  // Appen: samma, och texten säger inget om "under startvärdet"
  const state = { goal_start: { period: '2026-10', total: 707104 } };
  const app = appFns(['goalStartApp', 'goalPctApp', 'goalPctTxt'], { ld: (k, d) => state[k] ?? d, getGoal: () => 950000, getNWs: () => snaps, fmt, mLabel });
  assert.deepEqual(app.goalStartApp(), { period: '2026-10', total: 693764 });
  assert.equal(app.goalPctTxt(app.goalPctApp(693764)), '0 % av vägen 693 764 → 950 000 kr (när målet sattes 2026-10)');
});
