import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";
import { suppressReplayQueries } from "./replayQueries.ts";

const write = (term: Terminal, text: string) => new Promise<void>((resolve) => term.write(text, resolve));

it("suppresses historical device replies while preserving exact human input and later live queries", async () => {
  const term = new Terminal();
  const received: string[] = [];
  term.onData((data) => received.push(data));
  let replaying = true;
  const dispose = suppressReplayQueries(term, () => replaying);
  const queries = "\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[4$p\x1b[?25$p\x1bP$qm\x1b\\";
  await write(term, queries);
  expect(received).toEqual([]);
  for (const data of ["echo hello\r", "\x1b[A", "\x1b[200~pasted text\x1b[201~", "日本語"]) term.input(data);
  expect(received).toEqual(["echo hello\r", "\x1b[A", "\x1b[200~pasted text\x1b[201~", "日本語"]);
  received.length = 0;
  replaying = false;
  await write(term, queries);
  expect(received).toHaveLength(8);
  expect(received).toContain("\x1b[0n");
  expect(received).toContain("\x1b[1;1R");
  dispose();
  term.dispose();
});

it("preserves replayed text and formatting, including sequences split across writes", async () => {
  const term = new Terminal();
  const received: string[] = [];
  term.onData((data) => received.push(data));
  const dispose = suppressReplayQueries(term, () => true);
  await write(term, "\x1b[31mhello\x1b[0m\x1b[");
  await write(term, "6n");
  expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("hello");
  expect(received).toEqual([]);
  dispose();
  await write(term, "\x1b[6n");
  expect(received).toEqual(["\x1b[1;6R"]);
  term.dispose();
});
