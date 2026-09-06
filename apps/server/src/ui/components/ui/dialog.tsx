import type { ReactNode } from "react";

export function Dialog({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  // ponytail: native <dialog> instead of @radix-ui/react-dialog
  if (!open) return null;
  return (
    <dialog
      open
      className="fixed inset-0 m-auto h-fit w-[min(28rem,calc(100%-2rem))] rounded-xl border border-rule bg-shelf p-6 text-ink shadow-2xl backdrop:bg-black/70"
      onClose={onClose}
    >
      <h2 className="font-display text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-4">{children}</div>
    </dialog>
  );
}
