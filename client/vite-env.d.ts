// The stylesheets the client imports for their side effects. Vite's own
// client types would declare these, but they clash with Bun's, which the
// rest of the repo type-checks against.
declare module "*.css";

// Sent by useBestEffortLocalStorage (client/hooks/persisted-state.ts) to the
// other hooks in the tab using the same key.
interface WindowEventMap {
  "jr:bestEffortStorage": CustomEvent<{ key: string; value: unknown }>;
}
