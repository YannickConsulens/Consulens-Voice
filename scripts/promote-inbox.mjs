// Promoot bevestigde Inbox-actiepunten naar ✅ Taken.
//
// Draait als GitHub Action (zie .github/workflows/promote.yml), elke ~10 min.
// Leest de Consulens Voice — Inbox: elke rij met Status = "Bevestigd" en
// Type = "Actiepunt" wordt een echte taak in ✅ Taken, met project (geraden uit
// "Voorgesteld project"), deadline, prioriteit en de vergaderkoppeling mee.
// Daarna zet het de Inbox-rij op "Gepromoveerd" en linkt de aangemaakte taak in
// "Gepromoveerde taak", zodat ze niet opnieuw verwerkt wordt.
//
// Enige nodige secret: NOTION_TOKEN (dezelfde integratie als de app, gedeeld met
// Inbox, ✅ Taken, 🗂 Projecten en 📅 Vergaderingen).

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2025-09-03';

// Data source-ID's (niet geheim).
const INBOX_DS = '88858125-b804-46e2-b063-c119b0190b20';
const TAKEN_DS = '2d5b0ae0-fa56-459c-9e21-f76fda1f0f41';
const PROJECTEN_DS = '0a9f2595-2fc4-408c-910c-d3e111e1d138';

if (!NOTION_TOKEN) {
  console.error('NOTION_TOKEN ontbreekt.');
  process.exit(1);
}

const headers = {
  authorization: `Bearer ${NOTION_TOKEN}`,
  'notion-version': NOTION_VERSION,
  'content-type': 'application/json',
};

async function notion(path, method = 'POST', body) {
  const resp = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Notion ${resp.status} op ${path}: ${detail}`);
  }
  return resp.json();
}

// Query een data source volledig (met paginatie).
async function queryAll(dsId, filter) {
  const pages = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const data = await notion(`data_sources/${dsId}/query`, 'POST', body);
    pages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

// Titeltekst van een pagina (welke property ook 'title' is).
function titleText(page) {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p && p.type === 'title') {
      return (p.title || []).map((t) => t.plain_text || '').join('').trim();
    }
  }
  return '';
}

function richTextValue(prop) {
  if (!prop || prop.type !== 'rich_text') return '';
  return (prop.rich_text || []).map((t) => t.plain_text || '').join('').trim();
}

// Bouw een naam->id-map van de projecten voor het matchen van de tekstgok.
async function buildProjectIndex() {
  const projects = await queryAll(PROJECTEN_DS);
  return projects.map((p) => ({ id: p.id, naam: titleText(p) })).filter((p) => p.naam);
}

// Match de tekstgok tegen een echt project: exacte match, anders 'bevat'.
function matchProject(gok, index) {
  const g = String(gok || '').trim().toLowerCase();
  if (!g) return null;
  let hit = index.find((p) => p.naam.toLowerCase() === g);
  if (hit) return hit.id;
  hit = index.find((p) => p.naam.toLowerCase().includes(g) || g.includes(p.naam.toLowerCase()));
  return hit ? hit.id : null;
}

async function main() {
  const filter = {
    and: [
      { property: 'Status', select: { equals: 'Bevestigd' } },
      { property: 'Type', select: { equals: 'Actiepunt' } },
    ],
  };

  const rows = await queryAll(INBOX_DS, filter);
  if (rows.length === 0) {
    console.log('Geen bevestigde actiepunten om te promoveren.');
    return;
  }

  const projectIndex = await buildProjectIndex();
  let ok = 0;
  let fout = 0;

  for (const row of rows) {
    const props = row.properties || {};
    try {
      const taak = titleText(row) || 'Actiepunt';
      const prioNaam = props['Prioriteit']?.select?.name || 'Normaal';
      const prioriteit = prioNaam === 'Hoog' ? 'Hoog' : 'Middel';
      const deadline = props['Deadline']?.date?.start || null;
      const projectGok = richTextValue(props['Voorgesteld project']);
      const projectId = matchProject(projectGok, projectIndex);
      const vergadering = (props['Vergadering']?.relation || []).map((r) => ({ id: r.id }));

      const taakProps = {
        'Taak': { title: [{ text: { content: taak.slice(0, 2000) } }] },
        'Type': { select: { name: 'Actiepunt' } },
        'Status': { select: { name: 'Te doen' } },
        'Prioriteit': { select: { name: prioriteit } },
      };
      if (deadline) taakProps['Deadline'] = { date: { start: deadline } };
      if (projectId) taakProps['Project'] = { relation: [{ id: projectId }] };
      if (vergadering.length) taakProps['Vergadering'] = { relation: vergadering };

      const nieuweTaak = await notion('pages', 'POST', {
        parent: { type: 'data_source_id', data_source_id: TAKEN_DS },
        properties: taakProps,
      });

      await notion(`pages/${row.id}`, 'PATCH', {
        properties: {
          'Status': { select: { name: 'Gepromoveerd' } },
          'Gepromoveerde taak': { relation: [{ id: nieuweTaak.id }] },
        },
      });

      ok++;
      console.log(`✓ Gepromoveerd: "${taak}"${projectId ? ' (project gekoppeld)' : ''}`);
    } catch (e) {
      fout++;
      console.error(`✗ Fout bij rij ${row.id}:`, e.message);
    }
  }

  console.log(`Klaar: ${ok} gepromoveerd, ${fout} mislukt.`);
  if (fout > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Onverwachte fout:', e);
  process.exit(1);
});
