import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "白桦大冒险 · 余烬远征",
  description: "白桦大冒险：单人远征、战绩档案与好友三局两胜对决。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
