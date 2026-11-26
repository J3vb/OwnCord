import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { fromClientRoot } from "../config/clientRoot";
import { rawSocket } from "../support/raw-socket";
import { installRealTransport } from "../support/real-transport";
import { seedScreenLayout } from "../support/screenLayoutSeed";
import { startTestServer, TEST_PASSWORD, type TestServer } from "../support/server";

const IMAGES = fromClientRoot("../.github/images");
const OWNER = "mira";
const SERVER_NAME = "Game Night Crew";
const MEMBERS = ["jonas", "noor", "sam", "lena", "kai"] as const;
const MODERATOR_ROLE_ID = 3;

type Socket = Awaited<ReturnType<typeof rawSocket>>;
type Channel = { id: number; name: string; type: string };

async function seed(server: TestServer): Promise<{ token: string; sockets: Socket[] }> {
  const owner = await server.api("/admin/api/setup", {
    username: OWNER,
    password: TEST_PASSWORD,
    setup_token: server.setupToken(),
    wizard: { server_name: SERVER_NAME, motd: "Welcome! Be nice and have fun." },
  });
  for (const username of MEMBERS) {
    await server.api("/api/v1/auth/register", {
      username,
      password: TEST_PASSWORD,
      invite_code: owner.invite_code,
    });
  }
  const create = (name: string, type: string, category: string, topic = "") =>
    server.api("/admin/api/channels", { name, type, category, topic }, owner.token);
  await create("announcements", "text", "Info", "News about this server");
  await create("game-night", "text", "Hangout", "Friday games, who's in?");
  await create("screenshots", "text", "Hangout", "Show what you made");
  await create("Lounge", "voice", "Voice");
  await create("Gaming", "voice", "Voice");

  const channels: Channel[] = await server.api("/api/v1/channels/", undefined, owner.token);
  const general = channels.find((channel) => channel.name === "general");
  const gameNight = channels.find((channel) => channel.name === "game-night");
  if (!general || !gameNight)
    throw new Error(`seed: missing channels in ${JSON.stringify(channels)}`);

  const sockets = new Map<string, Socket>();
  for (const username of [OWNER, ...MEMBERS]) {
    sockets.set(username, await rawSocket(server, username));
  }
  const as = (username: string): Socket => {
    const socket = sockets.get(username);
    if (!socket) throw new Error(`seed: no socket for ${username}`);
    return socket;
  };
  const say = async (username: string, channelId: number, text: string) =>
    (await as(username).post(channelId, [text]))[0];

  await say(
    "jonas",
    general.id,
    "Morning all! Server update went through overnight, no downtime 🎉",
  );
  await say("noor", general.id, "Nice. Voice feels a lot smoother since the last update");
  const plan = await say(
    "sam",
    general.id,
    "Anyone up for game night on Friday? Thinking around 20:00",
  );
  await say("lena", general.id, "I'm in! Bringing snacks 🍕");
  await say("kai", general.id, "Count me in, I'll set up the voice channel");
  await say("jonas", general.id, "Can we finally finish that co-op campaign from last month?");
  await say("noor", general.id, "Only if Kai promises not to fall off the map again 😄");
  await say("kai", general.id, "No promises");
  await say(
    OWNER,
    general.id,
    "Made a #game-night channel for it. Drop your game ideas there so we can vote",
  );
  for (const [username, emoji] of [
    ["jonas", "👍"],
    ["noor", "👍"],
    ["lena", "🎉"],
    [OWNER, "👍"],
  ] as const) {
    as(username).send("reaction_add", { message_id: plan, emoji });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await say("sam", gameNight.id, "Game ideas go here, one per message, react to vote");

  // A second person who can work reports keeps the admin Attention card clear.
  const users: { id: number; username: string }[] = await server.api(
    "/admin/api/users",
    undefined,
    owner.token,
  );
  const moderator = users.find((user) => user.username === "jonas");
  if (!moderator) throw new Error(`seed: missing jonas in ${JSON.stringify(users)}`);
  await server.api(
    `/admin/api/users/${moderator.id}/roles/${MODERATOR_ROLE_ID}`,
    undefined,
    owner.token,
    "PUT",
  );

  as("noor").send("presence_update", { status: "dnd", custom_status: "Working until 17:00" });
  as("lena").send("presence_update", { status: "idle" });
  await server.api("/admin/api/backup", {}, owner.token);
  // The demo server keeps its backups in its own data folder, which the Backup
  // disk check flags; the owner of a real server would confirm another disk.
  await server.api(
    "/admin/api/settings",
    { backup_disk_ack: join(server.directory, "data", "backups") },
    owner.token,
    "PATCH",
  );
  return { token: owner.token, sockets: [...sockets.values()] };
}

/** Answers the server's LiveKit health probe (an empty ListRooms reply), so the
 *  admin Dashboard does not show "Voice is unavailable" in the picture. */
async function fakeLiveKit(port: number): Promise<Server> {
  const fake = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/protobuf" });
    response.end();
  });
  await new Promise<void>((resolve) => fake.listen(port, "127.0.0.1", resolve));
  return fake;
}

/** A small LiveKit stats page, so the admin Dashboard's LiveKit card shows
 *  numbers instead of "Not reachable". */
async function fakeLiveKitMetrics(): Promise<Server> {
  const started = Date.now();
  const fake = createServer((_request, response) => {
    const seconds = (Date.now() - started) / 1000;
    response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    response.end(
      [
        `process_cpu_seconds_total ${(1.5 + seconds * 0.02).toFixed(3)}`,
        "process_resident_memory_bytes 48234496",
        "go_sched_gomaxprocs_threads 4",
        "livekit_room_total 1",
        "livekit_participant_total 3",
        "livekit_track_published_total 4",
        "livekit_track_subscribed_total 8",
        `livekit_packet_bytes{direction="incoming"} ${Math.round(2e6 + seconds * 40_000)}`,
        `livekit_packet_bytes{direction="outgoing"} ${Math.round(5e6 + seconds * 110_000)}`,
        "",
      ].join("\n"),
    );
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  return fake;
}

const VIEWPORT = { width: 1333, height: 934 } as const;

/** Stores the layout and theme a new desktop install gets, explicitly, so the
 *  pictures do not depend on the new-install settle. The theme is stored raw. */
async function seedLook(context: BrowserContext): Promise<void> {
  await seedScreenLayout(context, "deck");
  await context.addInitScript(() => {
    try {
      localStorage.setItem("owncord:theme:active", "gunmetal");
    } catch {
      // Storage is unavailable on this document: the picture keeps its default look.
    }
  });
}

const HIDE_TOASTS = '[data-testid="toast"] { display: none !important; }';

// The Command Deck Info block (call state and latency) needs a joined call and a
// real LiveKit, so it is not in the client picture.
async function signInClient(page: Page, server: TestServer): Promise<void> {
  await seedLook(page.context());
  await page.goto("/");
  // A saved profile with a name gives the server tab a real name instead of
  // 127.0.0.1.
  await page.getByText("+ Add Server").click();
  await page.getByPlaceholder("My Server").fill(SERVER_NAME);
  await page.getByPlaceholder("example.com:8443", { exact: true }).fill(`127.0.0.1:${server.port}`);
  await page.locator(".modal-footer .btn-primary").click();
  await page.getByText(SERVER_NAME, { exact: true }).click();
  await expect(page.locator("#host")).toHaveValue(`127.0.0.1:${server.port}`);
  await page.locator("#username").fill(OWNER);
  await page.locator("#password").fill(TEST_PASSWORD);
  await page.locator("#auto-connect").uncheck();
  await page.locator("button[type='submit']").click();
  await expect(page.getByTestId("app-layout")).toBeVisible();
  await page.locator(".server-tree [role=treeitem]").filter({ hasText: "general" }).first().click();
  await expect(page.getByText("Drop your game ideas there")).toBeVisible();
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

test("README screenshots", async ({ page, browser, baseURL }) => {
  const metrics = await fakeLiveKitMetrics();
  const address = metrics.address();
  const metricsPort = typeof address === "object" && address ? address.port : 0;
  const server = await startTestServer({
    seed: false,
    authRateLimitMultiplier: 10,
    env: {
      ...process.env,
      OWNCORD_VOICE_LIVEKIT_METRICS_URL: `http://127.0.0.1:${metricsPort}/metrics`,
    },
  });
  let sockets: Socket[] = [];
  const liveKit = await fakeLiveKit(server.livekitPort);
  try {
    const seeded = await seed(server);
    sockets = seeded.sockets;

    const transport = await installRealTransport(page, server);
    try {
      await signInClient(page, server);
      await settle(page);
      await page.screenshot({ path: `${IMAGES}/Client.png`, style: HIDE_TOASTS });
    } finally {
      await transport.close();
    }

    const loginContext = await browser.newContext({
      baseURL,
      colorScheme: "dark",
      viewport: VIEWPORT,
    });
    try {
      await seedLook(loginContext);
      const loginPage = await loginContext.newPage();
      await loginPage.goto("/");
      await loginPage.locator("#host").fill("chat.example.net");
      await loginPage.locator("#username").fill(OWNER);
      await settle(loginPage);
      await loginPage.screenshot({ path: `${IMAGES}/loginpage.png` });
    } finally {
      await loginContext.close();
    }

    const adminContext = await browser.newContext({
      colorScheme: "dark",
      viewport: VIEWPORT,
    });
    try {
      const adminPage = await adminContext.newPage();
      await adminPage.addInitScript(
        (token) => localStorage.setItem("admin_token", token),
        seeded.token,
      );
      await adminPage.goto(`${server.origin}/admin/`);
      await expect(adminPage.locator("#adminShell")).toBeVisible();
      // A fresh server shows "collecting the first interval" and the boot-time
      // LiveKit miss until its minute-long checks have run twice; wait for that.
      await expect(async () => {
        await adminPage.reload();
        await expect(adminPage.getByText("Everything is running normally")).toBeVisible({
          timeout: 1_000,
        });
      }).toPass({ timeout: 200_000, intervals: [10_000] });
      const updateStrip = adminPage.locator(".update-strip");
      if (await updateStrip.isVisible()) await updateStrip.locator("button").last().click();
      await settle(adminPage);
      await adminPage.screenshot({ path: `${IMAGES}/Admin_Panel.png` });
    } finally {
      await adminContext.close();
    }
  } finally {
    for (const socket of sockets) socket.close();
    await server.close();
    await new Promise((resolve) => liveKit.close(resolve));
    await new Promise((resolve) => metrics.close(resolve));
  }
});
