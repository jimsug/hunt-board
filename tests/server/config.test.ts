import { describe, it } from "bun:test";
import { assert } from "chai";
import { ConfigError, loadConfig } from "../../server/config";

describe("config", () => {
  const env = {
    MONGO_URL: "mongodb://127.0.0.1:27217/huntboard",
    PUBLIC_URL: "https://board.example.test",
    JR_URL: "https://jr.example.test",
    JR_SHARED_SECRET: "a-secret-that-is-at-least-32-chars-long",
    JR_SERVICE_TOKEN: "a-resume-token",
  };

  const fails = (
    overrides: Record<string, string | undefined>,
    match: RegExp,
  ) => {
    try {
      loadConfig({ ...env, ...overrides });
    } catch (error) {
      assert.instanceOf(error, ConfigError);
      assert.match((error as Error).message, match);
      return;
    }
    assert.fail("expected the config to be refused");
  };

  it("reads the required settings and defaults the rest", () => {
    const config = loadConfig(env);
    assert.equal(config.mongoUrl, env.MONGO_URL);
    assert.equal(config.port, 3100);
    assert.equal(config.publicUrl, env.PUBLIC_URL);
    assert.equal(config.jrUrl, env.JR_URL);
    assert.equal(config.jrSharedSecret, env.JR_SHARED_SECRET);
    assert.deepEqual(config.flags, []);
    assert.isUndefined(config.s3ImageBucketName);
  });

  it("reads the optional settings", () => {
    const config = loadConfig({
      ...env,
      PORT: "4000",
      FLAGS: "disable.whiteboard_live, disable.whiteboard_versions",
      S3_IMAGE_BUCKET_NAME: "bucket",
      S3_IMAGE_BUCKET_REGION: "ap-southeast-2",
    });
    assert.equal(config.port, 4000);
    assert.deepEqual(config.flags, [
      "disable.whiteboard_live",
      "disable.whiteboard_versions",
    ]);
    assert.equal(config.s3ImageBucketName, "bucket");
    assert.equal(config.s3ImageBucketRegion, "ap-southeast-2");
  });

  it("names a missing setting", () => {
    fails({ MONGO_URL: undefined }, /MONGO_URL must be set/);
    fails({ PUBLIC_URL: "" }, /PUBLIC_URL must be set/);
    fails({ JR_URL: " " }, /JR_URL must be set/);
    fails({ JR_SHARED_SECRET: undefined }, /JR_SHARED_SECRET must be set/);
  });

  it("refuses malformed settings", () => {
    fails({ MONGO_URL: "postgres://x" }, /MONGO_URL/);
    fails({ PORT: "abc" }, /PORT/);
    fails({ PORT: "70000" }, /PORT/);
    fails({ JR_URL: "jr.example.test" }, /JR_URL must be a URL/);
    fails({ JR_URL: "ftp://jr.example.test" }, /http or https/);
    fails({ JR_URL: "https://jr.example.test/path" }, /origin with no path/);
    fails({ JR_SHARED_SECRET: "short" }, /at least 32/);
  });

  it("reads the feed's credentials", () => {
    assert.deepEqual(loadConfig(env).feed, {
      enabled: true,
      token: "a-resume-token",
      email: undefined,
      password: undefined,
    });
    const withPassword = loadConfig({
      ...env,
      JR_SERVICE_TOKEN: undefined,
      JR_SERVICE_EMAIL: "board@example.test",
      JR_SERVICE_PASSWORD: "hunter2",
    });
    assert.deepEqual(withPassword.feed, {
      enabled: true,
      token: undefined,
      email: "board@example.test",
      password: "hunter2",
    });
    assert.deepEqual(loadConfig({ ...env, FEED: "off" }).feed, {
      enabled: false,
    });
    assert.isFalse(
      loadConfig({ ...env, JR_SERVICE_TOKEN: undefined, FEED: "off" }).feed
        .enabled,
    );
  });

  it("wants credentials unless the feed is off", () => {
    fails(
      { JR_SERVICE_TOKEN: undefined },
      /JR_SERVICE_TOKEN or JR_SERVICE_EMAIL/,
    );
    fails(
      { JR_SERVICE_TOKEN: undefined, JR_SERVICE_EMAIL: "board@example.test" },
      /must be set together/,
    );
    fails({ FEED: "maybe" }, /FEED must be on or off/);
  });

  it("keeps an origin as an origin", () => {
    assert.equal(
      loadConfig({ ...env, JR_URL: "https://JR.example.test/" }).jrUrl,
      "https://jr.example.test",
    );
  });
});
