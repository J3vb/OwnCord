import { describe, it, expect, beforeEach } from 'vitest';
import {
  channelsStore,
  setChannels,
  setRoles,
  getRoleIdByName,
  addChannel,
  updateChannel,
  updateChannelPosition,
  removeChannel,
  setActiveChannel,
  getActiveChannel,
  getChannelsByCategory,
  incrementUnread,
  clearUnread,
} from '../../src/stores/channels.store';
import type {
  ReadyChannel,
  ChannelCreatePayload,
  ChannelUpdatePayload,
} from '../../src/lib/types';

function resetStore(): void {
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
  }));
}

const readyChannels: ReadyChannel[] = [
  { id: 1, name: 'general', type: 'text', category: 'Text', position: 0, unread_count: 3, last_message_id: 100 },
  { id: 2, name: 'voice-lobby', type: 'voice', category: 'Voice', position: 0 },
  { id: 3, name: 'announcements', type: 'announcement', category: 'Text', position: 1, unread_count: 0, last_message_id: 50 },
];

describe('channels store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('has empty initial state', () => {
    const state = channelsStore.getState();
    expect(state.channels.size).toBe(0);
    expect(state.activeChannelId).toBeNull();
  });

  describe('setChannels', () => {
    it('populates channels from ready payload', () => {
      setChannels(readyChannels);
      const state = channelsStore.getState();

      expect(state.channels.size).toBe(3);

      const general = state.channels.get(1);
      expect(general).toEqual({
        id: 1,
        name: 'general',
        type: 'text',
        category: 'Text',
        position: 0,
        unreadCount: 3,
        lastMessageId: 100,
      });

      const voice = state.channels.get(2);
      expect(voice).toEqual({
        id: 2,
        name: 'voice-lobby',
        type: 'voice',
        category: 'Voice',
        position: 0,
        unreadCount: 0,
        lastMessageId: null,
      });
    });

    it('defaults unread_count to 0 and last_message_id to null', () => {
      setChannels([{ id: 10, name: 'test', type: 'text', category: null, position: 0 }]);
      const ch = channelsStore.getState().channels.get(10);
      expect(ch?.unreadCount).toBe(0);
      expect(ch?.lastMessageId).toBeNull();
    });
  });

  describe('addChannel', () => {
    it('adds a new channel', () => {
      setChannels(readyChannels);

      const payload: ChannelCreatePayload = {
        id: 4,
        name: 'new-channel',
        type: 'text',
        category: 'Text',
        position: 2,
      };
      addChannel(payload);

      const state = channelsStore.getState();
      expect(state.channels.size).toBe(4);

      const added = state.channels.get(4);
      expect(added).toEqual({
        id: 4,
        name: 'new-channel',
        type: 'text',
        category: 'Text',
        position: 2,
        unreadCount: 0,
        lastMessageId: null,
      });
    });

    it('does not mutate the previous channels map', () => {
      setChannels(readyChannels);
      const before = channelsStore.getState().channels;

      addChannel({ id: 5, name: 'extra', type: 'text', category: null, position: 0 });
      const after = channelsStore.getState().channels;

      expect(before).not.toBe(after);
      expect(before.size).toBe(3);
      expect(after.size).toBe(4);
    });
  });

  describe('updateChannel', () => {
    it('updates name immutably', () => {
      setChannels(readyChannels);
      const before = channelsStore.getState().channels.get(1);

      const update: ChannelUpdatePayload = { id: 1, name: 'renamed' };
      updateChannel(update);

      const after = channelsStore.getState().channels.get(1);
      expect(after?.name).toBe('renamed');
      expect(after?.position).toBe(0); // unchanged
      expect(before).not.toBe(after);
    });

    it('updates position immutably', () => {
      setChannels(readyChannels);

      updateChannel({ id: 1, position: 5 });

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.position).toBe(5);
      expect(ch?.name).toBe('general'); // unchanged
    });

    it('updates both name and position', () => {
      setChannels(readyChannels);

      updateChannel({ id: 1, name: 'new-name', position: 10 });

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.name).toBe('new-name');
      expect(ch?.position).toBe(10);
    });

    it('is a no-op for unknown channel id', () => {
      setChannels(readyChannels);
      const before = channelsStore.getState();

      updateChannel({ id: 999, name: 'ghost' });

      const after = channelsStore.getState();
      expect(after).toBe(before);
    });
  });

  describe('removeChannel', () => {
    it('removes a channel', () => {
      setChannels(readyChannels);

      removeChannel(1);

      const state = channelsStore.getState();
      expect(state.channels.size).toBe(2);
      expect(state.channels.has(1)).toBe(false);
    });

    it('clears activeChannelId if removed channel was active', () => {
      setChannels(readyChannels);
      setActiveChannel(1);
      expect(channelsStore.getState().activeChannelId).toBe(1);

      removeChannel(1);

      expect(channelsStore.getState().activeChannelId).toBeNull();
    });

    it('preserves activeChannelId if removed channel was not active', () => {
      setChannels(readyChannels);
      setActiveChannel(2);

      removeChannel(1);

      expect(channelsStore.getState().activeChannelId).toBe(2);
    });
  });

  describe('setActiveChannel', () => {
    it('sets active channel id', () => {
      setChannels(readyChannels);

      setActiveChannel(2);

      expect(channelsStore.getState().activeChannelId).toBe(2);
    });

    it('sets active channel to null', () => {
      setChannels(readyChannels);
      setActiveChannel(1);

      setActiveChannel(null);

      expect(channelsStore.getState().activeChannelId).toBeNull();
    });

    it('clears unread count for the activated channel', () => {
      setChannels(readyChannels);
      // channel 1 starts with unreadCount: 3
      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(3);

      setActiveChannel(1);

      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
    });

    it('does not mutate channels map when clearing unread', () => {
      setChannels(readyChannels);
      const before = channelsStore.getState().channels;

      setActiveChannel(1);

      const after = channelsStore.getState().channels;
      expect(before).not.toBe(after);
      // other channels unchanged
      expect(after.get(2)).toBe(before.get(2));
    });

    it('skips channels map update when unread is already 0', () => {
      setChannels(readyChannels);
      // channel 2 has unreadCount: 0
      const before = channelsStore.getState().channels;

      setActiveChannel(2);

      const after = channelsStore.getState().channels;
      expect(before).toBe(after);
    });
  });

  describe('getActiveChannel', () => {
    it('returns null when no active channel', () => {
      expect(getActiveChannel()).toBeNull();
    });

    it('returns the active Channel object', () => {
      setChannels(readyChannels);
      setActiveChannel(1);

      const active = getActiveChannel();
      expect(active).toEqual({
        id: 1,
        name: 'general',
        type: 'text',
        category: 'Text',
        position: 0,
        unreadCount: 0,
        lastMessageId: 100,
      });
    });

    it('returns null if activeChannelId refers to a non-existent channel', () => {
      setActiveChannel(999);

      expect(getActiveChannel()).toBeNull();
    });
  });

  describe('getChannelsByCategory', () => {
    it('groups channels by category and sorts by position', () => {
      setChannels(readyChannels);

      const grouped = getChannelsByCategory();

      expect(grouped.size).toBe(2);

      const textChannels = grouped.get('Text');
      expect(textChannels).toHaveLength(2);
      expect(textChannels?.[0]?.name).toBe('general');   // position 0
      expect(textChannels?.[1]?.name).toBe('announcements'); // position 1

      const voiceChannels = grouped.get('Voice');
      expect(voiceChannels).toHaveLength(1);
      expect(voiceChannels?.[0]?.name).toBe('voice-lobby');
    });

    it('handles null category', () => {
      setChannels([
        { id: 1, name: 'uncategorized', type: 'text', category: null, position: 0 },
      ]);

      const grouped = getChannelsByCategory();
      expect(grouped.has(null)).toBe(true);
      expect(grouped.get(null)).toHaveLength(1);
    });

    it('returns empty map when no channels', () => {
      const grouped = getChannelsByCategory();
      expect(grouped.size).toBe(0);
    });
  });

  describe('incrementUnread', () => {
    it('increments unread count for a channel', () => {
      setChannels(readyChannels);

      incrementUnread(1);

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.unreadCount).toBe(4); // was 3
    });

    it('skips increment for the active channel', () => {
      setChannels(readyChannels);
      setActiveChannel(1);
      // setActiveChannel clears unread, so it's now 0
      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);

      incrementUnread(1);

      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.unreadCount).toBe(0); // unchanged — active channel skips increment
    });

    it('is a no-op for unknown channel id', () => {
      setChannels(readyChannels);
      const before = channelsStore.getState();

      incrementUnread(999);

      expect(channelsStore.getState()).toBe(before);
    });
  });

  describe('clearUnread', () => {
    it('resets unread count to 0', () => {
      setChannels(readyChannels);
      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(3);

      clearUnread(1);

      expect(channelsStore.getState().channels.get(1)?.unreadCount).toBe(0);
    });

    it('is a no-op for unknown channel id', () => {
      setChannels(readyChannels);
      const before = channelsStore.getState();

      clearUnread(999);

      expect(channelsStore.getState()).toBe(before);
    });
  });

  describe('setRoles', () => {
    it('stores roles from ready payload', () => {
      const roles = [
        { id: 1, name: 'admin', color: '#ff0000', position: 0 },
        { id: 2, name: 'member', color: '#00ff00', position: 1 },
      ];
      setRoles(roles);
      expect(channelsStore.getState().roles).toEqual(roles);
    });

    it('replaces existing roles', () => {
      setRoles([{ id: 1, name: 'admin', color: '#ff0000', position: 0 }]);
      setRoles([{ id: 2, name: 'member', color: '#00ff00', position: 0 }]);
      expect(channelsStore.getState().roles).toHaveLength(1);
      expect(channelsStore.getState().roles[0]!.name).toBe('member');
    });
  });

  describe('getRoleIdByName', () => {
    it('returns role id for matching name (case-insensitive)', () => {
      setRoles([
        { id: 1, name: 'Admin', color: '#ff0000', position: 0 },
        { id: 2, name: 'Member', color: '#00ff00', position: 1 },
      ]);
      expect(getRoleIdByName('admin')).toBe(1);
      expect(getRoleIdByName('ADMIN')).toBe(1);
      expect(getRoleIdByName('member')).toBe(2);
    });

    it('returns undefined for non-existent role', () => {
      setRoles([{ id: 1, name: 'admin', color: '#ff0000', position: 0 }]);
      expect(getRoleIdByName('moderator')).toBeUndefined();
    });

    it('returns undefined when no roles set', () => {
      expect(getRoleIdByName('admin')).toBeUndefined();
    });
  });

  describe('updateChannelPosition', () => {
    it('updates a channel position', () => {
      setChannels(readyChannels);

      updateChannelPosition(1, 5);

      expect(channelsStore.getState().channels.get(1)?.position).toBe(5);
    });

    it('is a no-op for unknown channel id', () => {
      setChannels(readyChannels);
      const before = channelsStore.getState();

      updateChannelPosition(999, 5);

      expect(channelsStore.getState()).toBe(before);
    });

    it('is a no-op when position is already the same', () => {
      setChannels(readyChannels);
      const before = channelsStore.getState();

      updateChannelPosition(1, 0); // position 0 is already set

      expect(channelsStore.getState()).toBe(before);
    });

    it('produces a new channel object (immutable)', () => {
      setChannels(readyChannels);
      const before = channelsStore.getState().channels.get(1);

      updateChannelPosition(1, 10);

      const after = channelsStore.getState().channels.get(1);
      expect(before).not.toBe(after);
      expect(after?.position).toBe(10);
    });
  });

  describe('getChannelsByCategory — DM filtering', () => {
    it('excludes DM channels from category grouping', () => {
      setChannels([
        { id: 1, name: 'general', type: 'text', category: 'Text', position: 0 },
        { id: 2, name: 'dm-channel', type: 'dm', category: null, position: 0 },
      ]);

      const grouped = getChannelsByCategory();
      // DM channels should be filtered out
      expect(grouped.size).toBe(1);
      expect(grouped.has('Text')).toBe(true);
      // Verify the DM is not in any group
      for (const channels of grouped.values()) {
        expect(channels.every((ch) => ch.type !== 'dm')).toBe(true);
      }
    });
  });

  describe('getChannelsByCategory — sort order', () => {
    it('sorts channels within same category by position', () => {
      setChannels([
        { id: 1, name: 'c-channel', type: 'text', category: 'Text', position: 2 },
        { id: 2, name: 'a-channel', type: 'text', category: 'Text', position: 0 },
        { id: 3, name: 'b-channel', type: 'text', category: 'Text', position: 1 },
      ]);

      const grouped = getChannelsByCategory();
      const textChannels = grouped.get('Text')!;
      expect(textChannels[0]!.name).toBe('a-channel');
      expect(textChannels[1]!.name).toBe('b-channel');
      expect(textChannels[2]!.name).toBe('c-channel');
    });
  });

  describe('setActiveChannel — edge case: unknown channel with unread=0', () => {
    it('sets activeChannelId even for a channel not in the map', () => {
      setActiveChannel(999);
      expect(channelsStore.getState().activeChannelId).toBe(999);
    });
  });

  describe('updateChannel — no changes', () => {
    it('still creates new object when neither name nor position is provided', () => {
      setChannels(readyChannels);

      updateChannel({ id: 1 } as ChannelUpdatePayload);

      // Channel should still exist with original values
      const ch = channelsStore.getState().channels.get(1);
      expect(ch?.name).toBe('general');
      expect(ch?.position).toBe(0);
    });
  });
});
