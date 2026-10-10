// Load run for the hunt-board service: N viewers on one board, M of them
// moving a pointer ten times a second and dragging a note now and then.
// Reports what each viewer received, the service's memory, and the gap
// between a live update being sent and its arrival on another socket.
//
//   bun run scripts/load.ts --url http://127.0.0.1:3100 --secret <secret> \
//     --hunt h1 --viewers 50 --movers 10 --seconds 60
//
// Needs a board for the hunt (POST /boards with the secret) and the service
// started with that secret. It imports the
// service's own token signer so the claims match what the service checks.
import { signToken } from "../server/token";
import { EJSON } from "../lib/compat/ejson";
import { Random } from "../lib/compat/random";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const url = arg("url", "http://127.0.0.1:3100");
const secret = arg("secret", "");
const hunt = arg("hunt", "h1");
const viewers = Number(arg("viewers", "50"));
const movers = Number(arg("movers", "10"));
const seconds = Number(arg("seconds", "60"));
if (!secret) throw new Error("--secret is required");

const auth = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
const created = await fetch(`${url}/boards`, { method: "POST", headers: auth, body: JSON.stringify({ scope: { hunt } }) });
if (!created.ok) throw new Error(`POST /boards ${created.status}`);
const { id: boardId } = (await created.json()) as { id: string; url: string };

const wsUrl = `${url.replace(/^http/, "ws")}/ws`;
// User ids are Meteor-style ids, as Jolly Roger's are
const userIds = Array.from({ length: viewers }, () => Random.id());
const token = (i: number) =>
  signToken({ v: 1, scope: { hunt }, user: userIds[i]!, name: `Load ${i}`, mayEdit: true, exp: Date.now() + 4 * 60_000 }, secret);

type Stats = { received: number; live: number; changes: number; latencies: number[]; kinds: Record<string, number>; firstError?: string };
const stats: Stats[] = [];
const sockets: WebSocket[] = [];
const open = (i: number) =>
  new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const s: Stats = { received: 0, live: 0, changes: 0, latencies: [], kinds: {} };
    stats[i] = s;
    ws.onopen = () => ws.send(EJSON.stringify({ t: "hello", token: token(i) }));
    ws.onmessage = (e) => {
      const m = EJSON.parse(String(e.data)) as { t: string; reason?: string; cursor?: { x: number; y: number } | null };
      s.received += 1;
      s.kinds[m.t] = (s.kinds[m.t] ?? 0) + 1;
      if (m.t === "error" && !s.firstError) s.firstError = m.reason;
      if (m.t === "welcome") resolve();
      if (m.t === "ping") ws.send(EJSON.stringify({ t: "pong" }));
      if (m.t === "live") {
        s.live += 1;
        // The sender put its clock (ms within the last 15 minutes) in y
        const sent = m.cursor?.y;
        if (typeof sent === "number") {
          const now = Date.now() % 900_000;
          s.latencies.push(now >= sent ? now - sent : now + 900_000 - sent);
        }
      }
      if (m.t === "change") s.changes += 1;
    };
    ws.onerror = () => reject(new Error(`socket ${i} failed`));
    ws.onclose = (e) => { if (e.code !== 1000) console.error(`socket ${i} closed ${e.code} ${e.reason}`); };
    sockets[i] = ws;
  });

const t0 = Date.now();
for (let i = 0; i < viewers; i++) await open(i);
console.log(`${viewers} viewers joined board ${boardId} in ${Date.now() - t0} ms`);

// Movers send a cursor every 100 ms; every fifth second one of them drags a
// note (a write, which fans out as a change to everyone).
let noteId: string | undefined;
const call = (ws: WebSocket, name: string, args: unknown) => ws.send(EJSON.stringify({ t: "call", id: `${name}-${Date.now()}`, name, args }));
const timers: ReturnType<typeof setInterval>[] = [];
for (let i = 0; i < movers; i++) {
  const ws = sockets[i]!;
  let x = 1000 + i * 50;
  timers.push(setInterval(() => {
    x += 3;
    ws.send(EJSON.stringify({ t: "live", cursor: { x, y: Date.now() % 900_000 }, drag: null, stroke: null }));
  }, 100));
}
const mover0 = sockets[0]!;
noteId = Random.id();
call(mover0, "upsertNodes", { nodes: [{ _id: noteId, type: "sticky", position: { x: 500, y: 500 }, width: 200, height: 160, text: "load" }] });
timers.push(setInterval(() => {
  call(mover0, "upsertNodes", { nodes: [{ _id: noteId, position: { x: 500 + Math.random() * 100, y: 500 } }] });
}, 5000));

const memory = async () => {
  const r = await fetch(`${url}/healthz`);
  return r.ok ? await r.text() : "?";
};
await Bun.sleep(seconds * 1000);
for (const t of timers) clearInterval(t);
await Bun.sleep(500);

const all = stats.reduce((a, s) => ({ received: a.received + s.received, live: a.live + s.live, changes: a.changes + s.changes, latencies: a.latencies.concat(s.latencies) }), { received: 0, live: 0, changes: 0, latencies: [] as number[] });
const kinds: Record<string, number> = {};
for (const s of stats) for (const [k, n] of Object.entries(s.kinds)) kinds[k] = (kinds[k] ?? 0) + n;
const firstError = stats.find((s) => s.firstError)?.firstError;
const sorted = all.latencies.sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
console.log(JSON.stringify({
  viewers, movers, seconds,
  messagesReceivedTotal: all.received,
  messagesPerSecondPerViewer: Math.round(all.received / viewers / seconds),
  liveTotal: all.live, changesTotal: all.changes,
  liveLatencyMs: { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: sorted.at(-1) ?? 0, samples: sorted.length },
  kinds, firstError,
  healthz: await memory(),
}, null, 1));
for (const ws of sockets) ws.close(1000);
