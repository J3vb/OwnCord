import { createServer, type Server } from "node:http";
import { test, expect, type Page } from "@playwright/test";
import { fromClientRoot } from "../config/clientRoot";
import { rawSocket } from "../support/raw-socket";
import { installRealTransport } from "../support/real-transport";
import { startTestServer, TEST_PASSWORD, type TestServer } from "../support/server";

const IMAGES = fromClientRoot("../.github/images");
const OWNER = "mira";
const SERVER_NAME = "Game Night Crew";
const MEMBERS = ["jonas", "noor", "sam", "lena", "kai"] as const;

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

  as("noor").send("presence_update", { status: "dnd", custom_status: "Working until 17:00" });
  as("lena").send("presence_update", { status: "idle" });
  await server.api("/admin/api/backup", {}, owner.token);
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

const HIDE_TOASTS = '[data-testid="toast"] { display: none !important; }';

async function signInClient(page: Page, server: TestServer): Promise<void> {
  await page.goto("/");
  // A saved profile with a name gives the server rail real initials instead
  // of the first two characters of 127.0.0.1.
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
  await page.locator(".channel-item:not(.voice)").filter({ hasText: "general" }).click();
  await expect(page.getByText("Drop your game ideas there")).toBeVisible();
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

test("README screenshots", async ({ page, browser, baseURL }) => {
  const server = await startTestServer({ seed: false, authRateLimitMultiplier: 10 });
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
      viewport: { width: 1440, height: 900 },
    });
    try {
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
      viewport: { width: 1440, height: 900 },
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
  }
});
