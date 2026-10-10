import path from "node:path";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const lib = path.join(root, "lib");

// Two of the lib's modules are the server's alone: lib/db.ts, the one
// runtime importer of the Mongo driver, and lib/typedModel/userContext.ts,
// which keeps the acting user in Node's AsyncLocalStorage. The models import
// both (through lib/typedModel/Model.ts) so they can be built at import time,
// which the browser never needs: the client reads documents from its own
// store and writes nothing. Each gets a shim under client/shims/ instead.
const shims: Record<string, string> = {
  db: path.join(root, "client/shims/db.ts"),
  userContext: path.join(root, "client/shims/userContext.ts"),
};

const browserShims: Plugin = {
  name: "hunt-board:browser-shims",
  enforce: "pre",
  resolveId(source, importer) {
    const fromLib = importer?.startsWith(`${lib}${path.sep}`) ?? false;
    const name =
      /^(?:lib\/|(?:\.\.?\/)+)(?:typedModel\/)?(db|userContext)(?:\.ts)?$/.exec(
        source,
      )?.[1];
    if (!name || !(fromLib || source.startsWith("lib/"))) return null;
    return shims[name] ?? null;
  },
};

export default defineConfig({
  plugins: [browserShims, react()],
  resolve: {
    alias: [
      { find: /^lib\//, replacement: `${lib}/` },
      { find: /^client\//, replacement: `${path.join(root, "client")}/` },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:3100", ws: true },
      // The API is proxied to the service; the board page itself is Vite's
      "/boards": {
        target: "http://127.0.0.1:3100",
        bypass: (req) =>
          req.method === "GET" && req.headers.accept?.includes("text/html")
            ? "/index.html"
            : undefined,
      },
    },
  },
});
