import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Drives the acceptance run under Node: starts the service in test mode
// (bun, tests/acceptance/serve.ts), opens the runner page in headless
// Chromium, prints each test as the page reports it, and exits non-zero on
// a failure. `bun run test:acceptance` builds the bundle first.
//
//   node tests/acceptance/run.ts [--grep <pattern>] [--headed]
//
// GREP and HEADED in the environment do the same. The slowest tests take
// a minute each, so the whole run is given an hour.

interface TestOutcome {
  title: string;
  duration: number | undefined;
  error?: string;
}
interface Results {
  passes: TestOutcome[];
  failures: TestOutcome[];
  pending: string[];
  stats: { duration?: number };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const RUN_TIMEOUT_MS = 60 * 60 * 1000;
const READY_TIMEOUT_MS = 30 * 1000;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const grep = option("grep") ?? process.env.GREP;
const headed = process.argv.includes("--headed") || !!process.env.HEADED;

function bunBinary(): string {
  if (process.env.BUN) return process.env.BUN;
  const home = process.env.HOME ?? "";
  const local = path.join(home, ".bun/bin/bun");
  return existsSync(local) ? local : "bun";
}

// Starts the service and resolves with its url once it says it's ready
function startService(): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bunBinary(), ["run", "tests/acceptance/serve.ts"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("The service didn't start in time"));
    }, READY_TIMEOUT_MS);
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = /^READY (\S+)$/m.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve({ url: match[1]!, child });
      }
      // The rest of what the service says is passed through
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("READY ")) process.stdout.write(`${line}\n`);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The service exited with ${code}`));
    });
  });
}

async function main(): Promise<number> {
  if (!existsSync(path.join(root, "dist-acceptance/index.html"))) {
    throw new Error(
      "No dist-acceptance/: run `bun run build:acceptance` first",
    );
  }
  const { url, child } = await startService();
  const browser = await chromium.launch({ headless: !headed });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });
    page.on("console", (message) => {
      const text = message.text();
      // The tests' own reporting is [pass]/[fail]/[skip]; everything else is
      // the page's noise, kept for diagnosis
      const prefix = /^\[(pass|fail|skip|done)\]/.test(text)
        ? ""
        : `[${message.type()}] `;
      process.stdout.write(`${prefix}${text}\n`);
    });
    page.on("pageerror", (error) => {
      process.stdout.write(`[pageerror] ${error.message}\n`);
    });
    const runner = new URL(url);
    if (grep) runner.searchParams.set("grep", grep);
    await page.goto(runner.toString());
    const handle = await page.waitForFunction(
      () => (window as unknown as { __results?: Results }).__results,
      undefined,
      { timeout: RUN_TIMEOUT_MS, polling: 500 },
    );
    const results = (await handle.jsonValue()) as Results;
    const seconds = ((results.stats.duration ?? 0) / 1000).toFixed(1);
    process.stdout.write(
      `\n${results.passes.length} passing, ${results.failures.length} failing, ${results.pending.length} pending (${seconds}s)\n`,
    );
    for (const [index, failure] of results.failures.entries()) {
      process.stdout.write(
        `\n${index + 1}) ${failure.title}\n${failure.error}\n`,
      );
    }
    if (headed) {
      process.stdout.write("\nHeaded: close the browser to finish.\n");
      await new Promise<void>((resolve) => {
        browser.on("disconnected", () => resolve());
      });
    }
    return results.failures.length > 0 ? 1 : 0;
  } finally {
    await browser.close().catch(() => undefined);
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("exit", resolve));
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exit(2);
  },
);
