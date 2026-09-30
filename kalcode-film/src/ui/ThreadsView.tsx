// Threads surface: list on the left, the selected thread on the right (header with the
// account menu, transcript, composer). Used by Workspace, Providers and KalVoice scenes.
import { Plus } from "lucide-react";
import type React from "react";
import { C } from "../brand/tokens";
import { springIn } from "../motion";
import { Button, SURF, SurfaceTitle } from "./Cockpit";
import { Icon, Panel } from "./kit";
import { Composer, type Thread, ThreadHeader, ThreadRow, type TLine, Transcript } from "./surfaces";

export const ThreadsView: React.FC<{
  frame: number;
  threads: Thread[];
  selected: number;
  enterAt?: number;
  transcript: TLine[];
  composer?: { text?: string; live?: number; caret?: boolean };
  menuHot?: number;
  overlay?: React.ReactNode; // positioned in detail-pane coordinates
  detailLit?: number;
}> = ({ frame, threads, selected, enterAt = -999, transcript, composer = {}, menuHot, overlay, detailLit = 0 }) => {
  const listW = 640;
  const sel = threads[selected];
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <SurfaceTitle
        title="Threads"
        sub="One provider, one workspace, the permissions you choose."
        action={<Button label="New thread" primary icon={<Icon icon={Plus} size={17} />} />}
      />
      <div
        style={{
          position: "absolute",
          left: 28,
          top: 108,
          width: listW,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {threads.map((t, i) => {
          const s = springIn(frame, enterAt + i * 5, { damping: 16, stiffness: 200 });
          return (
            <div key={t.title + i} style={{ opacity: s, transform: `translateY(${(1 - s) * 30}px)` }}>
              <ThreadRow t={t} selected={i === selected} />
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 28 + listW + 20, top: 108, right: 28, bottom: 20 }}>
        <Panel lit={detailLit} style={{ width: "100%", height: "100%" }}>
          <ThreadHeader t={sel} menuHot={menuHot} />
          <Transcript lines={transcript} />
          <Composer provider={sel.provider} {...composer} frame={frame} />
          {overlay}
        </Panel>
      </div>
    </div>
  );
};

export const DETAIL = { x: 28 + 640 + 20, y: 108, w: SURF.w - (28 + 640 + 20) - 28 };
export { C };
