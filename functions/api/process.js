// Cloudflare Pages Function — serverside proxy naar de Anthropic API.
// De app roept deze functie aan op /api/process, NOOIT api.anthropic.com direct.
// Zo blijft je API-sleutel geheim (server-side env var) en zijn er geen CORS-problemen.
//
// Vereist: een omgevingsvariabele ANTHROPIC_API_KEY in je Cloudflare Pages-project.

const MODEL = 'claude-sonnet-5';   // geldig, actueel model-ID (datumloos = vaste snapshot sinds 4.6). Wisselbaar naar 'claude-haiku-4-5' voor sneller/goedkoper.
const MAX_TOKENS = 2000;           // ruim genoeg voor een lang vergaderverslag

// ── Actieve projecten (stuurt de projectgok van Claude) ──
// Vul hier je actieve projectnamen in; Claude kiest bij voorkeur een van deze
// exacte namen voor 'project' als er een past, anders zijn beste vrije gok of null.
const ACTIEVE_PROJECTEN = [
  // 'Woonproject Aarschot',
  // 'VMSW Diest',
];

const PROJECT_HINT = ACTIEVE_PROJECTEN.length
  ? `\n\nActieve projecten (kies bij 'project' bij voorkeur een van deze exacte namen als die past; anders je beste vrije gok of null):\n- ${ACTIEVE_PROJECTEN.join('\n- ')}`
  : '';

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

// ── Notion Inbox (triage-stap) ─────────────────────────────────────────────
// Elke opname landt als losse rijen in de Inbox-data source op status
// "Te bevestigen". Yannick triageert daar later; een foute classificatie raakt
// zo nooit de echte data. Werkt op het data-sources-model (versie 2025-09-03)
// en schrijft naar een data_source_id, niet naar een database_id.
const NOTION_VERSION = '2025-09-03';
const INBOX_STATUS = 'Te bevestigen';

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

// Ruw transcript in paragraafblokken van ~1900 tekens (rich_text-limiet = 2000).
function transcriptBlocks(transcript) {
  const text = String(transcript || '').trim();
  if (!text) return [];
  const chunks = [];
  for (let i = 0; i < text.length; i += 1900) {
    chunks.push(text.slice(i, i + 1900));
  }
  // Notion staat max 100 blokken per create-call toe.
  return chunks.slice(0, 100).map((chunk) => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] },
  }));
}

async function createInboxPage(env, properties, children) {
  const payload = {
    parent: { type: 'data_source_id', data_source_id: env.NOTION_INBOX_DS_ID },
    properties,
  };
  if (children && children.length) payload.children = children;

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

// Schrijft elk actiepunt als losse Inbox-rij op status "Te bevestigen".
// Blokkeert de gebruiker nooit: fouten worden serverside gelogd, niet naar de
// frontend teruggegeven. De aanroeper geeft 'result' altijd terug.
async function writeToInbox(env, result, mode, transcript, captureId) {
  if (!env.NOTION_TOKEN || !env.NOTION_INBOX_DS_ID) {
    console.error('[inbox] NOTION_TOKEN of NOTION_INBOX_DS_ID ontbreekt - inbox-write overgeslagen.');
    return;
  }

  const samenvatting = result && result.samenvatting ? String(result.samenvatting) : '';
  const reden = result && result.reden ? String(result.reden) : '';
  const actiepunten = Array.isArray(result && result.actiepunten) ? result.actiepunten : [];

  // Context die op elke rij mee gaat, zodat triage zonder de opname kan.
  const gemeenschappelijk = () => ({
    'Status': selectProp(INBOX_STATUS),
    'Modus': selectProp(inboxModus(mode)),
    'Reden': richText(reden),
    'Samenvatting': richText(samenvatting),
    'Capture-ID': richText(captureId),
  });

  // Ruw transcript enkel bij de eerste gemaakte rij, om duplicatie te beperken.
  const body = transcriptBlocks(transcript);
  let transcriptGeplaatst = false;

  if (actiepunten.length === 0) {
    // Geen actiepunten => een Notitie-rij met de samenvatting als titel.
    const properties = {
      ...gemeenschappelijk(),
      'Titel': { title: [{ text: { content: (samenvatting || 'Notitie').slice(0, 2000) } }] },
      'Type': selectProp('Notitie'),
    };
    try {
      await createInboxPage(env, properties, body);
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
      await createInboxPage(env, properties, children);
      transcriptGeplaatst = true;
    } catch (e) {
      console.error(`[inbox] actiepunt-rij ${i} mislukt:`, e.message);
    }
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
        system: SYSTEM_PROMPT + PROJECT_HINT,
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

  // Notion Inbox-write: draait NA de classificatie en mag de gebruiker nooit
  // blokkeren. Fouten worden serverside gelogd; 'result' gaat altijd terug.
  try {
    const captureId = crypto.randomUUID();
    await writeToInbox(env, result, mode, transcript, captureId);
  } catch (e) {
    console.error('[inbox] onverwachte fout:', e && e.message);
  }

  return json({ result });
}
