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
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
        size === "sm" && "px-3 py-1.5 text-xs h-8",
        size === "md" && "px-4 py-2 text-sm h-9",
        size === "lg" && "px-6 py-2.5 text-base h-11",
        variant === "primary" &&
          "bg-primary text-primary-foreground shadow-[0_10px_28px_-12px_oklch(0.86_0.19_124/0.75)] hover:bg-primary/90 hover:shadow-[0_14px_34px_-12px_oklch(0.86_0.19_124/0.9)] focus-visible:ring-primary/50",
        variant === "secondary" &&
          "border border-border bg-secondary text-secondary-foreground hover:bg-muted hover:border-border active:bg-muted",
        variant === "ghost" && "text-muted-foreground hover:bg-secondary hover:text-foreground",
        variant === "danger" &&
          "border border-destructive/40 text-destructive hover:bg-destructive/10 hover:border-destructive/60",
        variant === "accent" &&
          "bg-accent text-accent-foreground shadow-[0_10px_28px_-12px_oklch(0.78_0.13_210/0.75)] hover:bg-accent/90 hover:shadow-[0_14px_34px_-12px_oklch(0.78_0.13_210/0.9)]",
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
        "w-full rounded-lg border border-input bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/40 focus:outline-none transition-all",
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
        "w-full rounded-lg border border-input bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/40 focus:outline-none transition-all",
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
    <section className={cn("panel rise-in p-5", className)}>
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            {icon && (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 border border-primary/20 text-primary">
                {icon}
              </span>
            )}
            <div>
              {title && (
                <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
                  <span className="size-2 shrink-0 rounded-full bg-gradient-to-br from-primary to-accent shadow-[0_0_10px_oklch(0.86_0.19_124/0.7)]" />
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
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
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
      <div className="h-2.5 overflow-hidden rounded-full bg-secondary relative">
        <div
          className="h-full bg-gradient-to-r from-primary to-accent rounded-full transition-all duration-500 ease-out shadow-[0_0_12px_oklch(0.86_0.19_124/0.5)]"
          style={{ width: `${percent}%` }}
        />
        {/* shimmer effect */}
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-pulse" />
      </div>
      {showLabel && (
        <p className="mt-1.5 text-xs text-muted-foreground">
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
    <div className="group relative overflow-hidden rounded-xl border border-border bg-surface/60 px-4 py-3.5 transition-all hover:border-primary/40 hover:bg-surface hover:shadow-[0_16px_36px_-18px_oklch(0_0_0/0.8)]">
      <div className="flex items-center justify-between">
        <dt className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          {label}
        </dt>
        {icon && (
          <span className={cn("flex size-6 items-center justify-center", iconClass)}>{icon}</span>
        )}
      </div>
      <dd className={cn("mt-1.5 font-display text-2xl font-semibold tabular-nums", tone)}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </dd>
      {trend && (
        <div className="mt-1.5">
          <span className="text-[11px] text-muted-foreground">
            {trend.value > 0 ? "+" : ""}
            {trend.value.toLocaleString()} {trend.label}
          </span>
        </div>
      )}
    </div>
  );
}
