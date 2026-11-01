import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * This package pushed to an anonymous local Convex backend (no Convex account), for tests that call its functions
 * inside Convex's runtime. Every test file shares the one deployment `.env.local` names.
 */

export const SERVER_DIR = resolve(import.meta.dir, "../..");
/**
 * The environment of every Convex CLI a test starts: this process's without any `CONVEX_*` variable, because a
 * deploy key or deployment named there outranks anonymous mode, and the pipeline's build job holds the production
 * deployment's `CONVEX_DEPLOY_KEY`.
 */
export const LOCAL_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CONVEX_"))),
  CONVEX_AGENT_MODE: "anonymous",
};
export const TIMEOUT = 3 * 60 * 1000;

export async function run(command: ReadonlyArray<string>) {
  // Async, never spawnSync: a fake server in the test process must keep answering meanwhile.
  const child = Bun.spawn([...command], { cwd: SERVER_DIR, env: LOCAL_ENV, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout, stderr };
}

export async function convex(args: ReadonlyArray<string>) {
  const result = await run(["bunx", "convex", ...args]);
  expect(result.exitCode, `convex ${args[0]}: ${result.stderr}`).toBe(0);
  return result.stdout;
}

/**
 * The URL of the deployment the Convex CLI acts on here, read from the `.env.local` it selects by when no `CONVEX_*`
 * variable is set. Throws unless that is an anonymous backend on this machine, so a test writes its keys and rows
 * nowhere else.
 */
export function localDeploymentUrl(): string {
  const envLocal = readFileSync(resolve(SERVER_DIR, ".env.local"), "utf8");
  const deployment = envLocal.match(/^CONVEX_DEPLOYMENT=(.*)$/m)?.[1]?.trim() ?? "(none)";
  const url = envLocal.match(/^CONVEX_URL=(.*)$/m)?.[1]?.trim() ?? "(none)";
  if (!deployment.startsWith("anonymous:") || !url.startsWith("http://127.0.0.1:")) {
    throw new Error(`refusing to run against ${deployment} at ${url}: this test only acts on an anonymous local deployment`);
  }
  return url;
}

/** Creates (or reuses) the anonymous deployment; call before setting its environment variables. */
export async function initLocalDeployment(): Promise<void> {
  await convex(["init"]);
  localDeploymentUrl();
}

export interface DevServer {
  readonly url: string;
  stop(): Promise<void>;
}

/** `convex dev` pushes the functions and keeps the local backend up for HTTP calls until `stop`. */
export async function startDevServer(): Promise<DevServer> {
  const devServer = Bun.spawn(["bunx", "convex", "dev", "--tail-logs", "disable", "--typecheck", "disable"], {
    cwd: SERVER_DIR, env: LOCAL_ENV, stdout: "ignore", stderr: "pipe",
  });
  const decoder = new TextDecoder();
  let printed = "";
  const ready = (async () => {
    const reader = (devServer.stderr as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      printed += decoder.decode(value);
      if (/Convex functions ready/.test(printed)) {
        // Keep draining so a full pipe never blocks convex dev.
        void (async () => { while (!(await reader.read()).done); })();
        return;
      }
    }
    throw new Error(`convex dev stopped before the functions were ready:\n${printed}`);
  })();
  await Promise.race([ready, Bun.sleep(TIMEOUT - 30_000).then(() => { throw new Error(`convex dev did not get ready:\n${printed}`); })]);
  return {
    url: localDeploymentUrl(),
    stop: async () => {
      devServer.kill("SIGINT");
      await Promise.race([devServer.exited, Bun.sleep(20_000)]);
      if (devServer.exitCode === null) devServer.kill("SIGKILL");
    },
  };
}
