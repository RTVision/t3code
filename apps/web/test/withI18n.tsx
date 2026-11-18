import { GTProvider, initializeGT } from "gt-react";
import type { ReactNode } from "react";

initializeGT({ defaultLocale: "en", locales: ["en"] });

const translations = {};

export function withI18n(children: ReactNode) {
  return (
    <GTProvider locale="en" translations={translations}>
      {children}
    </GTProvider>
  );
}
