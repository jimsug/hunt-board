// A minimal DDP client over Bun's WebSocket: connect, ping/pong, and a
// subscription that reports ready. Against any Meteor server given by DDP_URL
// (default: the fork's dev server if it's up); the login step needs a token
// so this only proves the handshake and the message framing.
const url = process.env.DDP_URL ?? "ws://localhost:3000/websocket";
const ws = new WebSocket(url);
const log: string[] = [];
const send = (m: object) => ws.send(JSON.stringify(m));
const done = new Promise<void>((resolve) => {
  ws.onopen = () => send({ msg: "connect", version: "1", support: ["1"] });
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    log.push(m.msg ?? "?");
    if (m.msg === "connected") send({ msg: "sub", id: "s1", name: "Hunts.publications.all", params: [] });
    if (m.msg === "ping") send({ msg: "pong", id: m.id });
    if (m.msg === "ready" || m.msg === "nosub") resolve();
  };
  ws.onerror = () => resolve();
  setTimeout(resolve, 5000);
});
await done;
console.log(JSON.stringify({ url, log: log.slice(0, 12) }));
ws.close();
