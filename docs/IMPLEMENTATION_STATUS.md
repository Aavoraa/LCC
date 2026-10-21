# Implementation status

The spec defines seven phases. This delivery covers **Phases 1–3** (foundation, item master, QR,
migration, inventory ledger, Android scanning) and **Phase 5 except capacity / process scheduling**
(availability, estimates, quotations, sales orders, reservations, requisitions, forecast recalculation,
committed-date approval).
Nothing below "Not implemented" exists in code — the UI marks those modules as planned and the
dashboard returns `null` for their metrics rather than sample numbers.

## Implemented

| Spec § | Feature | Where |
|---|---|---|
| 2, 13 | Normalized schema, FKs, unique/check constraints, NUMERIC(18,4), Alembic migration | `backend/app/models.py`, `backend/alembic/` |
| 12 | 11 roles, 28 permissions, backend-enforced RBAC, maker–checker (adjustments, imports, PO approval, delivery commitments) | `backend/app/seed.py`, `deps.py` |
| 4A | Item create: auto code per type (`PI-000001`…), all master fields, opening balance, fuzzy duplicate check with authorized override | `services/items.py`, `web/.../inventory/new` |
| 4A, 4C | Opaque QR (`/q/<token>`), PNG/SVG download, printable labels (3 sizes, copies), bulk print, regeneration that revokes the old token and keeps the item code, label verification by scan, bin/location QR | `services/qr.py`, `api/items.py`, `web/.../qr` |
| 4B | CSV/XLSX import: column auto-mapping, validation (type, unit, numbers, decimals, locations), duplicate detection vs DB and within file, per-row CREATE/LINK/SKIP, approval by a different user posts opening stock idempotently, legacy codes preserved | `services/imports.py`, `web/.../inventory/import` |
| 5 | Receipt, issue (requires SO/PO/PAD/WIP/assembly/requisition reference), transfer, return, QC hold/release, adjustment requests; confirmation step; offline queue with idempotent sync and explicit PENDING state | `services/stock.py`, `web/.../scan`, `mobile/` |
| 6, 13 | Append-only ledger, balance projection updated in the same transaction, row locking + optimistic versioning, weighted-average valuation, reconciliation report | `services/stock.py` |
| 7 | ATP = physical − reserved − QC hold; incoming approved POs shown separately; rule-based delivery estimate (lead times, approval days, production lead, QC/pack/dispatch/transport, Sunday + holiday calendar), risk + assumptions + dependencies; enquiries saved with estimate | `services/availability.py`, `web/.../sales` |
| 7 | Quotations from a saved enquiry (`QT-00001`), carrying the enquiry's preliminary estimated date and risk; DRAFT → SENT → ACCEPTED / REJECTED, validity date, audit events | `services/sales.py`, `api/sales_orders.py`, `web/.../sales` (Quotations tab) |
| 8.1–8.4 | Convert accepted quotation (or open enquiry) to a DRAFT sales order (`SO-00001`, one per enquiry/quotation). Confirm re-validates stock and **atomically reserves** free stock (row lock + version check, retried on conflict, idempotency key per SO line + location, never over-reserves); shortages not covered by supply raise **purchase requisitions** (`PR-00001`, kind PURCHASE or PRODUCTION) linked to the SO line; "allocate free stock" tops up later; cancel releases reservations and open requisitions | `services/sales.py`, `services/stock.reserve`, `web/.../sales` (Sales orders tab) |
| 8.4 | Procurement page lists requisitions; a purchase requisition converts to a draft PO (supplier default + lead time), which is pegged to that SO line once approved; cancel with reason | `api/sales_orders.py`, `web/.../purchase` |
| 5, 8 | Issue against `SALES_ORDER` consumes that order's reservation inside `post_movement` (reduces `qty_reserved`, tracks `qty_issued`, blocks over-issue and issues against unconfirmed orders; order completes when fully issued); reconciliation also checks reserved quantities | `services/stock.py` |
| 8.10–8.12 | Preliminary, forecast and committed dates kept separate. Rule-based forecast per SO line from pegged supply (see ARCHITECTURE "Forecast pegging"); recalculated on confirm, PO approval, goods receipt, PO line reschedule (`PATCH /api/purchase/orders/{po}/lines/{line}`) and cancel. Committed date: request ≥ forecast, approved by a **different** user with new `sales.commit_approve` (Management); approval refused if the forecast has since moved past it | `services/sales.py`, order drawer in `web/.../sales` |
| 11 | Dashboard "orders at risk" (confirmed orders whose forecast is later than the committed/required date) replaces the old enquiry-risk count; notifications when a forecast slips or an order becomes at risk; open SOs, pending commitments, open requisitions | `api/dashboard.py`, `web/src/app/(app)/page.tsx` |
| 9 (part) | Purchase orders (create → approve by other user → receive into QC hold) as the incoming-supply source for ATP | `api/sales_purchase.py`, `web/.../purchase` |
| 11 | App shell: collapsible sidebar, command palette (Ctrl K), breadcrumbs, quick-create, notifications, recent records, shortcuts help, light/dark theme, responsive layouts; inventory table with density, column visibility, saved filters, bulk select, side-panel detail + movement timeline; loading/empty/error/permission states | `web/src/components`, `web/src/app` |
| 11 | Executive dashboard from live queries (15 s polling) | `api/dashboard.py`, `web/src/app/(app)/page.tsx` |
| 15 (part) | Stock ledger (filter, CSV export), low/out-of-stock report, valuation by stream, ledger reconciliation, reorder notifications | `web/.../reports`, `web/.../stock/ledger` |
| — | Audit trail for every state change, login audit, structured request logs, `/health` | `services/common.py`, `main.py` |

## Machine SOP spare lists (added after Phase 5)

Source: LCC "Card Service Machines" catalogue (Oct 2023, 28 pages) — 10 machines (Wire Mounting Equipment, Multi Roller
Mounting, Flat End Milling, LFCM 100/40, LFGM 60/40, TSD 100/40, OFGM 60/40, Wire De-Mounting, BCG 40, MTWG 40) plus a
common accessories group; 109 spare lines in `backend/app/machine_catalog.py`, each with its catalogue page.

* `machines` / `machine_spares` tables (migration `da0601a39be4`). Each spare line has qty per machine, SOP stock per machine
  supported, criticality A/B/C, group, and **basis**: `CATALOGUE` (part named in the catalogue) or `DERIVED` (feature/spec
  described — motor, inverter, encoder, belts, bearings — but not listed as a spare). SOP quantities are proposed defaults.
* **Align with stores** (`services/machines.py`): exact-name match links; similar names are only *suggested* for manual
  review; unmatched spares can be created as stores items (code + QR, zero stock, category "Card Service Spares", reorder level =
  SOP stock). Spares shared by several machines reuse one stores item.
* **Stores check**: required = SOP stock × machines supported vs available (on hand − reserved − QC hold); statuses OK / Short /
  Out / Not in stores / On demand (SOP stock 0). Readiness % excludes on-demand lines.
* **Requisitions**: shortages net of open requisitions become `purchase_requisitions` (shared with Phase 5, converted to POs on
  the Procurement page). Re-running never double-orders.
* Duplicate detection (item create, import, spare alignment) now treats names whose numbers differ (8VG vs 12VG, 1.5 HP vs
  3 HP, M12x50 vs M12x60) as different parts.
* Web: Machines & SOP Spares list and detail (spec sheet, editable SOP list, link/create actions, stores check, requisitions).
* Tests: `backend/tests/test_machines.py` (5 tests).
* Not done: per-machine service history / installed-base register (machines supported is a single number), spare consumption
  against service jobs, item images from the catalogue.

## Verified

* `backend/tests/test_acceptance.py` — 18 tests mapped to spec §16 scenarios 1–8, 13–15: item+QR, regeneration,
  duplicate blocking, spreadsheet import with duplicates and maker–checker, bulk labels without duplicate QR,
  scan→receive→issue→balance, excessive/unauthorized issue blocked, QC hold excluded from ATP, estimates for
  sufficient stock / shortage / incoming PO, traceable ledger + reconciliation, adjustment approval by a different
  user, idempotent resubmission, offline batch sync, **concurrent issues cannot oversell**, auditor read-only.
* `backend/tests/test_sales_orders.py` — 6 tests for spec §16 scenarios 9 and 10: quotation carries the preliminary
  estimate and converts once; confirm reserves 30 of 40, raises a 10-unit requisition, is idempotent, protects reserved
  stock from other documents, SO issue consumes the reservation and blocks over-issue, requisition → PO → approval re-pegs
  the forecast; produced item raises a PRODUCTION requisition and cancel releases; supplier delay moves the forecast,
  keeps the committed date, flags the order at risk on the dashboard and notifies, and recovery clears it; maker–checker
  on commitments; **six racing confirmations of two orders for 16 units against 10 in stock reserve exactly 10** (8 + 2,
  one 6-unit requisition, ledger reconciles). Full suite: 24 passed.
* Migration `d02c9f51d5a7` upgrades, downgrades and re-upgrades on SQLite; `alembic check` reports no drift. Not yet run
  against PostgreSQL.
* Web: `next build` passes (lint + types, 20 routes). Browser check against a scratch API: Sales tabs, quotation list,
  order drawer with preliminary / forecast / committed dates and at-risk alert, Procurement requisitions with
  "Raise PO" creating a draft PO, dashboard at-risk card.
* Web: production build type-checks all 20 routes. Browser walk-through of: duplicate warning → create item →
  label preview → open QR URL → receive → dashboard valuation update; Sales estimate for a shortage; 375 px layout.
* Mobile: `tsc --noEmit` passes. **Not run on a device or emulator** — camera scanning on Android is untested.

## Not implemented (later phases)

* **Phase 4** — process-routing master, PAD/WIP, BOMs, outside processing, full QC inspection plans, requisition approval
  documents for consumables (issues currently require a document reference, not an approved requisition record).
* **Phase 5 (rest, needs Phase 4)** — spec §8 steps 5–9 and 11: PAD/WIP creation, process schedules, production-capacity
  reservation, outside-processing tracking, QC/assembly scheduling and departmental milestones. PRODUCTION requisitions are
  recorded and notified but nothing consumes them yet; forecasts for produced items use the item's production lead time,
  not work-centre capacity. Multi-line sales orders are supported by the schema and services but the UI creates one
  line per enquiry. Forecasts restart from today on each recalculation (no persisted milestone history beyond audit events).
* **Phase 6** — chart of accounts, journals, invoices, receipts/payments, GST, period locking, inventory-to-GL posting;
  Claude Vision invoice scanner (provider abstraction, review workspace).
* **Phase 7** — remaining registers/ageing/GL reports, configurable notification rules, backups automation, deployment manifests.
* FIFO valuation (only weighted average), batch/serial-level stock (fields and QR mapping exist; ledger is SKU-level),
  item images/attachments, file storage service.
