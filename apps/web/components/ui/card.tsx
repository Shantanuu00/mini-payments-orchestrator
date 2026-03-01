import { ReactNode } from "react";

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-panel p-5 shadow-lg">
      <h2 className="mb-4 text-lg font-semibold text-zinc-100">{title}</h2>
      {children}
    </section>
  );
}
