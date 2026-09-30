import { CameraMotionBlur } from "@remotion/motion-blur";
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import "./brand/fonts";
import { C, FONT } from "./brand/tokens";
import { clapEnv, impactEnv, inBlur, kickEnv } from "./components/beat";
import { StageCtx } from "./components/core";
import { LightField } from "./components/fx";
import { AgentSwarm } from "./scenes/AgentSwarm";
import { Assemble } from "./scenes/Assemble";
import { BuildLoop } from "./scenes/BuildLoop";
import { Chaos } from "./scenes/Chaos";
import { EndCard } from "./scenes/EndCard";
import { KalVoice } from "./scenes/KalVoice";
import { Montage } from "./scenes/Montage";
import { Providers } from "./scenes/Providers";
import { ReleasePipeline } from "./scenes/ReleasePipeline";

// Every scene is a pure function of the absolute film frame; scenes decide their own
// visibility window so overlaps and match cuts stay exact.
const SCENES: React.FC<{ frame: number }>[] = [
  Chaos,
  Assemble,
  Providers,
  AgentSwarm,
  KalVoice,
  BuildLoop,
  ReleasePipeline,
  Montage,
  EndCard,
];

const FilmFrame: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  // the picture breathes with the music: kicks punch the camera, claps and impacts light it
  const k = kickEnv(frame);
  const im = impactEnv(frame);
  const cl = clapEnv(frame);
  return (
    <StageCtx.Provider value={{ W: width, H: height, portrait: height > width }}>
      <AbsoluteFill style={{ background: "#05080f", overflow: "hidden", fontFamily: FONT.ui, color: C.text }}>
        <LightField frame={frame} W={width} H={height} pulse={0.5 * k + im} />
        <AbsoluteFill
          style={{ transform: `scale(${1 + 0.011 * k + 0.035 * im}) rotate(${0.12 * im * Math.sin(frame)}deg)` }}
        >
          {SCENES.map((S, i) => (
            <S key={i} frame={frame} />
          ))}
        </AbsoluteFill>
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            mixBlendMode: "screen",
            background: `radial-gradient(70% 60% at 50% 45%, rgba(120,170,255,${0.05 * cl + 0.28 * im}), rgba(76,141,255,0) 70%)`,
          }}
        />
      </AbsoluteFill>
    </StageCtx.Provider>
  );
};

/** Fast moves (whips, fly-ins, zoom-throughs) get true sub-frame motion blur. */
export const Film: React.FC = () => {
  const frame = useCurrentFrame();
  return inBlur(frame) ? (
    <CameraMotionBlur samples={7} shutterAngle={200}>
      <FilmFrame />
    </CameraMotionBlur>
  ) : (
    <FilmFrame />
  );
};
