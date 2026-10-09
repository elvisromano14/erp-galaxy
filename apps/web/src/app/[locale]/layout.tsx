import { AuthProvider } from "@/context/AuthContext";
import QueryProvider from "@/context/QueryProvider";
import { NoticeProvider } from "@/context/NoticeContext";
import { SidebarProvider } from "@/context/SidebarContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { isRtl } from "@/i18n/languages";
import { type Locale, routing } from "@/i18n/routing";
import { NextIntlClientProvider } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Outfit } from "next/font/google";
import { notFound } from "next/navigation";
import "../globals.css";

const outfit = Outfit({
  subsets: ["latin"],
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export const metadata = {
  title: "Mini ERP",
  description: "Administración, inventario, compras, ventas, bancos e impuestos",
};

export default async function RootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!routing.locales.includes(locale as Locale)) {
    notFound();
  }

  setRequestLocale(locale);

  return (
    <html lang={locale} dir={isRtl(locale as Locale) ? "rtl" : "ltr"}>
      <body className={`${outfit.className} dark:bg-gray-900`}>
        <NextIntlClientProvider>
          <ThemeProvider>
            <NoticeProvider>
              <QueryProvider>
                <AuthProvider>
                  <SidebarProvider>{children}</SidebarProvider>
                </AuthProvider>
              </QueryProvider>
            </NoticeProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
