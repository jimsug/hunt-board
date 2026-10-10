// What the process reads from the environment, checked once at start so a
// missing or malformed setting stops it with a message naming the variable
// rather than failing later on its first use.

export interface Config {
  mongoUrl: string;
  port: number;
  // Where the service is reachable, for the board urls POST /boards answers
  publicUrl: string;
  // The Jolly Roger origin: the only one allowed to frame the board page
  jrUrl: string;
  // Signs the tokens Jolly Roger mints, and is the bearer secret on the API
  jrSharedSecret: string;
  // The flags on for the whole process (see flags.ts)
  flags: string[];
  s3ImageBucketName: string | undefined;
  s3ImageBucketRegion: string | undefined;
  feed: FeedConfig;
  // TEST_MODE=1: the /test/* endpoints the acceptance harness drives
  // (resetting and reseeding the database, minting tokens, standing in for
  // Jolly Roger's puzzle writes). Never on in production.
  testMode: boolean;
}

// How the feed logs in to Jolly Roger: a resume token, an email and
// password, or both (the token first, the password once it's stale). Off is
// a deployment with no Jolly Roger behind it.
export interface FeedConfig {
  enabled: boolean;
  token?: string;
  email?: string;
  password?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const MIN_SECRET_LENGTH = 32;
const DEFAULT_PORT = 3100;

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} must be set`);
  return value;
}

// An http(s) origin with nothing after the host, as frame-ancestors wants it
function origin(env: Env, name: string): string {
  const value = required(env, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      `${name} must be a URL, got ${JSON.stringify(value)}`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must be an http or https URL`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigError(`${name} must be an origin with no path`);
  }
  return url.origin;
}

function feedConfig(env: Env): FeedConfig {
  const feed = env.FEED?.trim().toLowerCase();
  if (feed === "off") return { enabled: false };
  if (feed !== undefined && feed !== "" && feed !== "on") {
    throw new ConfigError(
      `FEED must be on or off, got ${JSON.stringify(feed)}`,
    );
  }
  const token = env.JR_SERVICE_TOKEN?.trim() || undefined;
  const email = env.JR_SERVICE_EMAIL?.trim() || undefined;
  const password = env.JR_SERVICE_PASSWORD || undefined;
  if ((email === undefined) !== (password === undefined)) {
    throw new ConfigError(
      "JR_SERVICE_EMAIL and JR_SERVICE_PASSWORD must be set together",
    );
  }
  if (!token && !email) {
    throw new ConfigError(
      "JR_SERVICE_TOKEN or JR_SERVICE_EMAIL and JR_SERVICE_PASSWORD must be set, or FEED=off",
    );
  }
  return { enabled: true, token, email, password };
}

export function loadConfig(env: Env = process.env): Config {
  const testMode = env.TEST_MODE?.trim() === "1";
  if (testMode && env.NODE_ENV?.trim() === "production") {
    throw new ConfigError("TEST_MODE can't be on with NODE_ENV=production");
  }
  const mongoUrl = required(env, "MONGO_URL");
  if (!/^mongodb(\+srv)?:\/\//.test(mongoUrl)) {
    throw new ConfigError("MONGO_URL must be a mongodb:// URL");
  }
  const portValue = env.PORT?.trim();
  const port = portValue ? Number(portValue) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be a port number, got ${portValue}`);
  }
  const jrSharedSecret = required(env, "JR_SHARED_SECRET");
  if (jrSharedSecret.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(
      `JR_SHARED_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return {
    mongoUrl,
    port,
    publicUrl: origin(env, "PUBLIC_URL"),
    jrUrl: origin(env, "JR_URL"),
    jrSharedSecret,
    flags: (env.FLAGS ?? "")
      .split(",")
      .map((flag) => flag.trim())
      .filter((flag) => flag !== ""),
    s3ImageBucketName: env.S3_IMAGE_BUCKET_NAME?.trim() || undefined,
    s3ImageBucketRegion: env.S3_IMAGE_BUCKET_REGION?.trim() || undefined,
    feed: feedConfig(env),
    testMode,
  };
}
