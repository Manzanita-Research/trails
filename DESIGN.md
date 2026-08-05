<!-- Direction seed key: a447f2f2 (concept-seed --scope direction --mode operate). Committed 2026-07-27 as "Pacific Light", then user-revised: the sky gradient was killed as a data background; its palette folds into the app scheme and project colors. Supersedes the discarded one-shot prototype look. Tokens below reflect the shipped build (src/styles.css). -->

---
name: trails
description: Where your days actually went — work memory as flat ink and coastal color on quiet ground.
---

# Design System: trails

## Overview

**Creative North Star: "Pacific Light, folded in"**

trails takes its color from a Northern California coastal day — pre-dawn indigo, marine-layer blue, golden-hour amber, dusk mauve — but wears it as a palette, never as a picture. There is no gradient, no scenery, no atmosphere backdrop: the user explicitly killed the sky-band ("I would prob kill the gradient background entirely — fold the colors into the color scheme"). Each project/client/bucket owns one of the sky colors, and a day is drawn as those colors sitting as precise flat bars on warm fog-white ground.

The character is contemporary California calm: simple like the original prototype, crisp like fine typesetting, warm through color choice alone. Days live on discrete pages you page through quickly (yesterday, the day before) so how your time changed is one keystroke away; the week stacks the same strips for the ritual review. No kitsch, no retro print, no productivity-app scorekeeping.

**Key Characteristics:**
- Flat everything: solid colors, no gradients, no shadows, no textures, no decorative imagery
- Sky-derived project colors are the only chroma; the chrome around them is ink on fog
- One lane per project: a pale wash spans agent-active time, solid full-color marks overlay where you were present
- Dense timeline: lanes ~14–16px tall with small gaps, like the original prototype — the day reads at a glance
- Discrete day pages with fast prev/next paging; week view stacks the same strips
- Editorial, unboxed layout: air and alignment instead of cards and borders

## Colors

Warm neutral ground, dusk ink, and a small set of coastal project colors; chroma belongs to the user's work, not to the chrome.

### Primary (engagement colors, assigned per project/client/bucket — CSS vars `--s1`…`--s8`)
- **Dawn Indigo** `#33406e` (`--s1`): deep pre-dawn blue.
- **Golden Hour** `#cf8f3a` (`--s2`): late-light amber.
- **Marine** `#5b7c99` (`--s3`): marine-layer blue-grey.
- **Dusk Mauve** `#8a7fa8` (`--s4`): evening lavender.
- **First Light** `#6b7bb0` (`--s5`), **Last Light** `#a4622a` (`--s6`), **Deep Marine** `#3c5a73` (`--s7`), **Deep Mauve** `#5f5680` (`--s8`): deeper/lighter variants of the same four hue families for engagements 5–8. No new hue families beyond these.

### Neutral
- **Fog Ground** `#faf7f1` (`--ground`): page background everywhere.
- **Dusk Ink** `#232936` (`--ink`): primary text; never pure black.
- **Prose Ink** `#3a3f4c` (`--prose`): serif body text (summaries).
- **Quiet Ink** `#62687a` (`--quiet`): secondary text — metadata, hour labels, nav at rest. Dark enough to clear 4.5:1 on Fog Ground; it carries real reading text, so it must stay there.
- **Muted** `#9a988f` (`--muted`): slotless/"elsewhere" projects and disabled controls only — never text someone needs to read.
- **Hairline** `rgba(35,41,54,0.12)` (`--hairline`): hour gridlines and the rare structural rule.

### Named Rules
**The Folded Sky Rule.** The palette is the coastal day folded into the interface: project colors come from sky moments (dawn, marine layer, golden hour, dusk) and no hue outside that family enters the system.
**The Tint Rule.** In a timeline lane, a pale wash (~20–28% of the project color, slightly slimmer) spans all agent-active time, and full-strength solid marks layer on top of it wherever the person was actually present — the prototype's layered grammar, kept. Agent time with no presence reads as bare wash. No second encoding — no icons, hatching, or badges.
**The No Scenery Rule.** No photography, illustration, texture, or gradient behind or around data — ever.
**Evidence images.** Captured imagery may appear inside a bounded content record as source evidence. It never sits behind or around the timeline, data, or chrome, and it never becomes project-world scenery.

## Typography

**Display & UI Font:** General Sans (with system-ui fallback) — crisp contemporary grotesk; Medium gives display headings their clear, assured shape.
**Text Font:** Recia (with Georgia fallback) — warm, sturdy serif for session summaries and prose, with its true italic for thread states.
**Code Font:** Commit Mono, the Manzanita brand cut (self-hosted variable woff2 with the brand's feature settings: ss01–ss05, cv01/03/04/06/11, slight negative tracking). Summarizer prose arrives with backticked identifiers; those render as inline `code` set in the mono at ~0.86em of the surrounding serif, ink-colored, with no background, border, or pill — a voice change, not a chip.

**Character:** Sharp modern structure holding warm readable content — the grotesk does wayfinding and numbers, the serif does memory.

### Hierarchy
- **Display** (General Sans 500, clamp(2.1rem, 4.5vw, 3.3rem), 1.05): the day/date heading. One per view.
- **Title** (500, ~1.02rem): day rows in the week view, thread names.
- **Body** (Recia 400, ~1.02rem, 1.5–1.6): session summaries, prose.
- **Label** (500, ~0.72–0.95rem): lowercase everywhere — nav, lane labels, section labels, and project names (name + inline swatch, same grammar as threads). No tracked uppercase; it read as shouting next to the serif.
- **Tabular** (500, ~0.95rem, `font-variant-numeric: tabular-nums`): all times and durations.
- **Code** (Commit Mono 400, 0.86em relative to its prose): backticked identifiers inside summaries and thread snippets. Unmatched backticks stay literal text.

### Named Rules
**The Lowercase Wordmark Rule.** "trails" is always lowercase, set in the grotesk, never decorated.

## Layout

Single calm column, max-width ~1100px, left-aligned, generous top air. A day is one page: a prev/next pager row pinned at the column edges above the date (fixed positions, so the buttons never move as date widths change; arrow keys work too, and the pager repeats at the foot of the page), then display date, attention facts, and the lane timeline — that whole header sticks under the topbar on desktop, with a hairline appearing only once stuck. Below it, the day's story — one short serif paragraph per project, in timeline order, under the label "the day, by project." While the story scrolls, the timeline acts as a table of contents: the lane label of the project currently under the header turns ink and semibold. Paging always starts the new day from the top. On phones the header doesn't stick — it would eat the screen. No raw session log anywhere — not on the day page, not in project detail. The paragraphs are the distilled version of that material, the timelines carry the times, and hover tooltips name the project and span. trails is memory, not forensics; the strongest per-session trace that remains is a thread's latest-session snippet. The timeline sits on plain ground with faint hairline hour ticks; lane labels sit in quiet ink at the left. The week view stacks seven slim day strips with date and attention in a left meta column, same bar grammar at smaller scale. Unboxed throughout: no cards, no zebra striping.

## Elevation & Depth

Flat, fully. No shadows, no layering effects; hierarchy comes from scale, weight, color, and air. Any unavoidable floating layer separates with Fog Ground plus a hairline.

## Shapes

Sharp-edged bars (no radius or ≤2px). Day-page lanes are dense: solid presence marks ~14px tall over ~8px washes, lanes separated by small gaps so the timeline reads as one compact block; week strips use the same grammar at ~5px. Containers are invisible; where a boundary is needed, a hairline. No pills, chips, or rounded cards.

## Network and State Behavior

The browser is a reader/editor over the hub's canonical state, not a local cache owner. Render the shell immediately, then one calm loading sentence while the first bootstrap arrives. An empty database is a legitimate first-run state: explain that no sessions have arrived and point to `trails collect --once`; never mention source-repository scripts or generated JSON.

After the first successful load, preserve the last complete snapshot through polling or mutation failures. Show one quiet inline sync message with an explicit retry action; do not blank the day, replace it with skeletons, or pretend a failed write succeeded. Mutations are asynchronous and controls disable only for the record being saved. Server acknowledgement and the next canonical bootstrap decide the visible state.

Settings, assignments, engagement names, project display names, pocket items, summaries, and session observations are shared hub state. View selection, open panels, current day, and current project remain transient browser navigation. A second browser should converge through revision polling without reload, but synchronization adds no notification badge, toast stack, or collaborative-presence chrome.

## Do's and Don'ts

### Do:
- **Do** give every project/client/bucket exactly one sky color and keep it stable across day, week, and thread views.
- **Do** layer solid presence marks over the pale agent wash in the same lane (The Tint Rule) — the wash-vs-solid contrast is the product's core reading: your attention vs agents spinning.
- **Do** show both totals side by side (attention and agents, labeled just "agents"; durations set as "3h 26m" with a non-breaking space) wherever a day or week is totaled — day pages, week facts, project detail. The week's per-day meta may carry attention and credit alone; its strip already draws agent time as wash.
- **Do** keep day pages discrete and fast to page between — how time changed day-over-day is a core reading.
- **Do** write states as plain lowercase words: in motion, waiting on you, resting, dormant.
- **Do** let empty time be empty ground — gaps are the day breathing.

### Don't:
- **Don't** use gradients anywhere — the sky-band background was explicitly killed; its colors live only as flat tokens.
- **Don't** place photography, illustration, or texture behind or around data (The No Scenery Rule).
- **Don't** use progress rings, streaks, KPI tiles, badges, or scorekeeping — memory, not performance review.
- **Don't** reach for retro print styling — warmth comes from the palette, not nostalgia.
