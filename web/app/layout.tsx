import type { Metadata } from "next";
import { JetBrains_Mono, Newsreader, UnifrakturMaguntia } from "next/font/google";
import PageTurn from "@/components/PageTurn";
import ScrollReveal from "@/components/ScrollReveal";
import "./globals.css";

const newsreader = Newsreader({ subsets: ["latin"], style: ["normal", "italic"], axes: ["opsz"], variable: "--font-newsreader" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const unifraktur = UnifrakturMaguntia({ subsets: ["latin"], weight: "400", variable: "--font-unifraktur" });

export const metadata: Metadata = {
  title: "The Prospecto",
  description: "Founders at any stage publish a transparent estimate, open a fixed-price round and share one “Invest in us” link.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${newsreader.variable} ${jetbrains.variable} ${unifraktur.variable}`}>
      <body>
        <PageTurn />
        <ScrollReveal />
        {children}
      </body>
    </html>
  );
}
