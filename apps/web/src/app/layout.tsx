import type { Metadata, Viewport } from "next";
import { Newsreader } from "next/font/google";
import localFont from "next/font/local";
import { AuthProvider } from "@/components/providers/auth-provider";
import { ThemeProvider, themeBootstrapScript } from "@/components/providers/theme-provider";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
});
const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://tracera.voltcrash.com"),
  title: "Tracera — Every story is a stack of claims",
  description:
    "Tracera takes a story apart one claim at a time, checks each against sources it can name, and marks the ones that don’t hold up.",
  openGraph: {
    title: "Tracera — Every story is a stack of claims",
    description:
      "Tracera marks the claims in a story, traces them back to their earliest source, and shows the evidence behind each one.",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "A news excerpt with its factual claims underlined and annotated in the margin",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Tracera — Every story is a stack of claims",
    description:
      "Tracera marks the claims in a story, traces them back to their earliest source, and shows the evidence behind each one.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f4" },
    { media: "(prefers-color-scheme: dark)", color: "#0d0d0d" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${newsreader.variable} font-sans`}
      >
        <ThemeProvider>
          <AuthProvider>{children}</AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
