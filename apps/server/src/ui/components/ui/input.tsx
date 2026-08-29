import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-sm border border-rule bg-paper px-3 text-sm text-ink placeholder:text-slate focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy",
        className,
      )}
      {...props}
    />
  );
}
