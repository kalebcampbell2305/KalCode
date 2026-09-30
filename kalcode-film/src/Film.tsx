import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import "./brand/fonts";
import { Backdrop, StageCtx } from "./components/core";
import { Chaos } from "./scenes/Chaos";
import { Introduce } from "./scenes/Introduce";
import { Workspace } from "./scenes/Workspace";
import { Providers } from "./scenes/Providers";
import { AgentSwarm } from "./scenes/AgentSwarm";
import { KalVoice } from "./scenes/KalVoice";
import { BuildLoop } from "./scenes/BuildLoop";
import { ReleasePipeline } from "./scenes/ReleasePipeline";
import { SelfHosting } from "./scenes/SelfHosting";
import { EndCard } from "./scenes/EndCard";

// Every scene is a pure function of the absolute film frame; scenes decide their own
// visibility window so overlaps and match cuts stay exact.
const SCENES: React.FC<{ frame: number }>[] = [
  Chaos,
  Introduce,
  Workspace,
  Providers,
  AgentSwarm,
  KalVoice,
  BuildLoop,
  ReleasePipeline,
  SelfHosting,
  EndCard,
];

export const Film: React.FC<{ offset?: number }> = ({ offset = 0 }) => {
  const frame = useCurrentFrame() + offset;
  const { width, height } = useVideoConfig();
  return (
    <StageCtx.Provider value={{ W: width, H: height, portrait: height > width }}>
      <AbsoluteFill style={{ background: "#05080f", overflow: "hidden" }}>
        <Backdrop />
        {SCENES.map((S, i) => (
          <S key={i} frame={frame} />
        ))}
      </AbsoluteFill>
    </StageCtx.Provider>
  );
};
