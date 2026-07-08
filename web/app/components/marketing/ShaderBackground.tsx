"use client";

import { MeshGradient } from "@paper-design/shaders-react";

// Luminous Sonoma-wallpaper palette (sky blue -> teal -> mint -> peach -> coral)
// so the site and the product's rendered videos read as one brand.
const COLORS = [
  "#e7f0ff",
  "#bcd8ff",
  "#a3ddda",
  "#c6ecc4",
  "#ffdcc4",
  "#ffc3ad",
  "#dfe1ff",
];

export default function ShaderBackground() {
  return (
    <div className="spool-bg" aria-hidden="true">
      <MeshGradient
        className="spool-bg__mesh"
        colors={COLORS}
        distortion={0.85}
        swirl={0.12}
        grainOverlay={0.04}
        speed={0.18}
        style={{ width: "100%", height: "100%" }}
      />
      <div className="spool-bg__veil" />
      <div className="spool-bg__dots" />
    </div>
  );
}
