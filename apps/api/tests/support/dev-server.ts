/** Starts `wrangler dev` (real workerd, local D1) for integration tests and stops it afterwards. */
import { type ChildProcess, spawn } from "node:child_process";
import { API_DIR, WRANGLER_BIN } from "./wrangler";

export interface DevServer {
  origin: string;
  stop(): Promise<void>;
}

export interface DevServerOptions {
  /** Entry point relative to apps/api; defaults to the production entry in wrangler.jsonc. */
  script?: string;
  port: number;
  inspectorPort: number;
  persistTo: string;
  vars: Record<string, string>;
}

export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const args = [
    WRANGLER_BIN,
    "dev",
    ...(options.script ? [options.script] : []),
    "--port",
    String(options.port),
    "--ip",
    "127.0.0.1",
    "--inspector-port",
    String(options.inspectorPort),
    "--persist-to",
    options.persistTo,
    "--show-interactive-dev-session=false",
    "--log-level",
    "warn",
    ...Object.entries(options.vars).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
  ];
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: API_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const origin = `http://127.0.0.1:${options.port}`;
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
  };

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${output}`);
    try {
      const response = await fetch(`${origin}/v1/entitlement/keys`);
      if (response.status === 200) return { origin, stop };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await stop();
  throw new Error(`wrangler dev did not become ready:\n${output}`);
}
