"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastTone = "success" | "error" | "info";

interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
}

interface Toast extends Required<Pick<ToastInput, "title" | "tone">> {
  id: string;
  description?: string;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
} as const;

const TONES: Record<ToastTone, string> = {
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-50",
  error: "border-destructive/40 bg-destructive/15 text-destructive-foreground",
  info: "border-primary/30 bg-primary/10 text-foreground",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback(
    ({ title, description, tone = "info" }: ToastInput) => {
      const id = crypto.randomUUID();
      setToasts((current) => [{ id, title, description, tone }, ...current].slice(0, 4));
      window.setTimeout(() => removeToast(id), 4200);
    },
    [removeToast],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed right-4 top-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-3">
        {toasts.map((item) => {
          const Icon = ICONS[item.tone];
          return (
            <div
              key={item.id}
              role="status"
              className={cn(
                "animate-toast-in rounded-lg border p-4 shadow-2xl backdrop-blur",
                TONES[item.tone],
              )}
            >
              <div className="flex gap-3">
                <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{item.title}</p>
                  {item.description && (
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {item.description}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removeToast(item.id)}
                  className="rounded p-1 opacity-70 transition hover:bg-background/20 hover:opacity-100"
                  aria-label="Dismiss notification"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside ToastProvider");
  }
  return context;
}
