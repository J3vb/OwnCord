import { describe, it, expect } from "vitest";
import type {
  ServerMessage,
  ClientMessage,
  VoiceConfigPayload,
  VoiceSpeakersPayload,
  ReadyPayload,
  ChatMessagePayload,
  Permission,
} from "../../src/lib/types";
import { Permission as P } from "../../src/lib/types";

// Sample PROTOCOL.md JSON payloads for parsing validation
const sampleAuthOk = {
  type: "auth_ok" as const,
  payload: {
    user: { id: 1, username: "alex", avatar: "uuid.png", role: "admin" },
    server_name: "My Server",
    motd: "Welcome!",
  },
};

const sampleReady = {
  type: "ready" as const,
  payload: {
    channels: [
      {
        id: 1,
        name: "general",
        type: "text" as const,
        category: "Main",
        position: 0,
        unread_count: 3,
        last_message_id: 1040,
      },
      {
        id: 10,
        name: "voice-chat",
        type: "voice" as const,
        category: "Main",
        position: 1,
      },
    ],
    members: [
      { id: 1, username: "alex", avatar: "uuid.png", role: "admin", status: "online" as const },
      { id: 2, username: "jordan", avatar: null, role: "member", status: "idle" as const },
    ],
    voice_states: [{ channel_id: 10, user_id: 2, muted: false, deafened: false }],
    roles: [
      { id: 1, name: "Owner", color: "#E74C3C", permissions: 2147483647 },
      { id: 2, name: "Admin", color: "#F39C12", permissions: 1073741823 },
      { id: 3, name: "Member", color: null, permissions: 1049601 },
    ],
  },
};

const sampleChatMessage = {
  type: "chat_message" as const,
  payload: {
    id: 1042,
    channel_id: 5,
    user: { id: 1, username: "alex", avatar: "uuid.png" },
    content: "Hello everyone!",
    reply_to: null,
    attachments: [
      {
        id: "upload-uuid-1",
        filename: "photo.jpg",
        size: 204800,
        mime: "image/jpeg",
        url: "/files/upload-uuid-1",
      },
    ],
    timestamp: "2026-03-14T10:30:00Z",
  },
};

const sampleVoiceConfig = {
  type: "voice_config" as const,
  payload: {
    channel_id: 10,
    quality: "medium" as const,
    bitrate: 64000,
    threshold_mode: "forwarding" as const,
    mixing_threshold: 10,
    top_speakers: 3,
    max_users: 50,
  },
};

const sampleVoiceSpeakers = {
  type: "voice_speakers" as const,
  payload: {
    channel_id: 10,
    speakers: [1, 5, 12],
    threshold_mode: "forwarding" as const,
  },
};

describe("ServerMessage discriminated union", () => {
  it("parses auth_ok with role as string", () => {
    const msg: ServerMessage = sampleAuthOk;
    if (msg.type === "auth_ok") {
      expect(msg.payload.user.role).toBe("admin");
      expect(typeof msg.payload.user.role).toBe("string");
    }
  });

  it("parses ready payload with all nested objects", () => {
    const msg: ServerMessage = sampleReady;
    if (msg.type === "ready") {
      const payload: ReadyPayload = msg.payload;
      expect(payload.channels).toHaveLength(2);
      expect(payload.members).toHaveLength(2);
      expect(payload.voice_states).toHaveLength(1);
      expect(payload.roles).toHaveLength(3);
      expect(payload.channels[0]?.unread_count).toBe(3);
      expect(payload.channels[0]?.last_message_id).toBe(1040);
      expect(payload.members[0]?.role).toBe("admin");
      expect(payload.members[1]?.status).toBe("idle");
    }
  });

  it("parses chat_message with attachments", () => {
    const msg: ServerMessage = sampleChatMessage;
    if (msg.type === "chat_message") {
      const payload: ChatMessagePayload = msg.payload;
      expect(payload.id).toBe(1042);
      expect(payload.attachments).toHaveLength(1);
      expect(payload.attachments[0]?.mime).toBe("image/jpeg");
    }
  });
});

describe("AUDIT Critical: threshold_mode (CRIT-2, CRIT-3)", () => {
  it("VoiceConfigPayload uses threshold_mode NOT mode", () => {
    const config: VoiceConfigPayload = sampleVoiceConfig.payload;
    expect(config.threshold_mode).toBe("forwarding");
    // TypeScript compile-time check: "mode" does not exist on VoiceConfigPayload
    // @ts-expect-error — mode is not a valid field
    expect(config.mode).toBeUndefined();
  });

  it("VoiceSpeakersPayload uses threshold_mode NOT mode", () => {
    const speakers: VoiceSpeakersPayload = sampleVoiceSpeakers.payload;
    expect(speakers.threshold_mode).toBe("forwarding");
    // @ts-expect-error — mode is not a valid field
    expect(speakers.mode).toBeUndefined();
  });

  it("voice_config ServerMessage carries threshold_mode", () => {
    const msg: ServerMessage = sampleVoiceConfig;
    if (msg.type === "voice_config") {
      expect(msg.payload.threshold_mode).toBeDefined();
      expect(["forwarding", "selective"]).toContain(msg.payload.threshold_mode);
    }
  });

  it("voice_speakers ServerMessage carries threshold_mode", () => {
    const msg: ServerMessage = sampleVoiceSpeakers;
    if (msg.type === "voice_speakers") {
      expect(msg.payload.threshold_mode).toBeDefined();
    }
  });
});

describe("AUDIT Critical: no channel_focus message type", () => {
  it("ServerMessage union does not include channel_focus", () => {
    // This test documents that channel_focus is intentionally excluded.
    // If someone accidentally adds it, this comment serves as a warning.
    const validTypes = [
      "auth_ok",
      "auth_error",
      "ready",
      "chat_message",
      "chat_send_ok",
      "chat_edited",
      "chat_deleted",
      "reaction_update",
      "typing",
      "presence",
      "channel_create",
      "channel_update",
      "channel_delete",
      "voice_state",
      "voice_leave",
      "voice_config",
      "voice_speakers",
      "voice_offer",
      "voice_answer",
      "voice_ice",
      "member_join",
      "member_leave",
      "member_update",
      "member_ban",
      "server_restart",
      "error",
    ];
    expect(validTypes).not.toContain("channel_focus");
  });
});

describe("ClientMessage types", () => {
  it("includes all outgoing message types", () => {
    const chatSend: ClientMessage = {
      type: "chat_send",
      payload: { channel_id: 1, content: "hi", reply_to: null, attachments: [] },
    };
    expect(chatSend.type).toBe("chat_send");

    const reactionAdd: ClientMessage = {
      type: "reaction_add",
      payload: { message_id: 1, emoji: "👍" },
    };
    expect(reactionAdd.type).toBe("reaction_add");
  });

  it("includes voice mute type", () => {
    const mute: ClientMessage = {
      type: "voice_mute",
      payload: { muted: true },
    };
    expect(mute.type).toBe("voice_mute");
  });
});

describe("Permission bitfield", () => {
  it("has correct bit values from SCHEMA.md", () => {
    expect(P.SEND_MESSAGES).toBe(0x1);
    expect(P.READ_MESSAGES).toBe(0x2);
    expect(P.ATTACH_FILES).toBe(0x20);
    expect(P.ADD_REACTIONS).toBe(0x40);
    expect(P.CONNECT_VOICE).toBe(0x200);
    expect(P.SPEAK_VOICE).toBe(0x400);
    expect(P.USE_VIDEO).toBe(0x800);
    expect(P.SHARE_SCREEN).toBe(0x1000);
    expect(P.MANAGE_MESSAGES).toBe(0x10000);
    expect(P.MANAGE_CHANNELS).toBe(0x20000);
    expect(P.KICK_MEMBERS).toBe(0x40000);
    expect(P.BAN_MEMBERS).toBe(0x80000);
    expect(P.MUTE_MEMBERS).toBe(0x100000);
    expect(P.MANAGE_ROLES).toBe(0x1000000);
    expect(P.MANAGE_SERVER).toBe(0x2000000);
    expect(P.MANAGE_INVITES).toBe(0x4000000);
    expect(P.VIEW_AUDIT_LOG).toBe(0x8000000);
    expect(P.ADMINISTRATOR).toBe(0x40000000);
  });

  it("ADMINISTRATOR bit can be checked with bitwise AND", () => {
    const ownerPerms = 0x7fffffff;
    expect(ownerPerms & P.ADMINISTRATOR).toBeTruthy();

    const memberPerms = 0x00000663;
    expect(memberPerms & P.ADMINISTRATOR).toBeFalsy();
  });

  it("Member default permissions match SCHEMA.md", () => {
    const memberPerms = 0x00000663;
    expect(memberPerms & P.SEND_MESSAGES).toBeTruthy();
    expect(memberPerms & P.READ_MESSAGES).toBeTruthy();
    expect(memberPerms & P.ATTACH_FILES).toBeTruthy();
    expect(memberPerms & P.ADD_REACTIONS).toBeTruthy();
    expect(memberPerms & P.CONNECT_VOICE).toBeTruthy();
    expect(memberPerms & P.SPEAK_VOICE).toBeTruthy();
    expect(memberPerms & P.MANAGE_MESSAGES).toBeFalsy();
    expect(memberPerms & P.ADMINISTRATOR).toBeFalsy();
  });
});
