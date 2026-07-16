# PRODUCT.md

## Register
product

## What this is
Admin panel for the Uudam Travel Messenger chatbot: a Mongolian travel agency's
staff manage the trip catalog, leads, payments, and bot behavior here. The AI
Assistant tab is the primary data-entry surface: staff drop trip posters /
price lists (image, PDF, Excel) or type an instruction, the AI proposes catalog
changes, staff review and approve. Nothing writes to the catalog without an
explicit human approval.

## Users
- The developer (technical, builds and QAs everything).
- Uudam agency staff (non-technical, Mongolian-speaking, on desktop and phone).
  They think in trips, prices, and departure dates — not in records or fields.

## Primary task per screen
AI Assistant: upload → read the AI's proposal → answer at most a couple of
clarifying questions → press one button to save. The review must read like a
chat with a colleague, not like a database migration report.

## Brand personality
Calm, warm, competent. "Easy, simple, nice" (owner's words). The assistant
talks like a person; the UI never shouts.

## Anti-references (owner-stated, hard)
- System-alert styling on conversational messages (info icons, warning
  triangles, amber boxes) — the assistant must look like a chat, ChatGPT /
  Messenger register.
- English strings in customer- or client-facing surfaces; everything the
  agency staff sees is Mongolian.
- Machine-label copy ("«X» / «Y»: error text") — full sentences only.

## Design system
Committed tokens in `src/styles/globals.css`: travel-teal brand (#0f766e),
warm neutral surfaces, Manrope (cyrillic-ext required for Ө/Ү), JetBrains Mono
for data, radius/shadow/motion scales, global reduced-motion handling.
Components in `src/components/ui.tsx` (Button, Badge, Card, Icons, Modal...).
Use these; do not invent parallel primitives.

## Accessibility
Mongolian Cyrillic throughout; non-technical users; keyboard focus system is
global (focus-visible outline / input ring). Contrast per tokens is AA-checked
(2026-06-14 pass). Keep body text at ink / ink-muted, never ink-subtle.
