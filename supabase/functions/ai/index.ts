// AI-proxy: appen anropar Claude härifrån i stället för direkt, så att Anthropic-nyckeln bara finns på servern.
// Kräver inloggning (Supabase-sessionens JWT). Svaret skickas vidare oförändrat, även strömmat (SSE).
// Nyckeln sätts en gång: npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-… --project-ref <ref>
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-anthropic-beta',
};
// Bara modeller och fält som appen använder släpps igenom
const MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']);
const BETAS = new Set(['server-side-fallback-2026-07-01']);
const FIELDS = ['model', 'max_tokens', 'messages', 'system', 'tools', 'tool_choice', 'stream', 'output_config', 'fallbacks', 'metadata'];
const MAX_TOKENS = 64000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
const fail = (status: number, message: string) => json({ type: 'error', error: { type: 'proxy_error', message } }, status);

// Lång systemprompt (appens kontext) cachas: samma prefix i verktygsloopen och i följdfrågor blir billigare
function withCache(system: unknown) {
  if (typeof system === 'string' && system.length > 4000) return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  return system;
}

export function buildRequest(input: Record<string, unknown>) {
  if (!input || typeof input !== 'object') throw new Error('Ogiltig förfrågan');
  if (!MODELS.has(input.model as string)) throw new Error(`Modellen ${input.model} är inte tillåten`);
  if (!Array.isArray(input.messages) || !input.messages.length) throw new Error('messages saknas');
  const body: Record<string, unknown> = {};
  for (const k of FIELDS) if (input[k] !== undefined) body[k] = input[k];
  body.max_tokens = Math.min(Math.max(1, Number(input.max_tokens) || 16000), MAX_TOKENS);
  if (body.system !== undefined) body.system = withCache(body.system);
  return body;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return fail(405, 'Method not allowed');

  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return fail(500, 'ANTHROPIC_API_KEY saknas på servern');

  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return fail(401, 'Logga in i appen för att använda AI');
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } });
  const { data: user, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user?.user) return fail(401, 'Inloggningen har gått ut — logga in igen');

  let body: Record<string, unknown>;
  try { body = buildRequest(await req.json()); } catch (e) { return fail(400, (e as Error).message); }

  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const betas = (req.headers.get('x-anthropic-beta') || '').split(',').map((s) => s.trim()).filter((b) => BETAS.has(b));
  if (betas.length) headers['anthropic-beta'] = betas.join(',');

  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  return new Response(res.body, { status: res.status, headers: { ...CORS, 'content-type': res.headers.get('content-type') || 'application/json' } });
});
