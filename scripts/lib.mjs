// Gedeelde helpers voor de Consulens Voice Notion-pipeline.
// Gebruikt door ingest-wave.mjs (Wave -> Inbox) en promote-inbox.mjs (Inbox -> Taken).
// Geen secrets hardcoded; NOTION_TOKEN / ANTHROPIC_API_KEY komen uit de omgeving.

export const NOTION_VERSION = '2025-09-03';

// Data source-ID's (niet geheim).
export const DS = {
  INBOX: '88858125-b804-46e2-b063-c119b0190b20',
  TAKEN: '2d5b0ae0-fa56-459c-9e21-f76fda1f0f41',
  PROJECTEN: '0a9f2595-2fc4-408c-910c-d3e111e1d138',
  VERGADERINGEN: 'c255c2d1-f12f-4be0-93cd-905f62521de9',
};

export function notionHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'notion-version': NOTION_VERSION,
    'content-type': 'application/json',
  };
}

// Eenvoudige Notion-fetch met foutmelding. path zonder leidende slash.
export async function notion(token, path, method = 'POST', body) {
  const resp = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: notionHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Notion ${resp.status} op ${path}: ${detail}`);
  }
  return resp.json();
}

// Query een data source volledig (met paginatie).
export async function queryAll(token, dsId, filter) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notion(token, `data_sources/${dsId}/query`, 'POST', body);
    pages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

// Alle child-blokken van een pagina/blok (met paginatie).
export async function getBlockChildren(token, blockId) {
  const blocks = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (cursor) qs.set('start_cursor', cursor);
    const data = await notion(token, `blocks/${blockId}/children?${qs.toString()}`, 'GET');
    blocks.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return blocks;
}

// Titeltekst van een pagina (welke property ook van type 'title' is).
export function titleText(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p && p.type === 'title') {
      return (p.title || []).map((t) => t.plain_text || '').join('').trim();
    }
  }
  return '';
}

export function richTextValue(prop) {
  if (!prop || prop.type !== 'rich_text') return '';
  return (prop.rich_text || []).map((t) => t.plain_text || '').join('').trim();
}

// Platte tekst van een inhoudsblok (to_do, paragraph, ...).
export function blockPlainText(block) {
  const inner = block && block[block.type];
  const rt = (inner && inner.rich_text) || [];
  return rt.map((x) => x.plain_text || '').join('').trim();
}

// ── Datum-helpers ────────────────────────────────────────────────────────────
export function isRealDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Normaliseer naar YYYY-MM-DD; onbekend/ongeldig => null.
export function normalizeDate(value) {
  const str = (value == null ? '' : String(value)).trim();
  if (!str) return null;
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return isRealDate(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const y = m[3];
    const mo = m[2].padStart(2, '0');
    const d = m[1].padStart(2, '0');
    return isRealDate(+y, +mo, +d) ? `${y}-${mo}-${d}` : null;
  }
  return null;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Projectindex (naam -> id) voor het koppelen van een projectgok ───────────
export async function buildProjectIndex(token) {
  const projects = await queryAll(token, DS.PROJECTEN);
  return projects.map((p) => ({ id: p.id, naam: titleText(p) })).filter((p) => p.naam);
}

export function matchProject(gok, index) {
  const g = String(gok || '').trim().toLowerCase();
  if (!g) return null;
  let hit = index.find((p) => p.naam.toLowerCase() === g);
  if (hit) return hit.id;
  hit = index.find((p) => p.naam.toLowerCase().includes(g) || g.includes(p.naam.toLowerCase()));
  return hit ? hit.id : null;
}

// ── Actiepunt-regel: leesbaar EN machineleesbaar ─────────────────────────────
// Ingest schrijft per actiepunt een checkbox als:
//   "<omschrijving>  ·  👤 <houder>  ·  📅 <YYYY-MM-DD>  ·  ⚡ Hoog"
// De extra's zijn optioneel. Promote leest ze terug met parseActieRegel().
export function buildActieRegel(a) {
  const omschrijving = String((a && (a.omschrijving ?? a.text)) ?? '').trim();
  const extras = [];
  const houder = String((a && (a.houder ?? a.owner)) ?? '').trim();
  const deadline = normalizeDate(a && (a.deadline ?? a.due));
  const prio = String((a && a.prioriteit) ?? '').trim();
  if (houder && houder.toLowerCase() !== 'yannick') extras.push(`👤 ${houder}`);
  if (deadline) extras.push(`📅 ${deadline}`);
  if (prio.toLowerCase() === 'hoog') extras.push('⚡ Hoog');
  return extras.length ? `${omschrijving}  ·  ${extras.join('  ·  ')}` : omschrijving;
}

export function parseActieRegel(text) {
  const raw = String(text || '');
  const parts = raw.split('·').map((s) => s.trim());
  const omschrijving = (parts.shift() || '').trim();
  let houder = '';
  let deadline = null;
  let prioriteit = 'Middel';
  for (const p of parts) {
    if (p.includes('👤')) houder = p.replace('👤', '').trim();
    else if (p.includes('📅')) deadline = normalizeDate(p.replace('📅', '').trim());
    else if (/⚡/.test(p) && /hoog/i.test(p)) prioriteit = 'Hoog';
  }
  return { omschrijving, houder, deadline, prioriteit };
}

// ── Claude (classificatie/verfijning) ────────────────────────────────────────
export async function claudePolish(apiKey, model, systemPrompt, userText, maxTokens = 2000) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Anthropic ${resp.status}: ${detail}`);
  }
  const data = await resp.json();
  const raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}
