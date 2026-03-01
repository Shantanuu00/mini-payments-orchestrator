import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mini Payment Orchestrator",
  description: "Dashboard for payment creation and confirmation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
