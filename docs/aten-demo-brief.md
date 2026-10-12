# Aten demo — fictional story, moves, and facts (shared brief)

Every builder works from this. Numbers here are the canonical demo facts; if the
fixture builder must adjust one for internal consistency (e.g. totals must equal
the sum of lines), they write the final value back into `FACTS` at the top of
`knowledge.md` and `scenario.md` is reconciled afterwards.

## The fictional project (invented — nothing from real client data)

- **Project:** Al-Marsa Business Park — Phase 2, LV Switchboards
- **Client:** Marsa Developments (Egypt)
- **Consultant:** Delta Consulting Engineers
- **Currency:** EGP. FX 48.50 EGP/USD. Copper 9,850 USD/t.
- **Price version:** "Oct 2026 — ABB list" (catalogue brand ABB: Emax 2 ACBs, Tmax XT MCCBs, Formula/SACE MCBs).
- **Markup (negotiated per project):** 18 %. VAT 14 %.
- **Credits:** balance 12. One analysis costs exactly 1 credit (this is how the real product charges). The demo project's analysis has already been paid for.
- **Uploaded RFP package (5 files):**
  1. `Al-Marsa-Ph2-Panel-Schedule.xlsx` — panel/load schedule
  2. `Al-Marsa-Ph2-SLD.pdf` — single-line diagram
  3. `Al-Marsa-Ph2-LV-Spec.pdf` — technical specification
  4. `Al-Marsa-Ph2-BOQ.xlsx` — bill of quantities
  5. `Al-Marsa-Ph2-AVL.pdf` — approved vendor list

### Boards (7)

| Tag | Name | Rating | Poles | Icu | Form | Incomer | Outgoing feeders | Cost (EGP) |
|---|---|---|---|---|---|---|---|---|
| MDB-01 | Main Distribution Board | 2500 A | 4P | 65 kA | 3b | Emax 2 E2.2 2500A | 12 | 1,860,000 |
| EMDB-01 | Emergency Main Board | 1000 A | 4P | 50 kA | 3b | Emax 2 E1.2 1000A | 8 | 742,000 |
| SMDB-01 | Sub-main Board, Block A | 800 A | 4P | 36 kA | 2b | Tmax XT6 800A | 10 | 486,000 |
| SMDB-02 | Sub-main Board, Block B | 800 A | 4P | 36 kA | 2b | Tmax XT6 800A | 10 | 481,000 |
| MCC-01 | Pump Motor Control Centre | 630 A | 3P | 36 kA | 3b | Tmax XT5 630A | 6 motor starters | 598,000 |
| DB-P1 | Power DB, Block A L1 | 400 A | 4P | 25 kA | 2b | Tmax XT3 400A | 18 | 262,000 |
| DB-L1 | Lighting DB, Block A L1 | 250 A | 4P | 25 kA | 2b | Tmax XT2 250A | 24 | 191,000 |

- **Cost total:** 4,620,000 EGP. **Selling (18 % markup):** 5,451,600 EGP. **With VAT:** 6,214,824 EGP.
- **Supply only** — no installation, freight, or site labour in the price.

### Review items the demo shows

- **Names conflict (1):** schedule says `SMDB-2`, SLD says `SMDB-02` → resolved to `SMDB-02`.
- **Gaps (2):**
  1. `DB-L2` appears on the SLD but has no row in the schedule → gap card, suggested: add as 250 A lighting DB (declined in the demo: "to be confirmed by consultant").
  2. Spec clause 4.7 mentions a "fire pump control panel" that is not on any schedule or drawing → gap card, left open.
- **Short-circuit withstand check:** every incomer Icu ≥ bus fault rating. One flag: DB-P1 was matched to a Tmax XT3 with Icu 25 kA against a stated 36 kA bus. The audit FLAGS it (it never auto-upgrades); the fixture shows the flag with the suggested override "XT3 N, 36 kA" and the engineer applies it. This is the "signal" moment in the Boards screen.
- **Compliance / deviation matrix (6 consultant comments):**
  1. Form of separation 4b required — **Deviation**: Form 3b offered (cost and lead time); 4b available on request at +12 %.
  2. IP rating IP54 indoor — Comply.
  3. Busbar copper, tin-plated — Comply.
  4. Type-tested assembly per IEC 61439-2 — Comply (ABB SACE ArTu system).
  5. Spare ways 20 % on all DBs — Comply with note (provided as blank modules).
  6. Surge protection Type 1+2 at MDB — Comply.
- **Export:** Technical Offer (PDF, 14 pages) and Commercial Offer (Excel + PDF). Both "ready" in the demo; download shows a canned file.

## Moves the demo exposes (tool names are final)

| Move | Args | What it does |
|---|---|---|
| `go_to_screen` | `screen` enum: `projects`, `new_quote`, `project_home`, `input`, `names`, `gaps`, `boards`, `pricing`, `compliance`, `export`, `catalogue`, `design_rules`, `credits`, `guide` | Navigates. Project-stage screens open the demo project automatically. |
| `point_at` | `target` enum of `data-demo` targets (builder defines; ~15–25 targets) | Scrolls to and highlights an element with the cursor hovering, no click. |
| `click` | `target` enum (subset of targets that are clickable) | Cursor moves and clicks. |
| `select_board` | `board` enum of the 7 tags | On Boards: opens that board in the workbench. Navigates to Boards first if needed. |
| `set_markup` | `percent` number 0–60 | On Pricing: types the new markup, totals recompute live from the fixture costs. |
| `simulate_analysis` | — | On New quote: shows the 5 files listed as uploaded, then plays a staged progress (reading schedule → reading SLD → matching catalogue → sizing → pricing) over ~8 s, then lands on Project home. Honours stop. |
| `run_export` | `document` enum: `technical_offer`, `commercial_offer` | On Export: clicks generate, shows a short progress, then "Ready — download". |
| `reset_demo` | — | Fixtures back to initial state, go to projects list. |

The bridge state object: `{ screen, projectName, selectedBoard, markupPercent }`.

## `data-demo` targets (minimum set; the builder may add)

`nav_new_quote`, `nav_catalogue`, `nav_design_rules`, `nav_guide`, `project_row`,
`stage_sidebar`, `home_inbox`, `input_files`, `names_conflict`, `gap_card_1`,
`gap_card_2`, `board_row_MDB-01` … `board_row_DB-L1` (7), `incomer_line`,
`withstand_flag`, `feeder_table`, `markup_input`, `pricing_totals`,
`compliance_matrix`, `deviation_row`, `export_technical`, `export_commercial`,
`download_button`, `credits_balance`, `catalogue_summary`.
