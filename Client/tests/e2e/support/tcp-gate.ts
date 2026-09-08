import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";

/** Interrupt real Rust HTTP/WebSocket connections without changing app state. */
export async function startTcpGate(targetPort: number) {
  let online = true;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const server = createServer((client) => {
    if (!online) {
      client.destroy();
      return;
    }
    track(client);
    const upstream = track(connect(targetPort, "127.0.0.1"));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No gate port");
  const offline = () => {
    online = false;
    for (const socket of sockets) socket.destroy();
  };
  return {
    origin: `https://127.0.0.1:${address.port}`,
    offline,
    online: () => {
      online = true;
    },
    close: async () => {
      offline();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
