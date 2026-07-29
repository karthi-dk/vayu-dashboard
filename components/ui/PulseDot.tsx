import { cn } from "@/lib/utils";

export function PulseDot({
  className,
  color = "success",
}: {
  className?: string;
  color?: "success" | "warning" | "danger" | "primary";
}) {
  const map = {
    success: "bg-[hsl(var(--success))]",
    warning: "bg-[hsl(var(--warning))]",
    danger: "bg-[hsl(var(--danger))]",
    primary: "bg-[hsl(var(--primary))]",
  };
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full animate-pulse-dot",
        map[color],
        className
      )}
    />
  );
}
