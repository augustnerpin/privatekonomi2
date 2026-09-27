// Låtsas-PostgREST med samma kedjeanrop som supabase-js. Räknar skrivningar (db.writes), så att
// testerna kan visa att dry_run aldrig skriver. Tabeller i `missing` finns inte (som före migreringen).
export function fakeDb(tables, { missing = [] } = {}) {
  const db = {
    writes: 0,
    from(name) {
      let op = 'select', payload = null, filters = [], orders = [], lim = null, rng = null, ret = false, conflict = null;
      const val = (r, k) => { const m = k.match(/^(\w+)->>(\w+)$/); return m ? (r[m[1]]?.[m[2]] == null ? null : String(r[m[1]][m[2]])) : r[k]; };
      const b = {
        select() { if (op !== 'select') ret = true; return b; },
        insert(r) { op = 'insert'; payload = r; return b; },
        update(p) { op = 'update'; payload = p; return b; },
        upsert(r, o) { op = 'upsert'; payload = r; conflict = o.onConflict.split(','); return b; },
        eq(k, v) { filters.push((r) => val(r, k) === v); return b; },
        neq(k, v) { filters.push((r) => val(r, k) !== v); return b; },
        in(k, v) { filters.push((r) => v.includes(val(r, k))); return b; },
        gte(k, v) { filters.push((r) => val(r, k) >= v); return b; },
        lte(k, v) { filters.push((r) => val(r, k) <= v); return b; },
        order(k, o) { orders.push([k, o.ascending]); return b; },
        limit(n) { lim = n; return b; },
        range(a, z) { rng = [a, z]; return b; },
        then(res, rej) {
          try {
            if (missing.includes(name)) return res({ data: null, error: { code: '42P01', message: `relation "public.${name}" does not exist` } });
            const T = (tables[name] ||= []);
            const hit = () => T.filter((r) => filters.every((f) => f(r)));
            if (op !== 'select') db.writes++;
            if (op === 'insert') { for (const r of [].concat(payload)) T.push(structuredClone(r)); return res({ data: null, error: null }); }
            if (op === 'upsert') {
              for (const r of [].concat(payload)) { const i = T.findIndex((x) => conflict.every((k) => x[k] === r[k])); if (i >= 0) T[i] = { ...T[i], ...structuredClone(r) }; else T.push(structuredClone(r)); }
              return res({ data: null, error: null });
            }
            if (op === 'update') { const rows = hit(); rows.forEach((r) => Object.assign(r, structuredClone(payload))); return res({ data: ret ? rows.map((r) => ({ ...r })) : null, error: null }); }
            let rows = hit().map((r) => structuredClone(r));
            rows.sort((x, y) => { for (const [k, asc] of orders) { if (x[k] < y[k]) return asc ? -1 : 1; if (x[k] > y[k]) return asc ? 1 : -1; } return 0; });
            if (rng) rows = rows.slice(rng[0], rng[1] + 1);
            if (lim != null) rows = rows.slice(0, lim);
            res({ data: rows, error: null });
          } catch (e) { rej(e); }
        },
      };
      return b;
    },
  };
  return db;
}
