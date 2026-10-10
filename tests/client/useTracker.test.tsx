import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Collection } from "../../client/store/collection";
import useTracker from "../../client/store/useTracker";

// useTracker in a real React tree: the component renders again when a
// collection it read changes, and when its deps change.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
  GlobalRegistrator.unregister();
});

interface Doc {
  _id: string;
  board: string;
  text?: string;
}

describe("useTracker", () => {
  it("re-renders when what it read changes, with the deps it's given", async () => {
    const docs = new Collection<Doc>("docs");
    docs.set({ _id: "a", board: "b1", text: "one" });
    docs.set({ _id: "b", board: "b2", text: "two" });
    let renders = 0;
    const Texts = ({ board }: { board: string }) => {
      renders += 1;
      const found = useTracker(
        () => docs.find({ board }, { sort: { _id: 1 } }).fetch(),
        [board],
      );
      return <div id="out">{found.map((d) => d.text).join(",")}</div>;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const shown = () => container.querySelector("#out")?.textContent;

    await act(async () => root.render(<Texts board="b1" />));
    expect(shown()).toBe("one");
    const after = renders;

    await act(async () => docs.set({ _id: "c", board: "b1", text: "three" }));
    expect(shown()).toBe("one,three");
    expect(renders).toBe(after + 1);

    // A change that leaves the result the same by value doesn't re-render
    await act(async () => docs.set({ _id: "zz", board: "b9" }));
    expect(renders).toBe(after + 1);

    await act(async () =>
      docs.set({ _id: "a", board: "b1", deleted: true } as Doc),
    );
    expect(shown()).toBe("three");

    await act(async () => root.render(<Texts board="b2" />));
    expect(shown()).toBe("two");

    await act(async () => root.unmount());
  });
});
