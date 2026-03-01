import { ReactNode } from "react";

export function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-panel p-5 shadow-lg shadow-black/20">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
        {subtitle ? <p className="text-sm text-zinc-400">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}
