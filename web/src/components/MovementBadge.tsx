import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { isInbound, isOutbound, MOVEMENT_LABEL } from "@/lib/format";
import { Badge } from "./ui";

export function MovementBadge({ type }: { type: string }) {
  const tone = isInbound(type) ? "success" : isOutbound(type) ? "danger" : type.startsWith("QC") ? "warning" : "primary";
  const Icon = isInbound(type) ? ArrowDownLeft : isOutbound(type) ? ArrowUpRight : null;
  return (
    <Badge tone={tone}>
      {Icon && <Icon className="size-3" />}
      {MOVEMENT_LABEL[type] ?? type}
    </Badge>
  );
}
