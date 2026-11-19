import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

// ── Button ───────────────────────────────────────────────────────────────
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "accent";
  size?: "sm" | "md" | "lg";
};

export function Button({ className, variant = "secondary", size = "md", ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors duration-(--dur-micro) focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" && "px-3 text-xs h-8",
        size === "md" && "px-4 text-sm h-9",
        size === "lg" && "px-6 text-base h-11",
        variant === "primary" &&
          "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-primary/50",
        variant === "secondary" &&
          "border border-border bg-secondary text-secondary-foreground hover:bg-muted hover:border-input",
        variant === "ghost" && "text-muted-foreground hover:bg-secondary hover:text-foreground",
        variant === "danger" &&
          "border border-destructive/40 text-destructive hover:bg-destructive/10 hover:border-destructive/60",
        variant === "accent" &&
          "border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 hover:border-accent/60",
        className,
      )}
    />
  );
}

// ── Spinner ──────────────────────────────────────────────────────────────
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}

// ── Input ────────────────────────────────────────────────────────────────
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/40 focus:outline-none transition-colors duration-(--dur-micro)",
        className,
      )}
    />
  );
}

// ── Textarea ─────────────────────────────────────────────────────────────
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        "w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/40 focus:outline-none transition-colors duration-(--dur-micro)",
        className,
      )}
    />
  );
}

// ── Panel ────────────────────────────────────────────────────────────────
export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
  icon,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <section className={cn("panel p-5", className)}>
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            {icon && (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 border border-primary/25 text-primary">
                {icon}
              </span>
            )}
            <div>
              {title && (
                <h2 className="flex items-center gap-2 text-base font-medium">
                  <span className="h-3.5 w-[2px] shrink-0 rounded-[1px] bg-primary" />
                  {title}
                </h2>
              )}
              {subtitle && <p className="mt-1.5 text-xs text-muted-foreground">{subtitle}</p>}
            </div>
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

// ── Badge ────────────────────────────────────────────────────────────────
export function Badge({
  tone = "muted",
  children,
  className,
}: {
  tone?: "muted" | "success" | "danger" | "warning" | "accent" | "primary";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium",
        tone === "muted" && "bg-secondary text-muted-foreground",
        tone === "success" && "bg-success/15 text-success",
        tone === "danger" && "bg-destructive/15 text-destructive",
        tone === "warning" && "bg-warning/15 text-warning",
        tone === "accent" && "bg-accent/15 text-accent",
        tone === "primary" && "bg-primary/15 text-primary",
        className,
      )}
    >
      {children}
    </span>
  );
}

// ── Progress Bar ─────────────────────────────────────────────────────────
export function ProgressBar({
  value,
  max,
  className,
  showLabel = true,
}: {
  value: number;
  max: number;
  className?: string;
  showLabel?: boolean;
}) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className={cn("w-full", className)}>
      <div className="h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div
          className="h-full w-full origin-left rounded-full bg-primary transition-transform duration-(--dur-short) ease-out"
          style={{ transform: `scaleX(${percent / 100})` }}
        />
      </div>
      {showLabel && (
        <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
          {value.toLocaleString()} of {max.toLocaleString()} ({percent}%)
        </p>
      )}
    </div>
  );
}

// ── Stat Card ────────────────────────────────────────────────────────────
export function StatCard({
  label,
  value,
  icon,
  iconClass,
  tone,
  trend,
}: {
  label: string;
  value: number | string;
  icon?: ReactNode;
  iconClass?: string;
  tone?: string;
  trend?: { value: number; label: string };
}) {
  return (
    <div className="group relative overflow-hidden rounded-xl border border-border bg-surface px-4 py-3.5 transition-colors hover:border-input">
      <div className="flex items-center justify-between">
        <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
        {icon && (
          <span className={cn("flex size-6 items-center justify-center", iconClass)}>{icon}</span>
        )}
      </div>
      <dd className={cn("mt-1.5 font-mono text-xl font-medium tabular-nums tracking-tight", tone)}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </dd>
      {trend && (
        <div className="mt-1.5">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {trend.value > 0 ? "+" : ""}
            {trend.value.toLocaleString()} {trend.label}
          </span>
        </div>
      )}
    </div>
  );
}
