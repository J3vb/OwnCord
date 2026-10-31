# Moderation guide

This page is for the owner, admins and moderators of an OwnCord server. It
explains who can do what, how to handle a report, which action to pick, and
what each action does to the member. It describes what the server and the
desktop app do today. For the exact routes and error codes, see
[api.md](api.md#reports-and-the-moderation-queue).

OwnCord is one community per server. There is no central service: reports,
actions and appeals stay on your server, and only your own moderators see
them.

## Where moderation happens

You moderate from two places.

- **The desktop app.** Right-click a member (or focus them and press the Menu
  key or Shift+F10) for the member menu. Right-click a message for the message
  menu. Right-click a channel for the channel menu. If your role can work the
  report queue, the sidebar shows **Moderation**, which opens the Moderation
  Center with a **Reports** tab and an **Appeals** tab.
- **The admin panel** at `https://<your server>/admin`. It has the Members
  list (with pending registrations and bans), Roles & permissions, Channels,
  Invites, Settings, Message retention and the Audit log. By default it only
  opens from this machine and private networks; see
  [Reaching `/admin` on a headless server](deployment.md#first-run).

Each item in a menu or the admin panel only shows when your role has the
permission it needs.

## Roles and permissions

Permissions come from roles. A member can hold several roles; their
permissions add up. Set them in the admin panel under **Roles &
permissions**. Channels and categories can also allow or deny a permission for
one role or one member.

The permissions that matter for moderation:

| Permission           | What it lets the holder do                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| **Moderate Members** | Open the Moderation Center, work reports and appeals, warn members, time them out and lift a timeout.  |
| **Manage Messages**  | Delete other people's messages, and purge recent messages in a channel.                                |
| **Kick Members**     | Force logout: sign a member out of every session.                                                      |
| **Ban Members**      | Ban and unban.                                                                                         |
| **Mute Members**     | Server-mute, server-deafen and disconnect people in voice, and move lower-ranked members.              |
| **Move Members**     | Move anyone between voice channels, whatever their rank. Only the owner or an Administrator grants it. |
| **Manage Nicknames** | Set or clear another member's nickname.                                                                |
| **Manage Channels**  | Create, edit and delete channels, including slow mode and the age-restricted label.                    |
| **Manage Invites**   | Create and revoke invite codes.                                                                        |
| **View Audit Log**   | Read the admin panel's Audit log.                                                                      |
| **Erase Accounts**   | Erase a member's account for good. Only the owner or an Administrator grants it.                       |

A new server has four roles: Owner, Admin, Moderator and Member. The default
**Moderator** role can work reports, warn and time out, delete messages,
manage channels, force logout, ban and change nicknames. It cannot server-mute
in voice or read the audit log. Give it **Mute Members** or **View Audit Log**
if your moderators need them.

> **After an upgrade, check your Moderator role.** Moderate Members and Manage
> Nicknames are only given automatically to a Moderator role that was never
> renamed or edited. If you changed that role before upgrading, nobody can
> open the report queue until you tick **Moderate Members** (and **Manage
> Nicknames**) on the role that should have it.

### The rank rule

Roles have an order. Warn, time out, force logout, ban and change nickname
only work on a member whose top role is **below** yours. You cannot act on
yourself, on someone at your own rank, on someone above you, or on the owner.
The server checks this again at the moment it saves the action, so a member
promoted a second earlier is refused, not sanctioned.

Message removal is the one exception: Manage Messages in a channel is enough
to remove anyone's message there, whatever their rank.

## Handling a report

Members report a message, an attachment or a user from the message menu or
the profile popup. They pick a reason (spam, harassment, unmarked adult
content, illegal content, something else) and can add up to 2,000 characters
of detail. A member can send at most 5 reports in 10 minutes, and only one
open report per target.

Reports arrive in **Moderation › Reports**. To work one:

1. **Open it.** You see who it is about, who sent it, the reason, the
   reporter's details and, for a message report, an **evidence** snapshot:
   the reported message with the messages around it, captured when the report
   was sent. The snapshot stays even if the message is later edited or
   deleted.
2. **Take it.** **Take this report** assigns it to you, so two moderators do
   not work the same report.
3. **Add internal notes** if you want a record of your reasoning. Notes are
   seen only by moderators, never by the reporter or the member reported.
4. **Act, if needed.** The **Actions** part of the report offers a warning, a
   timeout, removing the reported message, force logout and a ban. An action
   taken here is linked to the report, so an appeal later shows where it came
   from.
5. **Close it** with an outcome: **Action taken**, **No action needed** or
   **Already reported**. A closed report cannot be reopened or changed.

Every step lands in the report's **History**, which nobody can edit or delete.

Rules the server keeps for you:

- **The member reported never learns about the report.** A moderator who is
  the subject of a report does not see it in the queue at all.
- **You cannot review your own report.** If you sent it, another moderator
  has to take it.
- **The reporter sees only the status** (waiting, in review, closed and the
  outcome) in **Settings › Privacy & Safety**. They never see who took it or
  the internal notes.
- **Age-restricted evidence stays hidden until you accept the warning.** If
  the report came from an age-restricted channel, the evidence only shows
  after you have accepted that channel's warning yourself. No permission
  skips this, Administrator included.

## Choosing an action

From mildest to strongest:

| Action               | Where                                                | What the member sees                                                                                                                                                                                  | Can they appeal? |
| -------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **Warning**          | a report's Actions                                   | A notice with your reason, now or the next time they sign in. They must acknowledge it.                                                                                                               | Yes              |
| **Timeout**          | member menu (presets), or a report (any length)      | For 1 minute to 28 days they cannot send or edit messages, react, join voice, start a DM or group DM, ring a call or set a custom status. They can still read. It applies at once, with no reconnect. | Yes              |
| **Remove a message** | message menu, or a report                            | The message is deleted for everyone.                                                                                                                                                                  | Yes              |
| **Purge**            | channel menu, **Purge Messages…**                    | The newest 1 to 100 messages in the channel are deleted at once.                                                                                                                                      | No               |
| **Force logout**     | member menu, a report, or admin panel › Members      | Every session is signed out. **They can sign straight back in.**                                                                                                                                      | No               |
| **Ban**              | member menu, a report, or admin panel › Members      | They are disconnected and cannot sign in until the ban ends or is lifted.                                                                                                                             | After it ends    |
| **Erase account**    | admin panel › Members, **Erase account permanently** | The account and everything it posted are deleted. **This cannot be undone.**                                                                                                                          | No               |

Some details worth knowing:

- **Kick is force logout.** There is no "remove from server" on a single
  community server, so a kick only signs the member out. To keep someone out,
  ban them.
- **Timeout presets.** The member menu offers 60 seconds, 5 and 10 minutes,
  1 hour, 1 day and 1 week, and **Remove Timeout** once one is running. A
  report lets you type any length up to 28 days. A timeout also server-mutes
  the member in voice, but only if you hold Mute Members in the voice channel
  they are in right now.
- **Ban length.** Forever, 1 hour, 1 day, 7 days or 30 days. In the desktop app
  the ban dialog can also delete the member's messages from the previous hour
  up to the previous 7 days. Lift a ban from the **Banned** group in the member
  list, or with **Unban** in admin panel › Members, which also shows the
  reason and end date.
- **Warnings need a report in the app.** The desktop app offers a warning from
  a report's Actions. The server also takes a warning without a report through
  [`POST /api/v1/moderation/users/{id}/warn`](api.md#post-apiv1moderationusersidwarn).
- **Reasons are shown to the member.** The reason you type for a warning or
  timeout is what the member reads. Keep report details and other members'
  names out of it.
- **Erase is not a ban.** Erasing deletes the account, its messages and DMs,
  uploads, reactions, sessions and invites. Its audit-log entries stay without
  its name. You must type the username to confirm. Take a
  [backup](hosting/backups.md) first if you might need the content.

### Voice

Right-click someone in a voice channel for **Server Mute**, **Server
Deafen**, **Move to** and **Disconnect**. These need Mute Members in that
channel (or Move Members to move anyone). The member sees "Muted by a
moderator" or "Deafened by a moderator".

### Channels

In a channel's settings (channel menu › **Edit Channel**, or admin panel ›
Channels):

- **Slow Mode** makes each member wait between messages, from a few seconds
  up to 6 hours.
- **Age-restricted (NSFW)** shows each member a one-time warning before the
  channel's content loads. It is a label: the server does not filter content.
- Channel and category **permissions** let you allow or deny any permission
  for one role or one member, for example to make a channel read-only.

### Importing a Discord channel

Admin panel › Channels › **Import from Discord** brings one Discord channel's
history in as a new text channel. It needs Manage Channels.

1. In [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter)
   export the channel in **JSON** format with **Download media** on. That gives
   `channel.json` and a `channel.json_Files` folder.
2. Zip the `.json` file together with its `_Files` folder. A `.json` file on
   its own works too, without pictures or files.
3. Pick the file and a category, then press **Import**. A progress bar shows
   how many messages are in so far; **Cancel** stops it and keeps nothing.

The channel appears for everyone at once when the import finishes, with every
message already read, so nobody is pinged or sees an unread badge. Messages
keep their Discord time, edit time, replies (when the replied-to message is in
the same export) and pins. Each shows the Discord display name with an
**Imported** tag; no member account is created or linked. `@mentions` stay
plain text and notify nobody. Reactions, embeds, stickers, polls, threads and
system messages (joins, boosts, calls) are skipped and counted in the result
line, as are attachments whose file is not in the zip, is a blocked type or is
over the upload limit. Links to `cdn.discordapp.com` are never fetched.

Things to know:

- One import runs at a time. If the server restarts mid-import the half-built
  channel is removed and you start again.
- The file is held under `data/import-tmp` while it imports and is deleted
  afterwards. The largest file accepted is `upload.import_max_mb` (500 MB by
  default).
- [Message retention](#records-and-how-long-they-are-kept) treats imported
  messages like any other: with a retention window on, history older than the
  window is deleted by the next sweep, so the panel warns you. Pinned messages
  are kept.
- Starting and publishing an import are in the audit log
  (`discord_import_start`, `discord_import_publish`).

## Appeals

A member appeals from **Settings › Privacy & Safety**, where they see every
warning, timeout, removal and ban made against them. They can appeal each one
once, with an optional statement, and file at most 3 appeals a day. A force
logout or a purge cannot be appealed: there is nothing to reverse.

A member who is **still banned** cannot sign in, so they cannot appeal in the
app. Tell your members how to reach you outside OwnCord (a mail address,
another chat) for that case.

Appeals arrive in **Moderation › Appeals**:

1. Open the appeal. You see the action, its reason, the member's statement and
   a link to the report it came from, if any.
2. **Take this appeal.** Only the moderator who took it can decide it.
3. Choose **Uphold** (the action stands) or **Overturn**, and optionally
   write a note to the member. The note is sent to them, so it is not an
   internal note.

What overturning does:

| Action  | Overturning…                                                 |
| ------- | ------------------------------------------------------------ |
| Warning | clears it from the member's notices. It stays in the record. |
| Timeout | lifts it, if it is still running.                            |
| Ban     | lifts it, unless a later ban replaced it.                    |
| Removal | is recorded only. The removed message is **not** restored.   |

A decision is final. The member sees the decision and your note, never who
decided. You do not see your own appeals in the queue. If you issued the
action, another moderator should decide its appeal; the server lets you
decide it only when no other moderator can, and records that you did.

## Who can join

In admin panel › **Settings › Access & registration**, choose who can join:

- **Invite** (the default): new members need an invite code. Create and revoke
  codes in admin panel › **Invites**. You set how many uses and when it
  expires.
- **Approval**: anyone can apply, and an admin approves or denies each one in
  **Members › Pending**. Denying is final and frees the username.
- **Open**: anyone can register.
- **Closed**: nobody new can register.

Open and Approval allow 5 registrations per address per day. Approval holds at
most 100 waiting applications.

Each member can also protect themselves: **Block** in the member menu stops
direct messages both ways, and **Settings › Privacy & Safety** controls who
can send them direct messages and message requests.

## Records and how long they are kept

- **Report history** and **moderator actions** are recorded by the server and
  cannot be edited. A member's full action history is available to Moderate
  Members holders through
  [`GET /api/v1/moderation/users/{id}/actions`](api.md#get-apiv1moderationusersidactions).
- **The audit log** (admin panel › **Audit log**, needs View Audit Log)
  records role, channel, member, settings and other admin changes, with
  search and an action filter. Report notes and history are not in it; they
  stay in the Moderation Center.
- **Closed reports** keep their evidence, notes and detail for 180 days, then
  that content is deleted and the report row stays
  (`moderation.report_retention_days`).
- **Finished warnings and timeouts** retire 90 days after they were
  acknowledged, ended or lifted, unless an appeal points at them
  (`moderation.action_retention_days`). Bans and removals are never retired.
- **Messages** are kept forever by default. Admin panel › **Message
  retention** can delete old messages after a number of days, for the whole
  server or per channel, and shows what would go before it changes anything.
  Pinned messages and direct messages are never deleted by retention.

Both moderation settings are in [server-configuration.md](server-configuration.md).
`0` keeps everything.

## Before you need it

- Make sure at least two people hold **Moderate Members**, so a report about
  one moderator, or one a moderator sent, can still be reviewed.
- Check the Moderator role's permissions after every upgrade (see above).
- Tell members how to contact you outside OwnCord, for ban appeals.
- Take a [backup](hosting/backups.md) before erasing an account or
  shortening message retention. Both delete data for good.

## See also

- [api.md — Reports and the moderation queue](api.md#reports-and-the-moderation-queue),
  [Moderator actions](api.md#moderator-actions) and [Appeals](api.md#appeals)
- [trust-model.md](trust-model.md): what the operator and moderators can read
- [architecture/community-services.md](architecture/community-services.md):
  the design, abuse cases and data ownership of reports, actions and appeals
- [server-configuration.md](server-configuration.md): every setting
