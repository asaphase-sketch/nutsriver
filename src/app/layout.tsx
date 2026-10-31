import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "nutsriver — play-money poker",
  description:
    "Free play-money online poker. No-Limit Texas Hold'em with fair crypto-secure shuffling, live tables, house bots, chat and hand history. No real money, ever.",
  keywords: ["play-money poker", "texas holdem", "free poker", "online poker", "practice poker"],
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#120a08",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#120a08] text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
