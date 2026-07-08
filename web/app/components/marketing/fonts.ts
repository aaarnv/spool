import { Schibsted_Grotesk, Instrument_Serif } from "next/font/google";

// Landing-scoped fonts; applied to the .spool-landing wrapper only so the
// watch page keeps its own system-font stack.
export const sans = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--spool-sans",
  display: "swap",
});

export const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["italic"],
  variable: "--spool-serif",
  display: "swap",
});
