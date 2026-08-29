import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stamp disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-ink text-paper hover:bg-navy",
        outline: "border border-rule bg-transparent text-ink hover:bg-shelf",
        ghost: "text-ink hover:bg-shelf",
        stamp: "bg-stamp text-paper hover:bg-stamp/90",
      },
      size: {
        default: "h-9",
        sm: "h-8 px-2 text-xs",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
