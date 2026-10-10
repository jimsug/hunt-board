// What the browser gets in place of lib/typedModel/userContext.ts (see
// vite.config.ts), which keeps the acting user in an AsyncLocalStorage the
// browser doesn't have. The models stamp nothing in the browser: nothing
// here writes.

export function withUser<T>(_userId: string, fn: () => T): T {
  return fn();
}

export function currentUserId(): string | undefined {
  return undefined;
}
