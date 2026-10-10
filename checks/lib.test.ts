// Can bun test run the port's pure lib with its chai assertions unchanged?
// Pulls one real module straight from the port's worktree.
import { assert } from "chai";
import { describe, it } from "bun:test";
import { snapAngle } from "/tmp/claude-1000/-home-james-git-jolly-roger-main/cbb65776-d23a-459d-b1ff-b0c9e8bd6567/scratchpad/fix-wt/imports/lib/whiteboard/connectors";
import { lineStyleFrom } from "/tmp/claude-1000/-home-james-git-jolly-roger-main/cbb65776-d23a-459d-b1ff-b0c9e8bd6567/scratchpad/fix-wt/imports/lib/whiteboard/lineStyle";

describe("the port's lib under bun test", () => {
  it("snaps an angle", () => {
    const p = snapAngle({ x: 0, y: 0 }, { x: 100, y: 3 });
    assert.closeTo(p.y, 0, 1e-9);
  });
  it("reads a saved line style", () => {
    assert.equal(lineStyleFrom({ colour: "red" }, { pathStyle: "curved", arrowHead: "end", color: "black", dashed: false }).color, "red");
  });
});
