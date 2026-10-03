/** User-selected image input for a live terminal. Import never submits a prompt. */
export type TerminalImageTarget =
  | { kind: "terminal"; terminalId: string }
  | { kind: "agent"; threadId: string; instanceId: string };

/** Native-owned file and the exact provider/shell syntax to paste at the cursor. */
export interface ImportedTerminalImage {
  imageId: string;
  path: string;
  insertion: string;
  /** Native shell generation: the later paste must not reach a restarted shell. */
  terminalGeneration?: number;
}
