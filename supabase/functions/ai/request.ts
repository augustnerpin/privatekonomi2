// Vad AI-proxyn släpper igenom till Anthropic (testas i supabase/tests/ai.test.mjs).
// Bara appens modeller och fält, och bara egna verktyg (inga betalda serververktyg som webbsökning).
export const MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']);
export const BETAS = new Set(['server-side-fallback-2026-07-01']);
const FIELDS = ['model', 'max_tokens', 'messages', 'system', 'tools', 'tool_choice', 'stream', 'output_config', 'fallbacks', 'metadata'];
const MAX_TOKENS = 64000;

// Lång systemprompt som sträng cachas i sin helhet. Skickar appen block (fast del + del som ändras)
// har den själv satt cache_control på den fasta delen, och då skickas blocken vidare som de är.
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
  if (Array.isArray(body.tools)) body.tools = (body.tools as Record<string, unknown>[]).filter((t) => t && !t.type && t.input_schema);
  return body;
}

// Vilka inloggade konton som får använda AI:n (secret AI_ALLOWED_USERS = kommaseparerade user-id).
// Saknas listan är AI:n avstängd: annars kan vem som helst som skapar ett konto använda nyckeln.
export function allowedUser(id: string, list: string | undefined) {
  const ids = String(list || '').split(',').map((s) => s.trim()).filter(Boolean);
  return ids.includes(id);
}
