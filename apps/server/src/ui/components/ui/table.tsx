import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "../../lib/cn.ts";

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  const label = props["aria-label"] ?? "Scrollable data table";
  return (
    <div
      className="overflow-x-auto rounded-xl border border-rule bg-shelf focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      <table className={cn("w-full min-w-[42rem] caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-rule bg-[#0e1116]", className)} {...props} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-rule/70 transition-colors hover:bg-[#191d24]", className)} {...props} />;
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn("px-4 py-3 text-left font-mono text-[11px] font-medium text-slate", className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 align-middle", className)} {...props} />;
}
