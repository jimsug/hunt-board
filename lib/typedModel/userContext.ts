import { AsyncLocalStorage } from "node:async_hooks";

// Who is acting, for the fields the models stamp with a user (createdBy and
// updatedBy). Meteor read it off the current method invocation; here the
// server wraps each request in withUser, and anything the wrapped code
// awaits sees the same user. Outside withUser there is no user, so a model
// whose schema requires one refuses the write.
const currentUser = new AsyncLocalStorage<string>();

export function withUser<T>(userId: string, fn: () => T): T {
  return currentUser.run(userId, fn);
}

export function currentUserId(): string | undefined {
  return currentUser.getStore();
}
