import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "agent-loom",
  description: "Shareable walkthrough videos recorded by agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
