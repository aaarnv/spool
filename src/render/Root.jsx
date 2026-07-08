import React from "react";
import { Composition } from "remotion";
import { SpoolComposition, calculateSpoolMetadata } from "./SpoolComposition.jsx";

const FPS = 30;

// The record + vo layers write the real props into the workdir; these defaults
// only exist so the composition is previewable in the Remotion studio.
const defaultProps = {
  timeline: { viewport: { width: 1600, height: 900 }, steps: [], total: 0 },
  manifest: { segments: [] },
  title: null,
  workdir: "",
};

export const Root = () => {
  return (
    <Composition
      id="Spool"
      component={SpoolComposition}
      durationInFrames={FPS} // real value comes from calculateMetadata
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={defaultProps}
      calculateMetadata={calculateSpoolMetadata}
    />
  );
};
