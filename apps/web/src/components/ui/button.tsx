import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "default" | "outline" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline: "border border-border bg-transparent hover:bg-accent",
  ghost: "bg-transparent hover:bg-accent",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-6 text-base",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  loadingLabel?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      className,
      disabled,
      loading = false,
      loadingLabel,
      variant = "default",
      size = "md",
      ...props
    },
    ref,
  ) => (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-md font-medium transition-all hover:-translate-y-0.5 disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
        {loading && loadingLabel ? loadingLabel : children}
      </button>
    ),
);
Button.displayName = "Button";
