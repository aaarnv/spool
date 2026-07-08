"use client";

import { MeshGradient } from "@paper-design/shaders-react";

// Deep, luxurious dark mesh: near-black base with slow indigo/violet/petrol
// motion and a single warm ember accent. Matches the watch page + dashboard.
const COLORS = [
  "#05060d",
  "#0d1030",
  "#221a55",
  "#12173a",
  "#0c3a46",
  "#45205f",
  "#b8461d",
];

export default function ShaderBackground() {
  return (
    <div className="spool-bg" aria-hidden="true">
      <MeshGradient
        className="spool-bg__mesh"
        colors={COLORS}
        distortion={0.92}
        swirl={0.24}
        grainOverlay={0.09}
        speed={0.14}
        style={{ width: "100%", height: "100%" }}
      />
      <div className="spool-bg__veil" />
      <div className="spool-bg__grain" />
    </div>
  );
}
