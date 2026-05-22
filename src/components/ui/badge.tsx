import { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

type Tone = "neutral" | "positive" | "negative" | "warning" | "info";
const toneClasses: Record<Tone, string> = {
  neutral: "bg-ink-100 text-ink-700",
  positive: "bg-emerald-100 text-emerald-700",
  negative: "bg-red-100 text-red-700",
  warning: "bg-amber-100 text-amber-700",
  info: "bg-cyan-100 text-cyan-700",
};

export function Badge({
  className,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className
      )}
      {...props}
    />
  );
}
