"use client";

import { useEffect, useState } from "react";
import { PadsPanel } from "@/components/production/PadsPanel";
import { WorkOrdersPanel } from "@/components/production/WorkOrdersPanel";
import { PageHeader, Tabs } from "@/components/ui";

export default function ProductionPage() {
  const [tab, setTab] = useState<"pads" | "work-orders">("pads");
  const [openWo, setOpenWo] = useState<number | null>(null);
  const [openPad, setOpenPad] = useState<number | null>(null);
  const [newPadLine, setNewPadLine] = useState<number | null>(null);
  // Deep links from the order tracker: ?pad=<id>, ?wo=<id>, ?tab=work-orders, ?new_pad=<sales order line id>
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("wo")) { setTab("work-orders"); setOpenWo(Number(q.get("wo"))); }
    else if (q.get("tab") === "work-orders") setTab("work-orders");
    if (q.get("pad")) setOpenPad(Number(q.get("pad")));
    if (q.get("new_pad")) setNewPadLine(Number(q.get("new_pad")));
  }, []);
  return (
    <>
      <PageHeader title="Production & Planning"
        description="Planning & Design raises a WIP/PAD against each sales order; Stores verifies and issues parts; work orders follow each spare's process route with QC after every step." />
      <Tabs className="mb-5" value={tab} onChange={setTab} tabs={[{ id: "pads", label: "WIP / PAD" }, { id: "work-orders", label: "Work orders" }]} />
      {tab === "pads" && <PadsPanel openPad={openPad} onOpenPad={setOpenPad} newPadLine={newPadLine} onNewPadDone={() => setNewPadLine(null)}
        onOpenWorkOrder={(id) => { setOpenWo(id); setTab("work-orders"); }} />}
      {tab === "work-orders" && <WorkOrdersPanel openId={openWo} onOpen={setOpenWo} />}
    </>
  );
}
