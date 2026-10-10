// What the server logs with, in the shape the ported code calls: a message
// and a bag of fields. Writes JSON lines to the console; the room and HTTP
// layers can swap it for something richer later. An object rather than bare
// functions so tests can spy on a level.
type Fields = Record<string, unknown>;

function write(level: string, message: string, fields: Fields = {}) {
  const { error, ...rest } = fields;
  const line = {
    time: new Date().toISOString(),
    level,
    message,
    ...rest,
    ...(error instanceof Error
      ? { error: error.message, stack: error.stack }
      : error !== undefined
        ? { error }
        : {}),
  };
  const out =
    level === "error" || level === "warn" ? console.error : console.log;
  out(JSON.stringify(line));
}

const Logger = {
  debug(message: string, fields?: Fields) {
    if (process.env.LOG_LEVEL === "debug") write("debug", message, fields);
  },
  info(message: string, fields?: Fields) {
    if (process.env.NODE_ENV !== "test") write("info", message, fields);
  },
  warn(message: string, fields?: Fields) {
    write("warn", message, fields);
  },
  error(message: string, fields?: Fields) {
    write("error", message, fields);
  },
};

export default Logger;
