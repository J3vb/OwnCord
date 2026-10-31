/** The mutable state one DM call panel keeps, shared by its modules. */
import type { Disposable } from "@lib/disposable";
import type { IconName } from "@lib/icons";
import type { RingState, OutgoingCallState } from "@lib/voice/callRing";
import type { VoiceState, PeerVerification } from "@stores/voice.store";
import type { DmChannel } from "@stores/dm.store";
import type { GridPerson } from "@components/VideoGrid";
import type { AvatarRef, ControlRefs, DmCallView } from "../DmCallViewModel";
import type { DmCallPanelOptions } from "../DmCallPanel";

export interface DmCallState {
  readonly options: DmCallPanelOptions;
  readonly disposable: Disposable;
  readonly unsubs: Array<() => void>;
  incoming: RingState | null;
  outgoing: OutgoingCallState | null;
  /** Remembered for the session, not per DM (the mock's state 6). */
  collapsed: boolean;
  view: DmCallView;
  structureKey: string;
  /** Any camera or screen share is on in the call (VideoModeController). */
  videoActive: boolean;
  /** The avatar tiles handed to the grid on the last rebuild. */
  people: GridPerson[];
  peopleGiven: boolean;
  /** Holds the shared video grid while the panel shows it; kept across
   *  rebuilds so the grid is re-seated, never recreated. */
  readonly videoEl: HTMLDivElement;
  /** What the owner last heard about hosting, to tell it only on a change. */
  hostSignature: string;
  destroyed: boolean;
  readonly root: HTMLElement;
  readonly body: HTMLDivElement;
  // Present from mount so it is heard when it fills (a region inserted
  // already filled is skipped). Outside `body`, which is rebuilt.
  readonly live: HTMLDivElement;
  // The drag handle on the panel's bottom edge (Discord's resizable call):
  // outside `body`, so a rebuild keeps it and a drag in progress.
  readonly resizer: HTMLDivElement;
  savedHeight: number;
  drag: { startY: number; startHeight: number; max: number } | null;
  // Per-render references for the in-place refresh.
  avatars: Map<number, AvatarRef>;
  controls: ControlRefs;
  statusEl: HTMLElement | null;
  securedEl: HTMLElement | null;
  timerEls: HTMLElement[];
  speakingEl: HTMLElement | null;
  timerInterval: ReturnType<typeof setInterval> | null;
  /** The call room someone else has been in since you joined, to tell "bob
   *  left" from "nobody has come yet". */
  peerRoom: number | null;
  /** When someone else was first in that room with you: the call's start, so
   *  both sides time the same call rather than their own time in the room.
   *  shortcut: a later joiner of a group call still counts from their
   *  own join; matching them needs per-member join times from the server. */
  answeredAt: number | null;
  readonly resizeOpts: { signal: AbortSignal };
  focusedShield: HTMLElement | null;
}

/** Every function the DM call panel's modules share, filled in once by createDmCallPanel. */
export interface DmCallApi {
  update(): void;
  avatar(userId: number, dm: DmChannel, size: "lg" | "sm", extra?: string): HTMLElement;
  person(userId: number, dm: DmChannel, extra?: string): HTMLElement;
  roundButton(
    label: string,
    icon: IconName,
    cls: string,
    testid: string,
    onClick: () => void,
  ): HTMLButtonElement;
  textButton(
    label: string,
    cls: string,
    testid: string,
    onClick: () => void,
    icon?: IconName,
  ): HTMLButtonElement;
  callControls(compact: boolean): HTMLElement;
  collapseButton(): HTMLButtonElement;
  topBar(
    status: string,
    tone: "" | "warn" | "bad",
    withCall: boolean,
    collapsible?: boolean,
  ): HTMLElement;
  videoStage(
    dm: DmChannel,
    ids: readonly number[],
    ringing?: readonly number[],
    absent?: readonly number[],
  ): HTMLElement;
  fill(...nodes: HTMLElement[]): void;
  renderIncoming(v: Extract<DmCallView, { kind: "incoming" }>): void;
  renderLive(v: Extract<DmCallView, { kind: "live" }>): void;
  renderOutgoing(v: Extract<DmCallView, { kind: "outgoing" }>): void;
  renderUnanswered(v: Extract<DmCallView, { kind: "unanswered" }>): void;
  renderConnected(v: Extract<DmCallView, { kind: "connected" }>): void;
  renderCollapsed(dm: DmChannel, ids: readonly number[], status: string): void;
  announce(): void;
  focusFallback(userId: number): HTMLElement | null;
  syncVerify(userId: number, ref: AvatarRef, voice: VoiceState, dm: DmChannel): void;
  syncOwnShield(userId: number, ref: AvatarRef, voice: VoiceState | null): void;
  placeShield(userId: number, ref: AvatarRef): void;
  buildShield(userId: number, v: PeerVerification, dm: DmChannel): HTMLElement;
}
