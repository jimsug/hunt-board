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

export function loadConfig(env: Env = process.env): Config {
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
  };
}
