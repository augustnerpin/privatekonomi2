// Laddar functions/mcp/index.ts utan Deno-delen (npm-importen och Deno.serve), så att logiken
// kan testas i Node 22.18+ (som kör TypeScript direkt). Kör: node --test supabase/tests
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const src = readFileSync(new URL('../functions/mcp/index.ts', import.meta.url), 'utf8');
const core = src.replace(/^import \{ createClient \}.*\n/m, '').split('\n// ── Start (Supabase Edge Function)')[0];
const file = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'core.mts');
writeFileSync(file, core);
export const M = await import(file);
