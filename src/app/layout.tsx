import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agentic RAG Starter",
  description: "Chat over your own documents with citations, plus one bounded agent loop.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
