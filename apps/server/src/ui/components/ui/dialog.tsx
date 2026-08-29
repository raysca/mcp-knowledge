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
      className="w-[min(28rem,calc(100%-2rem))] rounded-sm border border-rule bg-paper p-5 text-ink shadow-lg"
      onClose={onClose}
    >
      <h2 className="font-display text-xl">{title}</h2>
      <div className="mt-4">{children}</div>
    </dialog>
  );
}
