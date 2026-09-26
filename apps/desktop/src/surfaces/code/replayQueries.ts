import type { Terminal } from "@xterm/xterm";

/** Suppress replies to historical queries, not input typed while history renders.
 * Uses the public parser API; returning false keeps normal live-query handling.
 * Query inventory matches the pinned xterm 6 InputHandler and color handlers.
 */
export function suppressReplayQueries(term: Terminal, replaying: () => boolean): () => void {
  const handlers = [
    term.parser.registerCsiHandler({ final: "c" }, replaying),
    term.parser.registerCsiHandler({ prefix: ">", final: "c" }, replaying),
    term.parser.registerCsiHandler({ final: "n" }, replaying),
    term.parser.registerCsiHandler({ prefix: "?", final: "n" }, replaying),
    term.parser.registerCsiHandler({ intermediates: "$", final: "p" }, replaying),
    term.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, replaying),
    term.parser.registerCsiHandler({ final: "t" }, (params) => replaying() && [14, 16, 18].includes(Number(params[0]))),
    term.parser.registerDcsHandler({ intermediates: "$", final: "q" }, replaying),
    ...[4, 10, 11, 12].map((identifier) =>
      term.parser.registerOscHandler(identifier, (data) => replaying() && data.split(";").includes("?")),
    ),
  ];
  return () => {
    for (const handler of handlers) handler.dispose();
  };
}
