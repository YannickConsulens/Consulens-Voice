# Design Plan — Consulens Voice

## Subject
Solo BIM-consultant, gebruikt de app staand op een werf of net na een vergadering.
E�n job: inspreken → verwerken → klaar voor ClickUp.

## Token system
- Ink: #0F1E35 (diepblauw-zwart, geen pure zwart)
- Brand: #1B3A6B
- Accent: #2E6FD8 (elektrisch blauw — de risico-keuze: helder en actief, niet het verwachte marine)
- Surface: #F7F9FC
- Card: #FFFFFF
- Muted: #8896A8
- Success: #1A7A4A
- Border: #DDE4EE

## Typography
- Display: system-ui / -apple-system (native — voelt vertrouwd op telefoon)
- Body: same, 16px, lh 1.6
- Mono: voor transcript-tekst — SFMono/Consolas, geeft "live transcriptie" gevoel

## Layout
Mobile-first, één kolom, 100dvh.
Grote centrale opnameknop (signature element) — pulseert tijdens opname.
Transcript scrollt live eronder.
Resultaat schuift op van onderaan (sheet-patroon).

## Signature element
De opnameknop: grote cirkel met ademende pulse-animatie in accent-blauw tijdens opname.
Geen gewone rode record-knop — dit voelt als een professioneel instrument, niet een dictafoon.

## PWA
manifest.json + service worker voor installatie op startscherm.
