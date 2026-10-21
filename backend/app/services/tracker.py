"""Order tracker: one sales order shown as five simple stages — Sell → Plan → Get parts → Assemble → Deliver —
each with a short checklist, and the single next action (what to do, who does it, and where).

Read-only: it summarises sales orders, WIP/PAD documents, requisitions, purchase orders and work orders.
"""
from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Machine, Pad, PurchaseOrderLine, PurchaseRequisition, SalesOrder, WorkOrder
from .production import line_state
from .stock import item_totals

ZERO = Decimal(0)


def _action(label: str, href: str, who: str) -> dict:
    return {"label": label, "href": href, "who": who}


def _stage(key: str, title: str, status: str, summary: str, checks: list[tuple[str, bool]], action: dict | None = None) -> dict:
    return {"key": key, "title": title, "status": status, "summary": summary,
            "checks": [{"label": l, "done": d} for l, d in checks], "action": action}


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def order_tracker(db: Session, so: SalesOrder) -> dict:
    lines = list(so.lines)
    machine_lines = [l for l in lines if db.scalar(select(Machine.id).where(Machine.item_id == l.item_id))]
    is_machine = bool(machine_lines)
    pads = list(db.scalars(select(Pad).where(Pad.sales_order_id == so.id, Pad.status != "CANCELLED")))
    pad_by_line = {p.so_line_id: p for p in pads}
    order_href = f"/sales?tab=orders&order={so.id}"
    confirmed = so.status in ("CONFIRMED", "COMPLETED")
    stages: list[dict] = []

    # ---------------------------------------------------------------- 1. Sell
    committed = so.commit_status == "APPROVED"
    if so.status == "DRAFT":
        act = _action("Confirm the sales order", order_href, "Sales")
    elif so.status == "CANCELLED":
        act = None
    elif so.commit_status == "PENDING":
        act = _action("Approve the delivery date", order_href, "Management")
    elif not committed:
        act = _action("Request delivery-date approval", order_href, "Sales")
    else:
        act = None
    sell_done = confirmed and committed
    stages.append(_stage("sell", "Sell", "done" if sell_done else "current",
                         f"{so.customer.name}" + (f" · customer PO {so.customer_po_ref}" if so.customer_po_ref else ""),
                         [("Sales order created", True), ("Order confirmed", confirmed), ("Delivery date approved", committed)], act))

    # ---------------------------------------------------------------- 2. Plan (WIP/PAD per order line)
    released = [p for p in pads if p.status in ("RELEASED", "ISSUED")]
    if not confirmed:
        plan_status, plan_act = "todo", None
    elif len(pads) < len(lines):
        missing = next(l for l in lines if l.id not in pad_by_line)
        plan_status, plan_act = "current", _action("Create the WIP/PAD (parts list)", f"/production?new_pad={missing.id}", "Planning & Design")
    elif len(released) < len(pads):
        draft = next(p for p in pads if p.status == "DRAFT")
        plan_status, plan_act = "current", _action(f"Release {draft.number} to Stores", f"/production?pad={draft.id}", "Planning & Design")
    else:
        plan_status, plan_act = "done", None
    stages.append(_stage("plan", "Plan", plan_status,
                         ", ".join(p.number for p in pads) or "No parts list yet",
                         [("WIP/PAD created", bool(pads) and len(pads) >= len(lines)), ("Released to Stores", bool(pads) and len(released) == len(pads))],
                         plan_act))

    # ---------------------------------------------------------------- 3. Get parts (buy or make)
    pad_lines = [(p, l, line_state(db, l)) for p in released for l in p.lines]
    with_item = [x for x in pad_lines if x[1].item_id]
    not_in_store = [x for x in pad_lines if not x[1].item_id]
    ready = [x for x in with_item if x[2]["status"] in ("AVAILABLE", "ISSUED")]
    short = [x for x in with_item if x[2]["status"] == "SHORT"]
    no_req = [x for x in short if x[1].requisition is None or x[1].requisition.status == "CANCELLED"]
    buy = [x for x in with_item if x[1].requisition and x[1].requisition.kind == "PURCHASE"]
    make = [x for x in with_item if x[1].requisition and x[1].requisition.kind == "PRODUCTION"]
    short_buy = [x for x in short if x in buy]
    open_prs = [x for x in short_buy if x[1].requisition.status == "OPEN"]
    po_lines = [db.get(PurchaseOrderLine, x[1].requisition.po_line_id) for x in short_buy if x[1].requisition.po_line_id]
    po_draft = {pl.po.number for pl in po_lines if pl and pl.po.status == "DRAFT"}
    po_receive = {pl.po.number for pl in po_lines if pl and pl.po.status == "APPROVED" and Decimal(pl.qty_received) < Decimal(pl.qty_ordered)}
    in_qc = [x for x in short if item_totals(db, x[1].item_id)["qc_hold"] > 0]
    pad_wos = list(db.scalars(select(WorkOrder).where(WorkOrder.pad_id.in_([p.id for p in released] or [0]),
                                                      WorkOrder.status.in_(("OPEN", "IN_PROGRESS")))))
    first_pad = released[0] if released else None
    if plan_status != "done":
        parts_status, parts_act = "todo", None
    elif not with_item and not not_in_store:
        parts_status, parts_act = "done", None
    elif not_in_store:
        m = first_pad.machine if first_pad else None
        parts_status, parts_act = "current", _action(f"Link {_plural(len(not_in_store), 'part')} to stores items",
                                                     f"/machines/{m.id}" if m else "/inventory", "Stores")
    elif not short:
        parts_status, parts_act = "done", None
    elif no_req:
        parts_status, parts_act = "current", _action(f"Raise shortages for {_plural(len(no_req), 'part')}",
                                                     f"/production?pad={no_req[0][0].id}", "Stores")
    elif open_prs:
        parts_status, parts_act = "current", _action(f"Raise purchase orders for {_plural(len(open_prs), 'requisition')}", "/purchase", "Purchase")
    elif po_draft:
        parts_status, parts_act = "current", _action(f"Approve {_plural(len(po_draft), 'purchase order')}", "/purchase", "Management")
    elif in_qc:
        parts_status, parts_act = "current", _action(f"QC-release {_plural(len(in_qc), 'received part')}", "/qc", "QC")
    elif po_receive:
        parts_status, parts_act = "waiting", _action(f"Receive goods on {_plural(len(po_receive), 'purchase order')} when they arrive", "/purchase", "Stores")
    elif pad_wos:
        parts_status, parts_act = "current", _action(f"Run {_plural(len(pad_wos), 'work order')} for made parts",
                                                     f"/production?wo={pad_wos[0].id}", "Production")
    else:
        parts_status, parts_act = "waiting", None
    stages.append(_stage("parts", "Get parts", parts_status,
                         f"{len(ready)} of {len(pad_lines)} parts in stores" if pad_lines else "Waiting for the parts list",
                         [(f"Bought parts in stores: {sum(1 for x in buy if x in ready)} of {len(buy)}", bool(buy) and all(x in ready for x in buy)),
                          (f"Made parts in stores: {sum(1 for x in make if x in ready)} of {len(make)}", bool(make) and all(x in ready for x in make)),
                          ("Every part in stores", bool(pad_lines) and len(ready) == len(pad_lines))],
                         parts_act))

    # ---------------------------------------------------------------- 4. Assemble (machines only)
    def reserved_or_issued(l) -> bool:
        return Decimal(l.qty_shortage or 0) <= 0 and so.status in ("CONFIRMED", "COMPLETED")

    if not is_machine:
        stages.append(_stage("assemble", "Assemble", "skipped", "Spares order — no assembly", [], None))
    else:
        issued = [x for x in with_item if x[2]["status"] == "ISSUED"]
        to_issue = [x for x in with_item if x[2]["status"] == "AVAILABLE"]
        mprs = list(db.scalars(select(PurchaseRequisition).where(PurchaseRequisition.so_line_id.in_([l.id for l in machine_lines]),
                                                                 PurchaseRequisition.kind == "PRODUCTION",
                                                                 PurchaseRequisition.status != "CANCELLED")))
        mwos = list(db.scalars(select(WorkOrder).where(WorkOrder.requisition_id.in_([r.id for r in mprs] or [0]),
                                                       WorkOrder.status != "CANCELLED")))
        built = all(reserved_or_issued(l) for l in machine_lines) or so.status == "COMPLETED"
        active = next((w for w in mwos if w.status in ("OPEN", "IN_PROGRESS")), None)
        if built:
            asm_status, asm_act = "done", None
        elif parts_status not in ("done",) and not to_issue and not active:
            asm_status, asm_act = "todo", None
        elif to_issue:
            asm_status, asm_act = "current", _action(f"Issue {_plural(len(to_issue), 'part')} to assembly",
                                                     f"/production?pad={to_issue[0][0].id}", "Stores")
        elif active:
            asm_status, asm_act = "current", _action(f"Run assembly work order {active.number}", f"/production?wo={active.id}", "Production")
        elif any(r.status == "OPEN" for r in mprs):
            asm_status, asm_act = "current", _action("Create the assembly work order", "/production?tab=work-orders", "Production")
        else:
            asm_status, asm_act = "current", _action("Allocate the finished machine to this order", order_href, "Sales")
        stages.append(_stage("assemble", "Assemble", asm_status,
                             f"{len(issued)} of {len(with_item)} parts issued to assembly" if with_item else "Waiting for parts",
                             [(f"Parts issued to assembly: {len(issued)} of {len(with_item)}", bool(with_item) and len(issued) == len(with_item)),
                              ("Assembly work order completed", any(w.status == "COMPLETED" for w in mwos) or built),
                              ("Machine reserved for this order", built)], asm_act))

    # ---------------------------------------------------------------- 5. Deliver
    all_reserved = all(reserved_or_issued(l) for l in lines)
    delivered = so.status == "COMPLETED"
    if delivered:
        dl_status, dl_act = "done", None
    elif all_reserved and confirmed:
        dl_status, dl_act = "current", _action(f"Dispatch against {so.number} (Scan & Transact → Issue, ref Sales order)", "/scan", "Stores")
    elif confirmed and not is_machine and parts_status == "done":
        dl_status, dl_act = "current", _action("Allocate the stock to this order", order_href, "Sales")
    else:
        dl_status, dl_act = "todo", None
    stages.append(_stage("deliver", "Deliver", dl_status,
                         "Delivered" if delivered else f"Due {(so.committed_date or so.required_date or so.forecast_date) or '—'}",
                         [("Stock reserved for the order", all_reserved), ("Dispatched to customer", delivered)], dl_act))

    if so.status == "CANCELLED":
        for s in stages:
            s["status"], s["action"] = "skipped", None
    # A later stage that is done settles the earlier ones (e.g. a delivered machine no longer waits on spare parts).
    last_done = max((i for i, s in enumerate(stages) if s["status"] == "done"), default=-1)
    for s in stages[:max(last_done, 0)]:
        if (s["key"] in ("parts", "assemble") or so.status == "COMPLETED") and s["status"] in ("current", "waiting", "todo"):
            s["status"], s["action"] = "done", None
    counted = [s for s in stages if s["status"] != "skipped"]
    nxt = next((dict(s["action"], stage=s["title"]) for s in stages if s["status"] in ("current", "waiting") and s["action"]), None)
    return {
        "so": {"id": so.id, "number": so.number, "status": so.status, "customer": so.customer.name, "customer_po_ref": so.customer_po_ref,
               "items": [{"item_code": l.item.item_code, "name": l.item.name, "quantity": format(Decimal(l.quantity).normalize(), "f"),
                          "uom": l.item.uom.code} for l in lines],
               "required_date": so.required_date, "committed_date": so.committed_date, "forecast_date": so.forecast_date,
               "at_risk": so.at_risk, "created_at": so.created_at},
        "kind": "MACHINE" if is_machine else "SPARES",
        "stages": stages,
        "next": nxt,
        "progress": round(100 * sum(1 for s in counted if s["status"] == "done") / len(counted)) if counted else 0,
    }
