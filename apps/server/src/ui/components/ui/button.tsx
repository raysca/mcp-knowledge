import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-navy text-[#062019] hover:bg-[#63f0d3]",
        outline: "border border-rule bg-shelf text-ink hover:border-[#38404c] hover:bg-[#191d24]",
        ghost: "text-slate hover:bg-shelf hover:text-ink",
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
