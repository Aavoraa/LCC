"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import type { ItemRow } from "@/lib/types";
import { Field, Select } from "../ui";

interface MachineOption {
  id: number;
  code: string;
  name: string;
  models: string | null;
  family: string;
  item: { id: number; item_code: string } | null;
  spares: { id: number; part_no: string; name: string; item_id: number | null; item_code: string | null }[];
}

/** Split a model string ('40" / 51"', "LFCM 100, LFCM 40") into variants; descriptive specs stay whole. */
function variantsOf(models: string | null): string[] {
  if (!models) return [];
  if (/^up to/i.test(models.trim())) return [models.trim()];
  return models.split(/\s*\/\s*|\s*,\s*/).map((v) => v.trim()).filter(Boolean);
}

/** Option value encodes machine id and the chosen variant: "<id>|<variant>". */
const optionValue = (id: number, variant = "") => `${id}|${variant}`;

async function loadItemRow(code: string): Promise<ItemRow | null> {
  const r = await api<{ items: ItemRow[] }>(`/api/items?q=${encodeURIComponent(code)}&page_size=10`);
  return r.items.find((i) => i.item_code === code) ?? null;
}

/** Machine dropdown (default card service machines) with an optional spare of that machine.
 *  Resolves the choice to the stores item used for availability and estimation. */
export function MachineSelect({ value, onChange, onModelChange }: {
  value: ItemRow | null; onChange: (item: ItemRow | null) => void; onModelChange?: (model: string | null) => void;
}) {
  const { data: machines } = useApi<MachineOption[]>("/api/machines/options");
  const [choice, setChoice] = useState("");
  const [spareId, setSpareId] = useState("");
  const machineId = choice.split("|")[0];
  const machine = machines?.find((m) => String(m.id) === machineId);

  // Clear the dropdowns when the item is cleared or chosen elsewhere (e.g. the search box).
  useEffect(() => {
    if (!value) return;
    const fromMachine = machine && (machine.item?.item_code === value.item_code || machine.spares.some((s) => s.item_code === value.item_code));
    if (!fromMachine) { setChoice(""); setSpareId(""); onModelChange?.(null); }
  }, [value, machine]); // eslint-disable-line react-hooks/exhaustive-deps

  async function choose(next: string, sId: string) {
    setChoice(next);
    setSpareId(sId);
    const [mId, variant] = next.split("|");
    const m = machines?.find((x) => String(x.id) === mId);
    onModelChange?.(m && variant ? `${m.name} ${variant}` : null);
    const code = sId ? m?.spares.find((s) => String(s.id) === sId)?.item_code : m?.item?.item_code;
    onChange(code ? await loadItemRow(code) : null);
  }

  const sellable = machines?.filter((m) => m.item) ?? [];
  const accessories = machines?.filter((m) => !m.item) ?? [];
  return (
    <div className="grid gap-3">
      <Field label="Machine">
        <Select value={choice} onChange={(e) => choose(e.target.value, "")} aria-label="Machine">
          <option value="">{machines ? "Select a machine…" : "Loading machines…"}</option>
          {sellable.map((m) => {
            const variants = variantsOf(m.models);
            return (
              <optgroup key={m.id} label={m.name}>
                {variants.length > 0
                  ? variants.map((v) => <option key={v} value={optionValue(m.id, v)}>{m.name} – {v}</option>)
                  : <option value={optionValue(m.id)}>{m.name}</option>}
              </optgroup>
            );
          })}
          {accessories.length > 0 && (
            <optgroup label="Accessories (spares only)">
              {accessories.map((m) => <option key={m.id} value={optionValue(m.id)}>{m.name}</option>)}
            </optgroup>
          )}
        </Select>
      </Field>
      <Field label="Spare (optional)" hint={machine ? `${machine.spares.filter((s) => s.item_code).length} SOP spares` : undefined}>
        <Select value={spareId} disabled={!machine} onChange={(e) => choose(choice, e.target.value)} aria-label="Spare of selected machine">
          <option value="">{!machine ? "Choose a machine first" : machine.item ? "— The machine itself —" : "Select a spare…"}</option>
          {machine?.spares.filter((s) => s.item_code).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
    </div>
  );
}
