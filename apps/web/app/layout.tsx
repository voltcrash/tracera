import type { Metadata } from "next";
import localFont from "next/font/local";
import { AuthProvider } from "./components/auth-provider";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://tracera.voltcrash.com",
  ),
  title: "Tracera — Don’t just read the story. Trace it.",
  description:
    "Break news into checkable claims, trace each one to its sources, and see how the evidence changes over time.",
  openGraph: {
    title: "Tracera — Don’t just read the story. Trace it.",
    description:
      "Understand what a story gets right, what it leaves out, and where the evidence begins.",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Tracera evidence trail connecting a story to its claims and sources",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Tracera — Don’t just read the story. Trace it.",
    description:
      "Understand what a story gets right, what it leaves out, and where the evidence begins.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans`}>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
