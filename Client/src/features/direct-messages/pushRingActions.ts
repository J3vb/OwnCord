/**
 * Accept, Decline and a tap on a ring the Android app showed from a push,
 * while no page was running to hear the call (`PushRing` in PushAlerts.kt).
 * The page never saw that ring, so it has no ring state to answer: Accept
 * opens the conversation and joins its call once the app is signed in and
 * the caller is still in it; a tap opens the conversation; Decline tells the
 * caller. Only for the server and account the push came for.
 */
import { Disposable } from "../../lib/disposable";
import { setOwnedTimeout } from "../../lib/dom";
import { createLogger } from "../../lib/logger";
import { jumpToMessage } from "../../lib/nav/messageNavigation";
import { desktop } from "../../platform/desktop";
import { uiStore } from "../../stores/ui.store";
import { voiceStore } from "../../stores/voice.store";
import type { PageApi, PageState } from "../../pages/main-page/pageState";
import { pushSessionInstance } from "../push/pushSubscription";
import { pushStore } from "../push/store";

const log = createLogger("push-ring");

/** How long an Accept waits for the app to connect and see who is in the call:
 *  about as long as the caller's ring lasts. */
export const PUSH_ACCEPT_WAIT_MS = 30_000;

export interface PushRingAction {
  readonly kind: "accept" | "decline" | "open";
  readonly channelId: number;
  readonly instance: string;
}

type Sends = Pick<PageState, "ws">;
type Joins = Pick<PageApi, "joinDmCall">;

/** The Accept still waiting to join; a newer press replaces it. */
let waiting: Disposable | null = null;

const connected = (): boolean => uiStore.getState().connectionStatus === "connected";

const callerThere = (channelId: number): boolean =>
  (voiceStore.getState().voiceUsers.get(channelId)?.size ?? 0) > 0;

function withdraw(channelId: number): void {
  desktop.notifier
    .clearCall(channelId)
    .catch((err: unknown) => log.debug("Call notification not withdrawn", err));
}

/** Join `channelId`'s call as soon as the app is connected and someone is in
 *  it, or give up at `until`; the ring comes down either way. */
function joinWhenReady(channelId: number, pg: Joins, owner: AbortSignal, until: number): void {
  const wait = new Disposable();
  waiting = wait;
  const finish = (): void => {
    if (waiting === wait) waiting = null;
    wait.destroy();
    withdraw(channelId);
  };
  const tryJoin = (): void => {
    if (wait.signal.aborted || !connected() || !callerThere(channelId)) return;
    finish();
    pg.joinDmCall(channelId);
  };
  owner.addEventListener("abort", () => wait.destroy(), { once: true, signal: wait.signal });
  wait.addCleanup(uiStore.subscribe(tryJoin));
  wait.addCleanup(voiceStore.subscribe(tryJoin));
  setOwnedTimeout(wait.signal, finish, Math.max(0, until - Date.now()));
  tryJoin();
}

/** A press that started the app can come in before push knows the session:
 *  hold it until then, or give up with the ring at `until`. */
function holdForSession(
  action: PushRingAction,
  st: Sends,
  pg: Joins,
  owner: AbortSignal,
  until: number,
): void {
  const wait = new Disposable();
  waiting = wait;
  const done = (): void => {
    if (waiting === wait) waiting = null;
    wait.destroy();
  };
  owner.addEventListener("abort", done, { once: true, signal: wait.signal });
  wait.addCleanup(
    pushStore.subscribe(() => {
      if (pushSessionInstance() === null) return;
      done();
      act(action, st, pg, owner, until);
    }),
  );
  setOwnedTimeout(
    wait.signal,
    () => {
      done();
      withdraw(action.channelId);
    },
    Math.max(0, until - Date.now()),
  );
}

function act(
  action: PushRingAction,
  st: Sends,
  pg: Joins,
  owner: AbortSignal,
  until: number,
): void {
  const session = pushSessionInstance();
  // Another server's or account's ring only comes down: a press of this
  // account's that still waits is left alone.
  if (session !== null && action.instance !== session) {
    withdraw(action.channelId);
    return;
  }
  waiting?.destroy();
  waiting = null;
  if (session === null) {
    holdForSession(action, st, pg, owner, until);
    return;
  }
  if (action.kind === "decline") {
    // The ring is down already (the host takes it down on Decline).
    if (connected())
      st.ws.send({ type: "call_decline", payload: { channel_id: action.channelId } });
    return;
  }
  jumpToMessage(action.channelId);
  if (action.kind === "accept") joinWhenReady(action.channelId, pg, owner, until);
  else withdraw(action.channelId);
}

/** Act on a press on a ring from push, until `owner` (the page) goes. An
 *  Accept joins within PUSH_ACCEPT_WAIT_MS of the press or not at all. */
export function actOnPushRing(
  action: PushRingAction,
  st: Sends,
  pg: Joins,
  owner: AbortSignal,
): void {
  act(action, st, pg, owner, Date.now() + PUSH_ACCEPT_WAIT_MS);
}
