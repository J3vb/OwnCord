import { expect } from "@playwright/test";
import { TEST_PASSWORD, type TestServer } from "./server";

export type Frame = { type: string; payload?: { code?: string; message_id?: number } };

/** A raw socket signed in as `username`, for posting many messages fast. One
 *  request is in flight at a time: its reply is the frame carrying its id. A
 *  rate-limit refusal is waited out and the request resent. */
export async function rawSocket(server: TestServer, username: string) {
  const auth = await server.api("/api/v1/auth/login", { username, password: TEST_PASSWORD });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`);
  let pending: { id: string; resolve: (frame: Frame) => void } | null = null;
  let ready!: () => void;
  const readyFrame = new Promise<void>((resolve) => (ready = resolve));
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "ready") ready();
    if (pending && frame.id === pending.id) pending.resolve(frame);
  });
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "auth", payload: { token: auth.token } }));
  await readyFrame;
  return {
    async request(type: string, payload: unknown): Promise<Frame> {
      for (;;) {
        const id = crypto.randomUUID();
        const reply = new Promise<Frame>((resolve) => (pending = { id, resolve }));
        socket.send(JSON.stringify({ type, id, payload }));
        const frame = await reply;
        if (frame.payload?.code !== "RATE_LIMITED") return frame;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    },
    /** Post each text to `channelId`, in order; resolves to their ids. */
    async post(channelId: number, texts: readonly string[]): Promise<number[]> {
      const ids: number[] = [];
      for (const content of texts) {
        const frame = await this.request("chat_send", {
          channel_id: channelId,
          content,
          reply_to: null,
        });
        expect(frame.type).toBe("chat_send_ok");
        ids.push(frame.payload!.message_id!);
      }
      return ids;
    },
    /** Send a command whose success has no reply (chat_delete). */
    send: (type: string, payload: unknown) =>
      socket.send(JSON.stringify({ type, id: crypto.randomUUID(), payload })),
    close: () => socket.close(),
  };
}
