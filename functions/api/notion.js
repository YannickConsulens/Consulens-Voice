// Cloudflare Pages Function — serverside proxy naar de Notion API.
// Vervangt de oude ClickUp-uitvoer. De app roept deze functie aan op /api/notion.
//
// GET  /api/notion  -> lijst met actieve projecten voor de dropdown: [{ id, naam, code }]
// POST /api/notion  -> maakt actiepunten aan in de Taken-database
//                      body: { project: "<projectPageId of ''>", actiepunten: [ { omschrijving, deadline, prioriteit } ] }
//
// Vereist: een omgevingsvariabele (Secret) NOTION_TOKEN in je Cloudflare Pages-project,
// en de Notion-integratie moet gedeeld zijn met de databases hieronder.

const NOTION_VERSION = '2022-06-28';

// Databases in de Notion-workspace "Consulens OS"
const TAKEN_DB_ID     = '8712c57f-ba2b-4f01-8131-86f25fe818c9'; // ✅ Taken
const PROJECTEN_DB_ID = 'fce41037-5a1d-4c3b-814a-63f4193f8c51'; // 🗂 Projecten

// Prioriteit uit de app (hoog/normaal/laag) -> Notion select (Hoog/Middel/Laag)
const PRIORITEIT_MAP = { hoog: 'Hoog', normaal: 'Middel', laag: 'Laag' };

// Projectstatussen die we in de dropdown tonen
const ACTIEVE_STATUSSEN = ['Actief', 'Gepland', 'Offerte'];

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}

export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

function notionHeaders(token) {
  return {
    'authorization': `Bearer ${token}`,
    'notion-version': NOTION_VERSION,
    'content-type': 'application/json',
  };
}

// ── GET: actieve projecten ophalen voor de dropdown ──
export async function onRequestGet(context) {
  const { env } = context;
  if (!env.NOTION_TOKEN) {
    return json({ error: 'Server niet geconfigureerd: NOTION_TOKEN ontbreekt.' }, 500);
  }

  let resp;
  try {
    resp = await fetch(`https://api.notion.com/v1/databases/${PROJECTEN_DB_ID}/query`, {
      method: 'POST',
      headers: notionHeaders(env.NOTION_TOKEN),
      body: JSON.stringify({
        filter: {
          or: ACTIEVE_STATUSSEN.map((s) => ({ property: 'Status', select: { equals: s } })),
        },
        page_size: 100,
      }),
    });
  } catch (e) {
    return json({ error: 'Kon Notion niet bereiken: ' + e.message }, 502);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return json({ error: `Notion-fout bij projecten (${resp.status}).`, detail }, 502);
  }

  const data = await resp.json();
  const projecten = (data.results || []).map((p) => {
    const naamProp = p.properties && p.properties['Naam'];
    const naam = (naamProp && naamProp.title || [])
      .map((t) => t.plain_text).join('').trim() || '(zonder naam)';
    const codeProp = p.properties && p.properties['Projectcode'];
    const code = codeProp && (codeProp.unique_id
      ? (codeProp.unique_id.prefix ? codeProp.unique_id.prefix + '-' : '') + codeProp.unique_id.number
      : (codeProp.number ?? null));
    return { id: p.id, naam, code };
  });

  // Sorteer op naam (Notion sorteert unique_id/relaties niet altijd zoals gewenst)
  projecten.sort((a, b) => a.naam.localeCompare(b.naam, 'nl'));

  return json({ projecten });
}

// ── POST: actiepunten wegschrijven naar de Taken-database ──
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.NOTION_TOKEN) {
    return json({ error: 'Server niet geconfigureerd: NOTION_TOKEN ontbreekt.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ongeldig verzoek.' }, 400);
  }

  const projectId = body && typeof body.project === 'string' ? body.project.trim() : '';
  const actiepunten = Array.isArray(body && body.actiepunten) ? body.actiepunten : [];

  if (actiepunten.length === 0) {
    return json({ error: 'Geen actiepunten om weg te schrijven.' }, 400);
  }

  const results = [];
  for (const a of actiepunten) {
    const omschrijving = (a && a.omschrijving ? String(a.omschrijving) : '').trim();
    if (!omschrijving) { results.push({ ok: false, error: 'lege omschrijving' }); continue; }

    const properties = {
      'Taak': { title: [{ text: { content: omschrijving.slice(0, 2000) } }] },
      'Type': { select: { name: 'Actiepunt' } },
      'Status': { select: { name: 'Te doen' } },
    };

    const prio = PRIORITEIT_MAP[(a && a.prioriteit ? String(a.prioriteit) : '').toLowerCase()];
    if (prio) properties['Prioriteit'] = { select: { name: prio } };

    // Deadline moet YYYY-MM-DD zijn
    const deadline = (a && a.deadline ? String(a.deadline) : '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
      properties['Deadline'] = { date: { start: deadline } };
    }

    // Project-relatie (koppelt de taak aan het project; de uurregistratie volgt via de project-rollups)
    if (projectId) {
      properties['Project'] = { relation: [{ id: projectId }] };
    }

    let resp;
    try {
      resp = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: notionHeaders(env.NOTION_TOKEN),
        body: JSON.stringify({ parent: { database_id: TAKEN_DB_ID }, properties }),
      });
    } catch (e) {
      results.push({ ok: false, omschrijving, error: e.message });
      continue;
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      results.push({ ok: false, omschrijving, status: resp.status, detail });
    } else {
      const page = await resp.json().catch(() => ({}));
      results.push({ ok: true, omschrijving, id: page.id });
    }
  }

  const created = results.filter((r) => r.ok).length;
  const failed = results.length - created;

  if (created === 0) {
    return json({ error: 'Geen enkel actiepunt kon worden aangemaakt in Notion.', results }, 502);
  }

  return json({ created, failed, results });
}
