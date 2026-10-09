import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["es"], // ampliar cuando se requiera multilenguaje
  defaultLocale: "es",
  localePrefix: "never",
});

export type Locale = (typeof routing.locales)[number];
