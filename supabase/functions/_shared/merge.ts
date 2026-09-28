// Säker sparning av inställningar (user_state) när flera skriver samtidigt: appen på flera enheter, MCP-servern och
// nattjobbet. Ingen får skriva över hela värdet från en kopia som kan vara gammal.
//  • mergeState3(base, local, server): trevägssammanslagning. base = värdet när skrivaren läste, local = skrivarens
//    nya värde, server = databasens värde nu. Bara det som ändrats i local jämfört med base läggs på serverns värde,
//    fält för fält (objekt per nyckel, listor med id per post, listor med strängar som mängd). Allt annat behålls.
//  • saveMerged(io, key, value, base): läser serverns version, slår ihop om den ändrats sedan base (updated_at) och
//    skriver villkorat (updated_at = det som lästes). Har någon hunnit skriva emellan görs samma sak igen.
// Samma regler som mergeState3/saveMergedApp i appen (index.html). Testas i supabase/tests/merge.test.mjs.
// deno-lint-ignore-file no-explicit-any
type Obj = Record<string, any>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const idList = (x: unknown): x is Obj[] => Array.isArray(x) && x.every((o) => isObj(o) && o.id != null);
const scalarList = (x: unknown): x is unknown[] => Array.isArray(x) && x.every((o) => o === null || typeof o !== 'object');

export function mergeState3(base: any, local: any, server: any): any {
  if (same(local, base)) return server;                      // inget ändrat lokalt: serverns version gäller
  if (server === undefined || same(server, base)) return local; // servern oförändrad: den lokala gäller
  if (isObj(local) && isObj(server)) {
    const b = isObj(base) ? base : {}, out: Obj = { ...server };
    for (const k of new Set([...Object.keys(b), ...Object.keys(local)])) {
      if (same(local[k], b[k])) continue;                      // fältet oförändrat lokalt
      if (!(k in local) || local[k] === undefined) delete out[k]; // borttaget lokalt
      else out[k] = mergeState3(b[k], local[k], server[k]);
    }
    return out;
  }
  if (idList(local) && idList(server) && (base == null || idList(base))) {
    const bm = new Map((base || []).map((o: Obj) => [String(o.id), o])), lm = new Map(local.map((o) => [String(o.id), o]));
    const out: Obj[] = [], seen = new Set<string>();
    for (const s of server) {
      const id = String(s.id); seen.add(id);
      if (bm.has(id) && !lm.has(id)) continue;                 // borttagen lokalt
      out.push(lm.has(id) ? mergeState3(bm.get(id), lm.get(id), s) : s);
    }
    for (const l of local) {
      const id = String(l.id); if (seen.has(id)) continue;
      if (bm.has(id) && same(bm.get(id), l)) continue;          // borttagen på servern och inte ändrad lokalt
      out.push(l);                                             // ny lokalt (eller ändrad lokalt efter att den tagits bort)
    }
    return out;
  }
  if (scalarList(local) && scalarList(server) && (base == null || scalarList(base))) {
    const b = new Set((base || []).map(String)), l = new Set(local.map(String));
    const out = server.filter((x) => !(b.has(String(x)) && !l.has(String(x)))); // borttagna lokalt
    for (const x of local) if (!b.has(String(x)) && !out.some((y) => String(y) === String(x))) out.push(x); // tillagda lokalt
    return out;
  }
  return local; // tal, text och övrigt som ändrats på båda håll: den senaste skrivningen gäller
}

export type StateIo = {
  get(key: string): Promise<{ value: any; updated_at: string; deleted?: boolean } | null>;
  update(key: string, value: any, expectedAt: string): Promise<string | null>; // ny updated_at, null = ändrad emellan
  insert(key: string, value: any): Promise<string | null>;                      // null = raden fanns redan
};
// known(row) = raden är den skrivaren senast såg (används som grundvärde när base saknas)
export async function saveMerged(io: StateIo, key: string, value: any, base?: { v: any; at: string | null } | null, known?: (row: Obj) => boolean) {
  for (let i = 0; i < 6; i++) {
    const row = await io.get(key);
    const live = !!row && !row.deleted;
    if (!base && live && known?.(row!)) base = { v: row!.value, at: row!.updated_at };
    const next = live && (!base || base.at !== row!.updated_at) ? mergeState3(base?.v, value, row!.value) : value;
    const at = row ? await io.update(key, next, row.updated_at) : await io.insert(key, next);
    if (at) return { value: next, at, merged: !same(next, value) };
  }
  throw new Error(`Inställningen ${key} ändrades samtidigt flera gånger – försök igen`);
}
