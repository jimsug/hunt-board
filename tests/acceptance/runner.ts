/// <reference types="mocha" />
import "mocha/mocha.js";
import "bootstrap/dist/css/bootstrap.min.css";
import "@xyflow/react/dist/style.css";
import "client/app.css";
import "client/i18n";
import { WhiteboardNodes } from "client/store";

// The runner page: mocha in the browser over the client's own modules,
// against the service the page was loaded from (in test mode). The
// outcome goes to window.__results for the driver, and each test to the
// console as it finishes.

interface TestOutcome {
  title: string;
  duration: number | undefined;
  error?: string;
}

export interface Results {
  passes: TestOutcome[];
  failures: TestOutcome[];
  pending: string[];
  stats: Mocha.Stats;
}

declare global {
  interface Window {
    __results?: Results;
    // The driver's, when there is one: a screenshot of the page as it is
    __screenshot?: () => Promise<void>;
  }
}

const params = new URLSearchParams(window.location.search);

mocha.setup({
  ui: "bdd",
  reporter: "html",
  timeout: 20000,
  slow: 5000,
  // One go: a failure is a failure
  retries: 0,
  ...(params.get("grep") ? { grep: params.get("grep")! } : {}),
});

// The runner page keeps its address for the report; the tests move the
// address bar about as the board's links would
const runnerUrl = window.location.href;

const errorText = (error: unknown) =>
  error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);

async function main() {
  // Registered before the tests (and Testing Library's own cleanup), so a
  // failed test is pictured with its board still up
  afterEach(async function () {
    if (this.currentTest?.state !== "failed") return;
    // Where the board was looking, and how much of it was drawn, for a
    // failure the screenshot alone doesn't explain
    const viewport = document.querySelector<HTMLElement>(
      ".react-flow__viewport",
    );
    const stored = WhiteboardNodes.find().fetch();
    const xs = stored.map((n) => n.position.x);
    const ys = stored.map((n) => n.position.y);
    const saved = Object.keys(localStorage)
      .filter((key) => key.startsWith("whiteboard:"))
      .map((key) => `${key}=${localStorage.getItem(key)}`)
      .join(" ");
    console.log(
      `[board] viewport ${viewport?.style.transform ?? "none"}, ${document.querySelectorAll(".react-flow__node").length} nodes drawn (${document.querySelectorAll(".react-flow__node.selected").length} selected), ${stored.length} in the store spanning ${Math.min(...xs)},${Math.min(...ys)} to ${Math.max(...xs)},${Math.max(...ys)}; localStorage ${saved}`,
    );
    await window.__screenshot?.();
  });
  await import("./whiteboard");
  const results: Results = {
    passes: [],
    failures: [],
    pending: [],
    stats: {} as Mocha.Stats,
  };
  const runner = mocha.run((failures) => {
    window.history.replaceState(window.history.state, "", runnerUrl);
    results.stats = runner.stats ?? results.stats;
    window.__results = results;
    console.log(`[done] ${failures} failing`);
  });
  runner.on("pass", (test) => {
    results.passes.push({ title: test.fullTitle(), duration: test.duration });
    console.log(`[pass] ${test.fullTitle()} (${test.duration}ms)`);
  });
  runner.on("fail", (test, error) => {
    results.failures.push({
      title: test.fullTitle(),
      duration: test.duration,
      error: errorText(error),
    });
    console.log(`[fail] ${test.fullTitle()}\n${errorText(error)}`);
  });
  runner.on("pending", (test) => {
    results.pending.push(test.fullTitle());
    console.log(`[skip] ${test.fullTitle()}`);
  });
}

void main();
