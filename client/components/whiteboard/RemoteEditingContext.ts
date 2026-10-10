import type { RemoteEditor } from "client/hooks/useWhiteboardOthersEditing";
import { createContext } from "react";

// The nodes and lines other people are typing in, each with who (see
// useWhiteboardOthersEditing). Text one of them is typing in can't be
// opened here until they stop.
const RemoteEditingContext = createContext<ReadonlyMap<string, RemoteEditor>>(
  new Map(),
);

export default RemoteEditingContext;
