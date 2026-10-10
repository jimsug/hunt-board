import { afterAll, beforeAll, describe, it, spyOn } from "bun:test";
import { assert } from "chai";
import { PRUNE_FIRST_DELAY_MS, PRUNE_INTERVAL_MS } from "../../server/app";
import Logger from "../../server/logger";
import { setUpDatabase, tearDownDatabase, waitForAssertion } from "./harness";
import { startTestService } from "./service";

// The service as a process: what it schedules beyond serving.

describe("service", () => {
  beforeAll(setUpDatabase);
  afterAll(tearDownDatabase);

  it("prunes board history a while after start, then on an interval, until stopped", async () => {
    assert.equal(PRUNE_FIRST_DELAY_MS, 60 * 1000);
    assert.equal(PRUNE_INTERVAL_MS, 60 * 60 * 1000);
    const passes: Date[] = [];
    const service = startTestService({
      pruneFirstDelayMs: 30,
      pruneIntervalMs: 30,
      prune: async (now) => {
        passes.push(now);
      },
    });
    try {
      assert.lengthOf(passes, 0);
      await waitForAssertion(() => assert.isAtLeast(passes.length, 3));
      const [first, second] = passes as [Date, Date];
      assert.isAtLeast(second.getTime() - first.getTime(), 25);
    } finally {
      await service.stop();
    }
    const ran = passes.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.lengthOf(passes, ran);
  });

  it("logs a failed pass and runs the next", async () => {
    const errors = spyOn(Logger, "error").mockImplementation(() => {});
    let calls = 0;
    const service = startTestService({
      pruneFirstDelayMs: 10,
      pruneIntervalMs: 10,
      prune: async () => {
        calls += 1;
        if (calls === 1) throw new Error("Mongo went away");
      },
    });
    try {
      await waitForAssertion(() => assert.isAtLeast(calls, 2));
      assert.equal(errors.mock.calls.length, 1);
      assert.equal(errors.mock.calls[0]?.[0], "Failed to prune board history");
    } finally {
      await service.stop();
      errors.mockRestore();
    }
  });
});
