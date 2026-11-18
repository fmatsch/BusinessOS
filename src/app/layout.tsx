import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { LANG_COOKIE } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "BusinessOS",
  description: "Das Betriebssystem für Unternehmen",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const lang = (await cookies()).get(LANG_COOKIE)?.value === "en" ? "en" : "de";
  return (
    <html lang={lang}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
