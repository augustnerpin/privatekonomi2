// Plockar ut namngivna funktioner/konstanter ur appens index.html så att appens egen logik kan testas i node.
// appFns(['goalPctApp', ...], {ld, getGoal, ...}) → { goalPctApp, ... } med de givna globalerna i scope.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HTML = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

// Hoppar över strängar, mallsträngar (med ${…}) och kommentarer; returnerar index efter matchande slutparentes
function skipBalanced(src, i) {
  const open = src[i], close = { '{': '}', '(': ')', '[': ']' }[open];
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (ch === '"' || ch === "'") { for (i++; src[i] !== ch; i++) if (src[i] === '\\') i++; continue; }
    if (ch === '`') { i = skipTemplate(src, i); continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i + 1;
  }
  throw new Error('obalanserat');
}
function skipTemplate(src, i) {
  for (i++; src[i] !== '`'; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '$' && src[i + 1] === '{') i = skipBalanced(src, i + 1) - 1;
  }
  return i;
}
function extract(name) {
  let m = new RegExp(`\\n(async )?function ${name}\\(`).exec(HTML);
  if (m) { const p = skipBalanced(HTML, m.index + m[0].length - 1); return HTML.slice(m.index + 1, skipBalanced(HTML, HTML.indexOf('{', p))); }
  m = new RegExp(`\\n(const|let) ${name}=`).exec(HTML);
  if (!m) throw new Error(`Hittar inte ${name} i index.html`);
  // Konstant: till första semikolon på toppnivå
  let i = m.index + m[0].length;
  for (; i < HTML.length; i++) {
    const ch = HTML[i];
    if ('{(['.includes(ch)) { i = skipBalanced(HTML, i) - 1; continue; }
    if (ch === '`') { i = skipTemplate(HTML, i); continue; }
    if (ch === '"' || ch === "'") { for (i++; HTML[i] !== ch; i++) if (HTML[i] === '\\') i++; continue; }
    if (ch === ';' || ch === '\n') break;
  }
  return HTML.slice(m.index + 1, i + 1);
}
export function appFns(names, globals = {}) {
  const src = names.map(extract).join('\n');
  const keys = Object.keys(globals);
  return new Function(...keys, `${src}\nreturn {${names.join(',')}};`)(...keys.map((k) => globals[k]));
}
export const fmt = (n) => new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(Math.round(n)).replace(/\s/g, ' ');
export const mLabel = (ym) => ym;
