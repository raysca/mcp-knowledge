import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-rule bg-[#0e1116] px-3 text-sm text-ink placeholder:text-[#5d6674] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy",
        className,
      )}
      {...props}
    />
  );
}
