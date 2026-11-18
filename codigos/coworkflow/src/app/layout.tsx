import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";

import { Encabezado } from "@/components/layout/Encabezado";
import { Pie } from "@/components/layout/Pie";

import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "OptiWork · Hub Providencia",
    template: "%s · OptiWork",
  },
  description:
    "Monitoreo de ocupación en tiempo real del cowork del Hub Providencia: check-in y check-out con QR, aforo y estadísticas de uso.",
  applicationName: "OptiWork",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es-CL"
      className={`${inter.variable} ${spaceGrotesk.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-fondo font-sans text-tinta">
        <Encabezado />
        {children}
        <Pie />
      </body>
    </html>
  );
}

