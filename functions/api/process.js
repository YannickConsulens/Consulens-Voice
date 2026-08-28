// Cloudflare Pages Function — serverside proxy naar de Anthropic API.
// De app roept deze functie aan op /api/process, NOOIT api.anthropic.com direct.
// Zo blijft je API-sleutel geheim (server-side env var) en zijn er geen CORS-problemen.
//
// Vereist: een omgevingsvariabele ANTHROPIC_API_KEY in je Cloudflare Pages-project.
// Voor de Notion-uitvoer: NOTION_TOKEN + NOTION_INBOX_DS_ID.

const MODEL = 'claude-sonnet-5';   // geldig, actueel model-ID (datumloos = vaste snapshot sinds 4.6). Wisselbaar naar 'claude-haiku-4-5' voor sneller/goedkoper.
const MAX_TOKENS = 2000;           // ruim genoeg voor een lang vergaderverslag

// ── Actieve projecten (stuurt de projectgok van Claude) ──
// De projectnamen worden LIVE uit Notion (🗂 Projecten) gehaald zodat Claude zijn
// 'project'-gok kiest uit de ECHTE lijst; de latere promotie (naam -> page-ID) wordt
// dan een simpele match. Zie fetchProjectNamen() in de Notion-sectie hieronder.
// Lukt de ophaling niet, dan valt alles terug op een vrije gok (zoals vroeger).

// Lichte cache: hergebruik de opgehaalde namen ~15 min, zodat niet elke opname een
// Notion-call kost. Module-scope; best-effort (leeg bij een cold start).
let projectenCache = { namen: [], ts: 0 };
const PROJECTEN_TTL_MS = 15 * 60 * 1000;

// Bouwt de injectie-instructie uit de opgehaalde projectnamen. Lege lijst => ''
// (dan geen injectie; Claude vult 'project' als vrije gok in, zoals vandaag).
function projectHint(namen) {
  if (!namen || !namen.length) return '';
  return `\n\nDit zijn de actieve projecten: ${namen.join(', ')}. `
    + `Kies voor elk actiepunt het meest waarschijnlijke project EXACT zoals het in deze `
    + `lijst staat en zet het in het veld 'project'. Past geen enkel project duidelijk, laat `
    + `'project' dan leeg. Verzin nooit een projectnaam die niet in de lijst staat.`;
}

const SYSTEM_PROMPT = `Je bent een assistent voor Yannick, solo BIM-consultant bij Consulens.
Je analyseert gesproken Nederlandse tekst (transcripties) en maakt er een gestructureerd verslag of actielijst van.

Antwoord UITSLUITEND als geldig JSON zonder markdown of uitleg:
{
  "mode": "verslag" of "acties",
  "reden": "korte uitleg",
  "samenvatting": "2-3 zinnen samenvatting",
  "actiepunten": [
    { "omschrijving": "...", "houder": "Yannick of andere naam", "deadline": "YYYY-MM-DD of null", "prioriteit": "hoog/normaal/laag", "project": "meest waarschijnlijke projectnaam of null" }
  ],
  "vergadering": {
    "titel": "korte titel van de vergadering (max 8 woorden) of null",
    "datum": "YYYY-MM-DD of null",
    "locatie": "of null",
    "aanwezigen": [],
    "beslissingen": []
  }
}

Modus-regel (BELANGRIJK):
- De gebruiker kiest zelf de modus. Die wordt je meegegeven als "Modus:".
- Modus "vergadering" => mode = "verslag".
- Modus "notitie" => mode = "acties".
- Volg deze mapping altijd; classificeer NIET op eigen houtje.

Inhoudelijke regels:
- Extraheer ALLE actiepunten, ook impliciete taken.
- Als geen houder vermeld => gebruik "Yannick".
- Vul bij elk actiepunt 'project' in: je beste gok van de projectnaam waartoe het hoort (vrije tekst, geen ID). Ken je het niet => null.
- Bij een vergadering: vul 'vergadering.beslissingen' met alle genomen beslissingen (elk als losse korte zin), 'aanwezigen' met de vermelde namen, en 'titel' met een korte omschrijving van de vergadering.
- Datums (deadline, vergaderdatum) ALTIJD als YYYY-MM-DD (ISO). Reken relatieve datums ("volgende week", "maandag") NIET om als je de opnamedatum niet kent => gebruik dan null en laat het in de omschrijving staan.
- Spreek de gebruiker aan met "je/jij" in de samenvatting.

Transcriptiecorrectie (Nederlands, bouw & BIM):
- Dit is spraakherkenning: technische termen en eigennamen zijn vaak fout getranscribeerd. Corrigeer die stil (zonder het te vermelden) naar de juiste vakterm, zolang de betekenis duidelijk is.
- Veelvoorkomende BIM-/software-termen: Revit, BIM, IFC, LOD, LOI, Navisworks, AutoCAD, Civil 3D, Dynamo, Speckle, Solibri, clash detection, federatiemodel, as-built, IFC-export, coordinatiemodel.
- Veelvoorkomende bouw-/studietermen (BE): meetstaat, bestek, VMSW, aanbestedingsdossier, uitvoeringsdossier, EPB, stabiliteit, wapening, bekisting, spouwmuurisolatie, gewapend beton, funderingen, riolering, RioAK, nutsleidingen, ruwbouw, afwerking, oplevering, werfvergadering, bouwheer, architect, studiebureau, aannemer.
- Voorbeelden van typische fouten => correctie: "rivet"/"revid" => "Revit"; "i f c" => "IFC"; "el o d" => "LOD"; "navis works" => "Navisworks"; "meet staat" => "meetstaat"; "V M S W" => "VMSW".
- Corrigeer enkel wat duidelijk bedoeld is; verzin geen inhoud die er niet staat.`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}

// Preflight (niet strikt nodig bij same-origin, maar veilig)
export function onRequestOptions() {
  return new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

// ── Notion (triage-Inbox + Vergaderingen) ──────────────────────────────────
// Elke opname landt als losse rijen in de Inbox-data source op status
// "Te bevestigen". Yannick triageert daar later; een foute classificatie raakt
// zo nooit de echte data. Bij een vergadering wordt bovendien een echt record
// in 📅 Vergaderingen aangemaakt (met beslissingen + ruw verslag) en worden de
// actiepunten daaraan gekoppeld. Werkt op het data-sources-model (2025-09-03).
const NOTION_VERSION = '2025-09-03';
const INBOX_STATUS = 'Te bevestigen';
// Data source-ID van 📅 Vergaderingen (niet geheim; net als de ID's in notion.js).
const VERGADERINGEN_DS_ID = 'c255c2d1-f12f-4be0-93cd-905f62521de9';

// Prioriteit uit de app (hoog/normaal/laag) -> Inbox-select (Hoog|Normaal).
function inboxPrioriteit(prio) {
  return String(prio || '').toLowerCase() === 'hoog' ? 'Hoog' : 'Normaal';
}

// Modus (notitie|vergadering) -> Inbox-select (Notitie|Vergadering).
function inboxModus(mode) {
  return mode === 'vergadering' ? 'Vergadering' : 'Notitie';
}

function richText(value) {
  const content = (value == null ? '' : String(value)).slice(0, 2000);
  return { rich_text: [{ type: 'text', text: { content } }] };
}

function selectProp(name) {
  return { select: { name } };
}

// Alleen echte kalenderdatums (bv. 2026-02-31 wordt geweigerd).
function isRealDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Deadline normaliseren naar YYYY-MM-DD. Onbekend/ongeldig => null (dan geen datum
// meesturen; Notion weigert een ongeldige datum en laat anders de hele write falen).
function normalizeDate(value) {
  const str = (value == null ? '' : String(value)).trim();
  if (!str) return null;
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return isRealDate(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  // Belgisch formaat: DD/MM/YYYY of DD-MM-YYYY
  m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const y = m[3];
    const mo = m[2].padStart(2, '0');
    const d = m[1].padStart(2, '0');
    return isRealDate(+y, +mo, +d) ? `${y}-${mo}-${d}` : null;
  }
  return null;
}

// Vandaag als YYYY-MM-DD (UTC — dicht genoeg bij BE-datum voor een capture).
function today() {
  return new Date().toISOString().slice(0, 10);
}

// Tekst opknippen in stukken van ~1900 tekens (rich_text-limiet = 2000).
function chunk1900(text) {
  const t = String(text || '').trim();
  const out = [];
  for (let i = 0; i < t.length; i += 1900) out.push(t.slice(i, i + 1900));
  return out;
}

// Ruw transcript in paragraafblokken.
function transcriptBlocks(transcript) {
  return chunk1900(transcript).slice(0, 90).map((c) => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: c } }] },
  }));
}

function headingBlock(text) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function paragraphBlock(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: String(text || '').slice(0, 1900) } }] },
  };
}

function bulletBlock(text) {
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: String(text || '').slice(0, 1900) } }] },
  };
}

async function createPage(env, dataSourceId, properties, children) {
  const payload = {
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties,
  };
  if (children && children.length) payload.children = children.slice(0, 100);

  const resp = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${env.NOTION_TOKEN}`,
      'notion-version': NOTION_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Notion ${resp.status}: ${detail}`);
  }
  return resp.json().catch(() => ({}));
}

// Maakt een record in 📅 Vergaderingen met samenvatting, beslissingen en ruw
// verslag in de body. Geeft het paginaobject terug (met .id) of null bij fout.
async function createMeeting(env, result, transcript) {
  const v = (result && result.vergadering) || {};
  const samenvatting = result && result.samenvatting ? String(result.samenvatting) : '';
  const beslissingen = Array.isArray(v.beslissingen) ? v.beslissingen.filter(Boolean) : [];
  const aanwezigen = Array.isArray(v.aanwezigen) ? v.aanwezigen.filter(Boolean).join(', ') : String(v.aanwezigen || '');
  const datum = normalizeDate(v.datum) || today();
  const titel = (v.titel && String(v.titel).trim())
    || (samenvatting ? samenvatting.slice(0, 60) : `Vergadering ${datum}`);

  const properties = {
    'Titel': { title: [{ text: { content: String(titel).slice(0, 200) } }] },
    'Status': selectProp('Gehouden'),
    'Datum': { date: { start: datum } },
  };
  if (aanwezigen) properties['Aanwezigen'] = richText(aanwezigen);
  if (v.locatie) properties['Locatie'] = richText(v.locatie);

  const children = [];
  if (samenvatting) {
    children.push(headingBlock('📝 Samenvatting'));
    children.push(paragraphBlock(samenvatting));
  }
  if (beslissingen.length) {
    children.push(headingBlock('✅ Beslissingen'));
    beslissingen.forEach((b) => children.push(bulletBlock(b)));
  }
  children.push(headingBlock('📌 Acties'));
  children.push(paragraphBlock('De actiepunten van deze vergadering staan in de Inbox (status "Te bevestigen") en verschijnen na bevestiging bij "Actiepunten".'));
  if (String(transcript || '').trim()) {
    children.push(headingBlock('🎙 Ruw transcript'));
    transcriptBlocks(transcript).forEach((b) => children.push(b));
  }

  try {
    return await createPage(env, VERGADERINGEN_DS_ID, properties, children);
  } catch (e) {
    console.error('[vergadering] record aanmaken mislukt:', e.message);
    return null;
  }
}

// Schrijft elk actiepunt als losse Inbox-rij op status "Te bevestigen".
// Blokkeert de gebruiker nooit: fouten worden serverside gelogd, niet naar de
// frontend teruggegeven. meetingId (optioneel) koppelt de rij aan een vergadering.
async function writeToInbox(env, result, mode, transcript, captureId, meetingId) {
  if (!env.NOTION_TOKEN || !env.NOTION_INBOX_DS_ID) {
    console.error('[inbox] NOTION_TOKEN of NOTION_INBOX_DS_ID ontbreekt - inbox-write overgeslagen.');
    return;
  }

  const samenvatting = result && result.samenvatting ? String(result.samenvatting) : '';
  const reden = result && result.reden ? String(result.reden) : '';
  const actiepunten = Array.isArray(result && result.actiepunten) ? result.actiepunten : [];
  const isMeeting = mode === 'vergadering';

  // Context die op elke rij mee gaat, zodat triage zonder de opname kan.
  const gemeenschappelijk = () => {
    const props = {
      'Status': selectProp(INBOX_STATUS),
      'Modus': selectProp(inboxModus(mode)),
      'Reden': richText(reden),
      'Samenvatting': richText(samenvatting),
      'Capture-ID': richText(captureId),
    };
    if (meetingId) props['Vergadering'] = { relation: [{ id: meetingId }] };
    return props;
  };

  // Ruw transcript enkel bij een notitie in de eerste Inbox-rij; bij een
  // vergadering staat het volledige verslag al in het Vergaderingen-record.
  const body = isMeeting ? [] : transcriptBlocks(transcript);
  let transcriptGeplaatst = false;

  if (actiepunten.length === 0) {
    // Bij een vergadering zonder acties is het Vergaderingen-record al de vastlegging.
    if (isMeeting) return;
    // Geen actiepunten => een Notitie-rij met de samenvatting als titel.
    const properties = {
      ...gemeenschappelijk(),
      'Titel': { title: [{ text: { content: (samenvatting || 'Notitie').slice(0, 2000) } }] },
      'Type': selectProp('Notitie'),
    };
    try {
      await createPage(env, env.NOTION_INBOX_DS_ID, properties, body);
    } catch (e) {
      console.error('[inbox] notitie-rij mislukt:', e.message);
    }
    return;
  }

  for (let i = 0; i < actiepunten.length; i++) {
    const a = actiepunten[i] || {};
    const omschrijving = (a.omschrijving ? String(a.omschrijving) : '').trim();
    if (!omschrijving) continue;

    const properties = {
      ...gemeenschappelijk(),
      'Titel': { title: [{ text: { content: omschrijving.slice(0, 2000) } }] },
      'Type': selectProp('Actiepunt'),
      'Houder': richText(a.houder || 'Yannick'),
      'Prioriteit': selectProp(inboxPrioriteit(a.prioriteit)),
      'Voorgesteld project': richText(a.project || ''),
    };

    const deadline = normalizeDate(a.deadline);
    if (deadline) properties['Deadline'] = { date: { start: deadline } };

    const children = transcriptGeplaatst ? [] : body;
    try {
      await createPage(env, env.NOTION_INBOX_DS_ID, properties, children);
      transcriptGeplaatst = true;
    } catch (e) {
      console.error(`[inbox] actiepunt-rij ${i} mislukt:`, e.message);
    }
  }
}

// Haalt de actieve projectnamen op uit 🗂 Projecten (data source
// NOTION_PROJECTS_DS_ID). Leest per resultaat de property van het TYPE 'title'
// (zoekt op type === 'title', gaat NIET uit van een vaste propertynaam) en geeft
// een array namen (strings) terug. Ontbreekt de env var of faalt de call => lege
// array + log. Dit mag de verwerking NOOIT blokkeren. Cachet ~15 min (zie boven).
async function fetchProjectNamen(env) {
  if (!env.NOTION_TOKEN || !env.NOTION_PROJECTS_DS_ID) {
    console.error('[projecten] NOTION_TOKEN of NOTION_PROJECTS_DS_ID ontbreekt - projectlijst overgeslagen.');
    return [];
  }

  // Cache: binnen de TTL hergebruiken zonder nieuwe Notion-call.
  if (projectenCache.namen.length && (Date.now() - projectenCache.ts) < PROJECTEN_TTL_MS) {
    return projectenCache.namen;
  }

  try {
    const resp = await fetch(`https://api.notion.com/v1/data_sources/${env.NOTION_PROJECTS_DS_ID}/query`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${env.NOTION_TOKEN}`,
        'notion-version': NOTION_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ page_size: 100 }),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Notion ${resp.status}: ${detail}`);
    }
    const data = await resp.json();
    const namen = [];
    for (const page of (data.results || [])) {
      const props = (page && page.properties) || {};
      // Zoek de title-property op TYPE (de naam kan per workspace afwijken).
      const titleProp = Object.values(props).find((prop) => prop && prop.type === 'title');
      const naam = titleProp && Array.isArray(titleProp.title)
        ? titleProp.title.map((t) => (t && t.plain_text) || '').join('').trim()
        : '';
      if (naam) namen.push(naam);
    }
    projectenCache = { namen, ts: Date.now() };
    return namen;
  } catch (e) {
    console.error('[projecten] ophalen mislukt:', e.message);
    return [];
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'Server niet geconfigureerd: ANTHROPIC_API_KEY ontbreekt.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Ongeldig verzoek.' }, 400);
  }

  const transcript = (body && body.transcript ? String(body.transcript) : '').trim();
  const mode = body && body.mode === 'vergadering' ? 'vergadering' : 'notitie';

  if (!transcript) {
    return json({ error: 'Geen transcript ontvangen.' }, 400);
  }

  // Actieve projectnamen ophalen (best-effort) en in de classificatieprompt injecteren.
  // Faalt dit, dan is de lijst leeg en raadt Claude 'project' vrij, zoals vroeger.
  const projectNamen = await fetchProjectNamen(env);
  const systemPrompt = SYSTEM_PROMPT + projectHint(projectNamen);

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [
          { role: 'user', content: `Modus: ${mode}\n\nTranscript:\n${transcript}` },
        ],
      }),
    });
  } catch (e) {
    return json({ error: 'Kon de Anthropic API niet bereiken: ' + e.message }, 502);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return json({ error: `Anthropic API-fout (${resp.status}).`, detail }, 502);
  }

  const data = await resp.json();
  const raw = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const clean = raw.replace(/```json|```/g, '').trim();

  let result;
  try {
    result = JSON.parse(clean);
  } catch {
    return json({ error: 'Kon het antwoord van Claude niet lezen.', raw: clean }, 502);
  }

  // Deterministische mapping: de door de gebruiker gekozen modus bepaalt de output-modus,
  // ongeacht wat het model invulde. notitie => acties, vergadering => verslag.
  result.mode = mode === 'vergadering' ? 'verslag' : 'acties';

  // Notion-write: draait NA de classificatie en mag de gebruiker nooit blokkeren.
  // Fouten worden serverside gelogd; 'result' gaat altijd terug.
  try {
    const captureId = crypto.randomUUID();
    let meetingId = null;
    if (mode === 'vergadering' && env.NOTION_TOKEN) {
      const meeting = await createMeeting(env, result, transcript);
      meetingId = meeting && meeting.id ? meeting.id : null;
    }
    await writeToInbox(env, result, mode, transcript, captureId, meetingId);
  } catch (e) {
    console.error('[notion] onverwachte fout:', e && e.message);
  }

  return json({ result });
}
