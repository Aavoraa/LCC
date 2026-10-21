# Lakshmi Machine ERP — Architecture

## Phase 1 findings

The repository contained only `QR_Inventory_Sales_Accounts_Automation_Master_Prompt.md`.
There was no existing framework, database, auth system, or component library to preserve,
so the platform is built fresh using the stack preferred in the spec.

## Layout

```
backend/   FastAPI + SQLAlchemy 2 + Alembic (Python 3.12+)
web/       Next.js (App Router) + React + TypeScript + Tailwind CSS + Lucide
mobile/    Expo (React Native) Android app for storekeepers
docs/      Architecture, phase plan, API notes
```

## Key design decisions

| Concern | Decision |
|---|---|
| Database | PostgreSQL in production (`DATABASE_URL=postgresql+psycopg://...`). SQLite is the zero-setup local default so the slice runs without infrastructure. All money/quantity columns use `NUMERIC(18,4)`. |
| Migrations | Alembic, `backend/alembic/`. `alembic upgrade head` creates the schema. |
| Auth | JWT bearer tokens (PyJWT), PBKDF2-SHA256 password hashing (stdlib). |
| RBAC | `roles`, `permissions`, `role_permissions`, `user_roles` tables. Every endpoint declares a permission via `require_permission("stock.issue")`, enforced server-side. 11 roles seeded per spec §12. |
| Stock integrity | `stock_movements` is append-only. `stock_balances` is a projection (item × location) updated in the same DB transaction as the movement, with an optimistic `version` column (SQLAlchemy `version_id_col`) so concurrent writers cannot lose updates; on PostgreSQL rows are also locked with `SELECT … FOR UPDATE`. No endpoint edits balances directly. |
| Idempotency | Each movement carries a client-generated `txn_uuid` (unique). Re-submitting the same UUID returns the original movement instead of creating a second one — this is what makes offline Android sync safe. |
| Corrections | Stock adjustments are requests; a *different* user with `stock.adjust.approve` must approve (maker–checker) before an `ADJUSTMENT` movement is posted. |
| Valuation | Weighted average cost per item, recalculated on receipt; issues are valued at current average. Each movement stores `unit_cost` and `value` so valuation is reconcilable from the ledger. |
| QR content | An opaque random token (`LMQ1:<token>`) mapped in `qr_codes` to item (and optionally batch/serial). No cost/supplier data in the QR. Regeneration revokes the old token and issues a new one; the item's permanent `item_code` never changes. |
| ATP | `available = on_hand − reserved − qc_hold`. Incoming PO quantities are shown separately and never counted as immediately available. |
| Delivery estimate | Rule-based (configurable lead days + working calendar that skips Sundays and configured holidays). No AI involvement. |
| Audit | `audit_events` row for every state-changing service call (actor, action, entity, before/after JSON). |
| Reservations | `services/stock.reserve` is the only writer of `qty_reserved` besides issues. It locks and versions the item's balance rows, allocates default location first, and writes one `reservations` row per SO line + location (`idempotency_key = SO-LINE-<id>:L<loc>`). A concurrent loser gets a stale-version/lock error and is retried by `common.run_with_retry` with fresh data, so free stock is never reserved twice. `reconcile()` also checks `qty_reserved` = open active reservations. |
| SO issues | An `ISSUE` with `ref_doc_type=SALES_ORDER` matching a real SO must be for a confirmed order and an item on it, cannot exceed the outstanding quantity, may draw on that order's own reservation at the source location, and consumes it (`qty_consumed`, status `CONSUMED`) in the same transaction. Legacy references to SO numbers that are not in the system behave as before. |
| Delivery dates | Three separate fields on `sales_orders`: `preliminary_date` (copied from the quotation, never changed), `forecast_date` (rule-based, recalculated) and `committed_date` (only set when a different user with `sales.commit_approve` approves a request; may not be earlier than the forecast). |
| Forecast pegging | Per item, confirmed SO lines are served in confirmation order. Each line's unreserved quantity is covered by PO lines raised from its own requisitions first, then FIFO from unreserved stock, QC-hold stock and approved PO lines by expected date. The pegged supply is passed to `estimate_delivery` (same rules as pre-sales). Uncovered quantity raises a `purchase_requisitions` row (`PRODUCTION` kind for produced items with a production lead time). Recalculation runs on SO confirm/allocate/cancel, PO approval, goods receipt and PO line reschedule; `at_risk` = forecast later than committed (else required) date. |

## Data flow of the first vertical slice

```
Web: Add item ──► POST /api/items ──► item + QR token created ──► GET /api/qr/{id}.png|svg ──► label print
Android/Web scanner ──► GET /api/qr/resolve/{payload} ──► item + balances
          └──► POST /api/stock/movements (txn_uuid) ──► ledger row + balance projection (one transaction)
Dashboard ──► GET /api/dashboard/summary (live aggregates, polled)
```

## Order-to-delivery flow (Phase 5)

```
Enquiry (estimate) ──► POST /api/sales/quotations ──► .../quotations/{id}/status ACCEPTED
   ──► POST /api/sales/orders (DRAFT) ──► POST .../orders/{id}/confirm
          ├─ stock.reserve (locked, versioned)       → reservations, stock_balances.qty_reserved
          ├─ sales.recalculate_forecasts (pegging)   → line/order forecast_date, at_risk
          └─ uncovered qty                            → purchase_requisitions (Procurement page)
Requisition ──► POST /api/purchase/requisitions/{id}/convert (draft PO) ──► approve (other user) ──► recalculated
PO delay ──► PATCH /api/purchase/orders/{po}/lines/{line} ──► recalculated ──► notification + dashboard "orders at risk"
Commit ──► POST .../orders/{id}/commit-request ──► POST .../commit-decision (different user, sales.commit_approve)
Issue against SO ──► POST /api/stock/movements ISSUE SALES_ORDER ──► consumes reservation, updates qty_issued
```
