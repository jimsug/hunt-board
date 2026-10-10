// Does Bun's websocket server do rooms: two clients join a topic, one
// publishes, the other receives, and a third on another topic doesn't.
const server = Bun.serve<{ room: string }>({
  port: 0,
  fetch(req, server) {
    const room = new URL(req.url).searchParams.get("room") ?? "none";
    return server.upgrade(req, { data: { room } }) ? undefined : new Response("ws only", { status: 400 });
  },
  websocket: {
    open(ws) { ws.subscribe(ws.data.room); },
    message(ws, message) { ws.publish(ws.data.room, message); },
    close(ws) { ws.unsubscribe(ws.data.room); },
  },
});
const port = server.port;
const got: Record<string, string[]> = { a: [], b: [], c: [] };
const open = (name: string, room: string) => new Promise<WebSocket>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?room=${room}`);
  ws.onmessage = (e) => got[name]!.push(String(e.data));
  ws.onopen = () => resolve(ws);
});
const a = await open("a", "board1");
const b = await open("b", "board1");
const c = await open("c", "board2");
a.send(JSON.stringify({ cursor: { x: 1, y: 2 } }));
await Bun.sleep(100);
console.log(JSON.stringify({ port, got, subscribers: server.subscriberCount("board1") }));
a.close(); b.close(); c.close();
server.stop();
