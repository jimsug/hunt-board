/// <reference types="mocha" />
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { assert } from "chai";
import {
  boardContainer,
  login,
  logout,
  OPERATOR,
  resetService,
  setLocation,
  stabilize,
  TestApp,
} from "./harness";

describe("whiteboard page", function () {
  let boardId: string;
  before(async function () {
    this.timeout(30000);
    ({ boardId } = await resetService());
    await login(OPERATOR);
  });
  after(function () {
    logout();
  });
  afterEach(function () {
    cleanup();
  });

  it("shows the canvas, styled, once there's a board", async function () {
    this.timeout(30000);
    setLocation(`/boards/${boardId}`);
    render(<TestApp />, { container: boardContainer() });
    await stabilize();
    await waitFor(
      () => {
        assert.isNotNull(document.querySelector(".react-flow__node-puzzle"));
        assert.isNotNull(document.querySelector(".react-flow__node-frame"));
      },
      { timeout: 20000 },
    );
    const viewport = document.querySelector(".react-flow__viewport")!;
    assert.equal(getComputedStyle(viewport).pointerEvents, "none");
    await screen.findByRole("button", { name: /^Select and move/ });
  });
});
