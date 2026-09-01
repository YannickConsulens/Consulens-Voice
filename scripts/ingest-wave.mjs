// Haalt nieuwe Wave-sessies op en zet ze in de Consulens Voice — Inbox.
//
// Draait als GitHub Action (zie .github/workflows/ingest-wave.yml), op cron.
// Flow: Wave-sessie -> Claude verfijnt (NL/BIM-correctie, projectgok, modus) ->
//   bij een vergadering een 📅 Vergaderingen-record + één Inbox-pagina met de
//   actiepunten als checkboxes; bij een notitie enkel een Inbox-pagina.
// Yannick triageert daarna in Notion (project bevestigen, items aanvinken,
// Status = Bevestigd); promote-inbox.mjs neemt de aangevinkte items over naar Taken.
//
// Dedup via het Inbox-veld "Capture-ID" = de Wave-sessie-ID: een sessie die al
// een Inbox-rij heeft, wordt overgeslagen.
//
// Secrets: NOTION_TOKEN, ANTHROPIC_API_KEY, WAVE_API_TOKEN.
// Token-onafhankelijk testen: draai met  --mock <bestand.json>  (een JSON-array
// van genormaliseerde sessies); dan is geen WAVE_API_TOKEN nodig.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  DS, notion, queryAll, richTextValue, buildProjectIndex, matchProject,
  normalizeDate, today, buildActieRegel, claudePolish,
} from './lib.mjs';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WAVE_API_TOKEN = process.env.WAVE_API_TOKEN;
const WAVE_API_BASE = process.env.WAVE_API_BASE || 'https://api.wave.co/v1';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
}
const MOCK_FILE = process.env.MOCK_SESSIONS_FILE || argFlag('--mock');
const DRY_RUN = process.argv.includes('--dry-run'); // classificeer + toon, schrijf NIET naar Notion

// ─────────────────────────────────────────────────────────────────────────────
// WAVE-ADAPTER — het ENIGE deel dat de Wave-API raakt. Bij go-live (betaald plan +
// token) hier de exacte veldnamen/paginatie tegen de live API verifiëren. Alles
// hierna werkt op de genormaliseerde vorm en hoeft niet te wijzigen.
//
// Genormaliseerde sessie:
//   { id, title, type, timestamp, summary,
//     actionItems: [{ text, owner, due }], transcript }
// ─────────────────────────────────────────────────────────────────────────────
async function wave(path) {
  const resp = await fetch(`${WAVE_API_BASE}${path}`, {
    headers: { authorization: `Bearer ${WAVE_API_TOKEN}`, 'content-type': 'application/json' },
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Wave ${resp.status} op ${path}: ${detail}`);
  }
  return resp.json();
}

export function normalizeTranscript(tr) {
  if (typeof tr === 'string') return tr;
  if (!tr) return '';
  if (typeof tr.transcript === 'string' && tr.transcript.trim()) return tr.transcript;
  const segs = tr.segments || tr.utterances || (Array.isArray(tr.transcript) ? tr.transcript : []);
  if (Array.isArray(segs) && segs.length) {
    return segs.map((x) => {
      const spk = x.speaker || x.speaker_name || '';
      const txt = x.text || x.content || '';
      return spk ? `${spk}: ${txt}` : txt;
    }).join('\n');
  }
  return tr.text || '';
}

export async function fetchWaveSessions() {
  // Mock-modus: lees genormaliseerde sessies uit een bestand (token-onafhankelijk).
  if (MOCK_FILE) {
    const arr = JSON.parse(readFileSync(MOCK_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [arr];
  }
  if (!WAVE_API_TOKEN) throw new Error('WAVE_API_TOKEN ontbreekt (en geen --mock opgegeven).');

  // GET /v1/sessions -> { sessions:[{id,title,timestamp,duration_seconds,type,platform}], next_cursor, has_more }.
  // Newest-first; 25 volstaat bij een cron van 15 min (dedup in Notion vangt de rest).
  const list = await wave('/sessions?limit=25');
  const sessions = list.sessions || [];
  const out = [];
  for (const s of sessions) {
    const id = s.id;
    if (!id) continue;
    // Detail bevat summary (markdown) + action_items (velden: text, assignee, due_date).
    const detail = await wave(`/sessions/${id}`).catch(() => s);
    const items = detail.action_items || s.action_items || [];
    const actionItems = items.map((it) => ({
      text: it.text || it.title || it.description || '',
      owner: it.assignee || it.owner || '',
      due: it.due_date || it.due || '',
    })).filter((it) => it.text);
    let transcript = '';
    try {
      transcript = normalizeTranscript(await wave(`/sessions/${id}/transcript`));
    } catch (e) { console.error(`[wave] transcript ${id} mislukt:`, e.message); }
    out.push({
      id: String(id),
      title: detail.title || s.title || '',
      type: detail.type || s.type || '',
      timestamp: detail.timestamp || s.timestamp || '',
      summary: detail.summary || '',
      actionItems,
      transcript,
    });
  }
  return out;
}

// ── Claude-classificatie ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Je bent een assistent voor Yannick, solo BIM-consultant bij Consulens.
Je krijgt een opname uit de notetaker Wave: een titel, een type, een samenvatting, een lijst
voorgestelde actiepunten en (soms) het ruwe transcript. Maak er een gestructureerd verslag of
actielijst van.

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

Modus-regel:
- Kies zelf de modus op basis van de INHOUD en het aantal sprekers in het transcript.
  (Het Wave-opnametype is enkel het toestel en zegt NIETS over de aard.)
- Meerdere sprekers of duidelijke besluiten => mode = "verslag".
- Een solo-ingesproken notitie of losse gedachte => mode = "acties".

Inhoudelijke regels:
- Vertrek van de door Wave voorgestelde actiepunten, maar verfijn: verwijder dubbels/ruis,
  splits samengestelde taken, en voeg duidelijke impliciete taken toe. Behoud een houder en
  deadline als Wave die aangaf.
- Als geen houder vermeld => gebruik "Yannick".
- Vul bij elk actiepunt 'project' in: je beste gok van de projectnaam waartoe het hoort
  (vrije tekst, geen ID). Ken je het niet => null.
- Bij een vergadering: vul 'vergadering.beslissingen' met alle genomen beslissingen (elk als
  losse korte zin), 'aanwezigen' met de vermelde namen, en 'titel' met een korte omschrijving.
- Datums ALTIJD als YYYY-MM-DD (ISO). Reken relatieve datums niet zelf om als je de opnamedatum
  niet kent => gebruik null en laat het in de omschrijving staan.
- Spreek de gebruiker aan met "je/jij" in de samenvatting.

Transcriptiecorrectie (Nederlands, bouw & BIM):
- Corrigeer stil (zonder het te vermelden) foutief herkende vaktermen en eigennamen naar de
  juiste vorm, zolang de betekenis duidelijk is.
- Termen o.a.: Revit, BIM, IFC, LOD, LOI, Navisworks, AutoCAD, Civil 3D, Dynamo, Speckle,
  Solibri, clash detection, federatiemodel, as-built, coördinatiemodel, meetstaat, bestek,
  VMSW, aanbestedingsdossier, uitvoeringsdossier, EPB, stabiliteit, wapening, bekisting,
  spouwmuurisolatie, gewapend beton, funderingen, riolering, RioAK, nutsleidingen, ruwbouw,
  afwerking, oplevering, werfvergadering, bouwheer, architect, studiebureau, aannemer.
- Voorbeelden: "rivet"/"revid" => "Revit"; "i f c" => "IFC"; "navis works" => "Navisworks";
  "meet staat" => "meetstaat"; "V M S W" => "VMSW".
- Corrigeer enkel wat duidelijk bedoeld is; verzin geen inhoud.`;

function projectHint(namen) {
  if (!namen || !namen.length) return '';
  return `\n\nDit zijn de actieve projecten: ${namen.join(', ')}. `
    + `Kies voor elk actiepunt het meest waarschijnlijke project EXACT zoals het in deze lijst `
    + `staat en zet het in het veld 'project'. Past geen enkel project duidelijk, laat 'project' `
    + `leeg. Verzin nooit een projectnaam die niet in de lijst staat.`;
}

export function sessieAlsPrompt(s) {
  const acties = (s.actionItems || []).map((a) => {
    const extra = [a.owner ? `houder: ${a.owner}` : '', a.due ? `deadline: ${a.due}` : ''].filter(Boolean).join(', ');
    return `- ${a.text}${extra ? ` (${extra})` : ''}`;
  }).join('\n') || '(geen)';
  return `Wave-titel: ${s.title || '(geen)'}\n`
    + `Wave-opnametype (toestel, GEEN indicatie van aard): ${s.type || '(onbekend)'}\n`
    + `Opnamedatum: ${normalizeDate(s.timestamp) || '(onbekend)'}\n\n`
    + `Wave-samenvatting:\n${s.summary || '(geen)'}\n\n`
    + `Door Wave voorgestelde actiepunten:\n${acties}\n\n`
    + `Ruw transcript:\n${s.transcript || '(niet beschikbaar)'}`;
}

// ── Notion-blokken ───────────────────────────────────────────────────────────
export function heading(text) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: String(text).slice(0, 1900) } }] } };
}
export function paragraph(text) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: String(text || '').slice(0, 1900) } }] } };
}
function bullet(text) {
  return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: String(text || '').slice(0, 1900) } }] } };
}
export function todo(text) {
  return { object: 'block', type: 'to_do', to_do: { checked: false, rich_text: [{ type: 'text', text: { content: String(text || '').slice(0, 1900) } }] } };
}
function transcriptBlocks(transcript) {
  const t = String(transcript || '').trim();
  const out = [];
  for (let i = 0; i < t.length && out.length < 80; i += 1900) out.push(paragraph(t.slice(i, i + 1900)));
  return out;
}

async function createPage(dataSourceId, properties, children) {
  const payload = { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties };
  if (children && children.length) payload.children = children.slice(0, 100);
  return notion(NOTION_TOKEN, 'pages', 'POST', payload);
}

// 📅 Vergaderingen-record (bij een meeting).
async function createMeeting(s, result, projectId) {
  const v = result.vergadering || {};
  const samenvatting = result.samenvatting ? String(result.samenvatting) : '';
  const beslissingen = Array.isArray(v.beslissingen) ? v.beslissingen.filter(Boolean) : [];
  const aanwezigen = Array.isArray(v.aanwezigen) ? v.aanwezigen.filter(Boolean).join(', ') : String(v.aanwezigen || '');
  const datum = normalizeDate(v.datum) || normalizeDate(s.timestamp) || today();
  const titel = (v.titel && String(v.titel).trim()) || s.title || (samenvatting ? samenvatting.slice(0, 60) : `Vergadering ${datum}`);

  const properties = {
    'Titel': { title: [{ text: { content: String(titel).slice(0, 200) } }] },
    'Status': { select: { name: 'Gehouden' } },
    'Datum': { date: { start: datum } },
  };
  if (aanwezigen) properties['Aanwezigen'] = { rich_text: [{ text: { content: aanwezigen.slice(0, 1900) } }] };
  if (v.locatie) properties['Locatie'] = { rich_text: [{ text: { content: String(v.locatie).slice(0, 1900) } }] };
  if (projectId) properties['Project'] = { relation: [{ id: projectId }] };

  const children = [];
  if (samenvatting) { children.push(heading('📝 Samenvatting')); children.push(paragraph(samenvatting)); }
  if (beslissingen.length) { children.push(heading('✅ Beslissingen')); beslissingen.forEach((b) => children.push(bullet(b))); }
  children.push(heading('📌 Acties'));
  children.push(paragraph('De actiepunten van deze vergadering staan in de Inbox (status "Te bevestigen") en verschijnen na bevestiging bij "Actiepunten".'));
  if (String(s.transcript || '').trim()) { children.push(heading('🎙 Ruw transcript')); transcriptBlocks(s.transcript).forEach((b) => children.push(b)); }

  const page = await createPage(DS.VERGADERINGEN, properties, children);
  return page && page.id ? page.id : null;
}

// Eén Inbox-pagina met samenvatting + actiepunten als checkboxes.
async function createInboxPage(s, result, mode, meetingId, projectId) {
  const isMeeting = mode === 'vergadering';
  const samenvatting = result.samenvatting ? String(result.samenvatting) : '';
  const actiepunten = Array.isArray(result.actiepunten) ? result.actiepunten.filter((a) => a && (a.omschrijving || a.text)) : [];
  const titel = (isMeeting && result.vergadering && result.vergadering.titel)
    || s.title || (samenvatting ? samenvatting.slice(0, 80) : `Notitie ${today()}`);

  const properties = {
    'Titel': { title: [{ text: { content: String(titel).slice(0, 2000) } }] },
    'Status': { select: { name: 'Te bevestigen' } },
    'Modus': { select: { name: isMeeting ? 'Vergadering' : 'Notitie' } },
    'Type': { select: { name: actiepunten.length ? 'Actiepunt' : 'Notitie' } },
    'Samenvatting': { rich_text: [{ text: { content: samenvatting.slice(0, 1900) } }] },
    'Reden': { rich_text: [{ text: { content: String(result.reden || '').slice(0, 1900) } }] },
    'Capture-ID': { rich_text: [{ text: { content: String(s.id).slice(0, 1900) } }] },
  };
  if (meetingId) properties['Vergadering'] = { relation: [{ id: meetingId }] };
  if (projectId) properties['Project'] = { relation: [{ id: projectId }] };

  const children = [];
  if (samenvatting) { children.push(heading('📝 Samenvatting')); children.push(paragraph(samenvatting)); }
  children.push(heading('✅ Voorgestelde actiepunten'));
  if (actiepunten.length) actiepunten.forEach((a) => children.push(todo(buildActieRegel(a))));
  else children.push(paragraph('(geen actiepunten voorgesteld)'));
  // Ruw transcript enkel bij een notitie (bij een meeting staat het in het 📅 record).
  if (!isMeeting && String(s.transcript || '').trim()) {
    children.push(heading('🎙 Ruw transcript'));
    transcriptBlocks(s.transcript).forEach((b) => children.push(b));
  }

  return createPage(DS.INBOX, properties, children);
}

// Kies de project-relatie voor de pagina: meest voorkomende projectgok van de actiepunten.
export function kiesProject(result, projectIndex) {
  const tellingen = new Map();
  for (const a of (result.actiepunten || [])) {
    const id = matchProject(a && a.project, projectIndex);
    if (id) tellingen.set(id, (tellingen.get(id) || 0) + 1);
  }
  if (!tellingen.size) return null;
  return [...tellingen.entries()].sort((x, y) => y[1] - x[1])[0][0];
}

async function main() {
  if (!NOTION_TOKEN && !DRY_RUN) throw new Error('NOTION_TOKEN ontbreekt.');
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY ontbreekt.');

  const sessions = await fetchWaveSessions();
  if (!sessions.length) { console.log('Geen Wave-sessies gevonden.'); return; }

  // Dedup op Capture-ID (tenzij dry-run).
  let seen = new Set();
  if (!DRY_RUN) {
    const inbox = await queryAll(NOTION_TOKEN, DS.INBOX);
    seen = new Set(inbox.map((p) => richTextValue(p.properties && p.properties['Capture-ID'])).filter(Boolean));
  }
  const nieuwe = sessions.filter((s) => !seen.has(String(s.id)));
  if (!nieuwe.length) { console.log('Geen nieuwe sessies (alles al in de Inbox).'); return; }

  const projectIndex = DRY_RUN ? [] : await buildProjectIndex(NOTION_TOKEN);
  const systemPrompt = SYSTEM_PROMPT + projectHint(projectIndex.map((p) => p.naam));

  let ok = 0;
  let fout = 0;
  for (const s of nieuwe) {
    try {
      const result = await claudePolish(ANTHROPIC_API_KEY, MODEL, systemPrompt, sessieAlsPrompt(s));
      const mode = result.mode === 'verslag' ? 'vergadering' : 'notitie';
      if (DRY_RUN) {
        console.log(`\n— ${s.title || s.id} [${mode}]`);
        console.log(`  samenvatting: ${result.samenvatting || ''}`);
        (result.actiepunten || []).forEach((a) => console.log(`  ☐ ${buildActieRegel(a)}  (project: ${a.project || '-'})`));
        ok++;
        continue;
      }
      const projectId = kiesProject(result, projectIndex);
      let meetingId = null;
      if (mode === 'vergadering') meetingId = await createMeeting(s, result, projectId);
      await createInboxPage(s, result, mode, meetingId, projectId);
      ok++;
      console.log(`✓ ${mode}: "${s.title || s.id}"${projectId ? ' (project voorgesteld)' : ''}${meetingId ? ' (+📅 record)' : ''}`);
    } catch (e) {
      fout++;
      console.error(`✗ Sessie ${s.id} mislukt:`, e.message);
    }
  }
  console.log(`Klaar: ${ok} verwerkt, ${fout} mislukt.`);
  if (fout > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('Onverwachte fout:', e); process.exit(1); });
}
