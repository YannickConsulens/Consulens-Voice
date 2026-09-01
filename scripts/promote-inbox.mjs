// Promoot aangevinkte actiepunten van bevestigde Inbox-pagina's naar ✅ Taken.
//
// Draait als GitHub Action (zie .github/workflows/promote.yml).
// Nieuw model (Wave): elke Inbox-PAGINA (één per opname) heeft de voorgestelde
// actiepunten als CHECKBOXES in de body. Yannick koppelt de pagina aan een Project,
// vinkt de gewenste items aan en zet Status = "Bevestigd".
// Dit script leest elke Bevestigde pagina, maakt van elk AANGEVINKT item een taak
// in ✅ Taken (met de Project- en Vergadering-relatie van de pagina, plus de
// deadline/prioriteit die in de checkbox-tekst zit), en zet de pagina daarna op
// "Gepromoveerd" met de aangemaakte taken gelinkt in "Gepromoveerde taak".
//
// De pagina-status Bevestigd -> Gepromoveerd is de poort tegen dubbele overname:
// een pagina wordt na verwerking nooit opnieuw bekeken.
//
// Enige nodige secret: NOTION_TOKEN.

import {
  DS, notion, queryAll, getBlockChildren, blockPlainText, titleText,
  richTextValue, buildProjectIndex, matchProject, parseActieRegel,
} from './lib.mjs';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) { console.error('NOTION_TOKEN ontbreekt.'); process.exit(1); }

// Maak één taak in ✅ Taken.
async function maakTaak({ taak, prioriteit, deadline, projectRel, vergaderingRel }) {
  const props = {
    'Taak': { title: [{ text: { content: String(taak).slice(0, 2000) } }] },
    'Type': { select: { name: 'Actiepunt' } },
    'Status': { select: { name: 'Te doen' } },
    'Prioriteit': { select: { name: prioriteit === 'Hoog' ? 'Hoog' : 'Middel' } },
  };
  if (deadline) props['Deadline'] = { date: { start: deadline } };
  if (projectRel && projectRel.length) props['Project'] = { relation: projectRel };
  if (vergaderingRel && vergaderingRel.length) props['Vergadering'] = { relation: vergaderingRel };
  const taakPage = await notion(NOTION_TOKEN, 'pages', 'POST', {
    parent: { type: 'data_source_id', data_source_id: DS.TAKEN },
    properties: props,
  });
  return taakPage.id;
}

async function markPage(pageId, taakIds) {
  const props = { 'Status': { select: { name: 'Gepromoveerd' } } };
  if (taakIds.length) props['Gepromoveerde taak'] = { relation: taakIds.map((id) => ({ id })) };
  await notion(NOTION_TOKEN, `pages/${pageId}`, 'PATCH', { properties: props });
}

async function main() {
  const filter = { property: 'Status', select: { equals: 'Bevestigd' } };
  const pages = await queryAll(NOTION_TOKEN, DS.INBOX, filter);
  if (!pages.length) { console.log('Geen bevestigde pagina\'s om te promoveren.'); return; }

  const projectIndex = await buildProjectIndex(NOTION_TOKEN);
  let taken = 0;
  let paginas = 0;
  let fout = 0;

  for (const page of pages) {
    const props = page.properties || {};
    try {
      const paginaProjectRel = (props['Project']?.relation || []).map((r) => ({ id: r.id }));
      const vergaderingRel = (props['Vergadering']?.relation || []).map((r) => ({ id: r.id }));

      const blocks = await getBlockChildren(NOTION_TOKEN, page.id);
      const checked = blocks.filter((b) => b.type === 'to_do' && b.to_do && b.to_do.checked);
      const heeftTodos = blocks.some((b) => b.type === 'to_do');

      const taakIds = [];

      if (checked.length) {
        // Nieuw model: promoveer elk aangevinkt item.
        for (const b of checked) {
          const { omschrijving, deadline, prioriteit } = parseActieRegel(blockPlainText(b));
          if (!omschrijving) continue;
          let projectRel = paginaProjectRel;
          if (!projectRel.length) {
            const id = matchProject(omschrijving, projectIndex);
            if (id) projectRel = [{ id }];
          }
          const taakId = await maakTaak({ taak: omschrijving, prioriteit, deadline, projectRel, vergaderingRel });
          taakIds.push(taakId);
          taken++;
        }
      } else if (!heeftTodos && props['Type']?.select?.name === 'Actiepunt') {
        // Legacy-compat: oude rij-per-actiepunt zonder checkboxes -> promoveer de titel.
        const taak = titleText(page) || 'Actiepunt';
        const prioNaam = props['Prioriteit']?.select?.name === 'Hoog' ? 'Hoog' : 'Middel';
        const deadline = props['Deadline']?.date?.start || null;
        let projectRel = paginaProjectRel;
        if (!projectRel.length) {
          const id = matchProject(richTextValue(props['Voorgesteld project']), projectIndex);
          if (id) projectRel = [{ id }];
        }
        const taakId = await maakTaak({ taak, prioriteit: prioNaam, deadline, projectRel, vergaderingRel });
        taakIds.push(taakId);
        taken++;
      }
      // (Pagina zonder aangevinkte items: niets te promoveren, gewoon afsluiten.)

      await markPage(page.id, taakIds);
      paginas++;
      console.log(`✓ Pagina "${titleText(page) || page.id}": ${taakIds.length} ta(a)k(en).`);
    } catch (e) {
      fout++;
      console.error(`✗ Fout bij pagina ${page.id}:`, e.message);
    }
  }

  console.log(`Klaar: ${paginas} pagina's afgehandeld, ${taken} taken aangemaakt, ${fout} mislukt.`);
  if (fout > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('Onverwachte fout:', e); process.exit(1); });
