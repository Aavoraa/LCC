import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AuthProvider } from "@/lib/auth";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Lakshmi Machine ERP", template: "%s · Lakshmi Machine ERP" },
  description: "QR-enabled inventory, sales availability and delivery estimation",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = { themeColor: "#0b1a3a", width: "device-width", initialScale: 1 };

// Apply the saved theme before paint to avoid a light flash in dark mode.
const themeScript = `try{if(JSON.parse(localStorage.getItem('lm_theme'))==='dark')document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
