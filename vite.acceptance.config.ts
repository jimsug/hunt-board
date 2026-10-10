import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config.ts";

// The acceptance bundle: the runner page under tests/acceptance/ with
// mocha, chai, Testing Library and the browser tests built on top of the
// client's own modules, into dist-acceptance/, which tests/acceptance/run.ts
// serves from the service in test mode.

const root = import.meta.dirname;

export default mergeConfig(
  base,
  defineConfig({
    root: path.join(root, "tests/acceptance"),
    // React's act, which Testing Library drives renders through, is in its
    // development build only (the script passes --mode development too, as
    // the build's NODE_ENV follows the command line)
    mode: "development",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    build: {
      outDir: path.join(root, "dist-acceptance"),
      emptyOutDir: true,
      sourcemap: true,
      // The tests read as written; nothing here ships
      minify: false,
      rollupOptions: {
        input: path.join(root, "tests/acceptance/index.html"),
      },
    },
    server: undefined,
  }),
);
