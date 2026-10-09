import { EsFlagIcon } from "@/icons";

import type { Locale } from "./routing";

export interface Language {
  id: Locale;
  name: string;
  shortName: string;
  dir: "ltr" | "rtl";
  FlagIcon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  badge?: string;
}

export const languages: Language[] = [
  {
    id: "es",
    name: "Español",
    shortName: "Español",
    dir: "ltr",
    FlagIcon: EsFlagIcon,
  },
];

export function getLanguage(locale: Locale): Language {
  return languages.find((l) => l.id === locale) || languages[0];
}

export function isRtl(locale: Locale): boolean {
  return getLanguage(locale).dir === "rtl";
}
