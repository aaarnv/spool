import { Instrument_Sans, Instrument_Serif } from "next/font/google";

// Landing-scoped fonts; applied to the .spool-landing wrapper only so the
// watch page keeps its own system-font stack. Instrument Sans + Serif are one
// superfamily — the pairing reads intentional, not template-default.
export const sans = Instrument_Sans({
  subsets: ["latin"],
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
