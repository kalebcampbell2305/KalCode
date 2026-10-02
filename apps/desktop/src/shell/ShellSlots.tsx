/**
 * Shell slots (Z7-W1): space the shell frame reserves for floating shell UI, so it never covers
 * page content. Today that is the KalVoice widget: docked to the top (or bottom) edge it sits in
 * a slim band the shell reserves above (or below) every surface, right of the sidebar, instead of
 * floating over page headers.
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

export type SlotEdge = "top" | "bottom";

export interface VoiceSlot {
  edge: SlotEdge;
  /** Height of the band, in pixels. */
  height: number;
}

interface ShellSlotsValue {
  voice: VoiceSlot | null;
  /** The widget reserves (or releases, with null) its band. */
  setVoice: (slot: VoiceSlot | null) => void;
  /** Left edge of the main column (right of the sidebar), in pixels. */
  mainLeft: number;
  setMainLeft: (left: number) => void;
  /** Space the shell chrome takes at the other window edges (top bar, agents rail, status strip). */
  insets: ShellInsets;
  setInsets: (insets: ShellInsets) => void;
}

export interface ShellInsets {
  top: number;
  right: number;
  bottom: number;
}

const NO_INSETS: ShellInsets = { top: 0, right: 0, bottom: 0 };

const ShellSlotsContext = createContext<ShellSlotsValue | null>(null);

/** Gap between the band's edges and the widget. */
export const VOICE_SLOT_GAP = 6;

export function ShellSlotsProvider({ children }: { children: ReactNode }) {
  const [voice, setVoiceState] = useState<VoiceSlot | null>(null);
  const [mainLeft, setMainLeftState] = useState(0);
  const [insets, setInsetsState] = useState<ShellInsets>(NO_INSETS);
  // Stable setters: consumers can depend on them in effects without re-running every change.
  const setVoice = useCallback(
    (slot: VoiceSlot | null) =>
      setVoiceState((prev) =>
        prev?.edge === slot?.edge && Math.abs((prev?.height ?? 0) - (slot?.height ?? 0)) < 1 ? prev : slot,
      ),
    [],
  );
  const setMainLeft = useCallback(
    (left: number) => setMainLeftState((prev) => (Math.abs(prev - left) < 1 ? prev : left)),
    [],
  );
  const setInsets = useCallback(
    (next: ShellInsets) =>
      setInsetsState((prev) =>
        Math.abs(prev.top - next.top) < 1 &&
        Math.abs(prev.right - next.right) < 1 &&
        Math.abs(prev.bottom - next.bottom) < 1
          ? prev
          : next,
      ),
    [],
  );
  const value = useMemo<ShellSlotsValue>(
    () => ({ voice, setVoice, mainLeft, setMainLeft, insets, setInsets }),
    [voice, setVoice, mainLeft, setMainLeft, insets, setInsets],
  );
  return <ShellSlotsContext.Provider value={value}>{children}</ShellSlotsContext.Provider>;
}

/** The shell's slots, or null outside the shell (tests rendering a widget alone). */
export function useShellSlots(): ShellSlotsValue | null {
  return useContext(ShellSlotsContext);
}
