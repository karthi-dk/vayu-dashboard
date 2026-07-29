import { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "muted" | "success" | "danger" | "warning" | "primary" | "large" | "mid" | "small" | "intl" | "debt";

const variants: Record<Variant, string> = {
  default:
    "bg-muted/60 text-foreground",
  muted:
    "bg-muted/40 text-muted-foreground",
  success:
    "bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]",
  danger:
    "bg-[hsl(var(--danger)/0.15)] text-[hsl(var(--danger))]",
  warning:
    "bg-[hsl(var(--warning)/0.15)] text-[hsl(var(--warning))]",
  primary:
    "bg-[hsl(var(--primary)/0.15)] text-[hsl(var(--primary))]",
  large:
    "bg-[hsl(220_85%_60%/0.15)] text-[hsl(220_85%_75%)]",
  mid:
    "bg-[hsl(150_65%_45%/0.15)] text-[hsl(150_65%_65%)]",
  small:
    "bg-[hsl(350_75%_55%/0.15)] text-[hsl(350_75%_70%)]",
  intl:
    "bg-[hsl(280_65%_60%/0.15)] text-[hsl(280_65%_75%)]",
  debt:
    "bg-[hsl(220_10%_45%/0.20)] text-[hsl(220_10%_75%)]",
};

export function Badge({
  variant = "default",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        variants[variant],
        className
      )}
      {...props}
    />
  );
}
