# Who can read what

Plain answers about privacy on an OwnCord server. Every claim here is backed by
code and tests, listed in the [evidence page](architecture/trust-model-evidence.md).

## The short answer

| Who                                 | Text chat and files | Voice, video, screen share    |
| ----------------------------------- | ------------------- | ----------------------------- |
| You and the people in the channel   | Yes                 | Yes                           |
| Moderators, in channels they manage | Yes                 | Only if they join the call    |
| The person who runs the server      | **Yes**             | **No** (end-to-end encrypted) |
| Your network, or anyone in between  | No (encrypted)      | No                            |
| Other OwnCord servers               | No                  | No                            |

**If you trust the person who runs the server with your words, OwnCord keeps
everyone else out. If you do not trust them, do not type there.** There is no
company behind OwnCord that can see your data: each server is run by one
person or group.

## Text chat and files

The server stores messages, direct messages and files in plain form. It needs
to, so it can deliver messages to people who were offline, keep history,
search, moderate and make backups. Direct messages are stored the same way as
channel messages.

What the server never stores in plain form:

- **Passwords**: only a one-way hash.
- **Sign-in tokens**: only a hash.
- **Two-factor secrets**: encrypted with a key on the server.

Message text never goes into the log or the audit log.

## Voice, video and screen share

Calls are **end-to-end encrypted**. The key is made on a participant's computer
and shared only with the others in the call. The server passes the encrypted
sound and video along without ever having the key. A new key is made when
someone leaves, and again from time to time during the call.

If the server reports a stream as not encrypted, the app refuses to play it and
shows the call as **Unsecured**.

What encryption does **not** hide: who is in which call, when, and for how
long, or who is muted.

**The limit.** The server decides who is in a call. A server owner who
**changes the server's code** could add a hidden participant and receive the
call key. The app warns when a known person's key changes, but it cannot spot a
participant it has never seen before. So encryption protects you from an owner
who only looks at what the server stores, not from one who rewrites the
server.

**Checking someone's key.** Each person has a key that the app remembers the
first time it sees it. If it changes later, you get a notice. Compare the
safety number with that person another way (in person, a call) to be sure.
Someone with two devices shows up as a key change when they switch.

## The connection

Everything between the app and the server is encrypted (TLS), unless the owner
turned TLS off without a proxy in front.

The first time you connect, the desktop app shows the server's certificate
fingerprint and asks you to trust it. **Compare it with the one the server
owner gives you another way** before you accept. After that, the app checks
every connection against it.

- A normal certificate renewal on a public domain is accepted without asking.
- Any other change shows a **Certificate Changed** warning. Ask the owner
  before you accept: it can also mean someone is listening in.
- The browser client cannot do this check. It trusts whatever the browser
  trusts, so a server that hosts it needs a proper certificate.

How owners set this up: [TLS and reverse proxies](hosting/tls-and-proxy.md).

## On disk

- **On the server**, the database, files and backups are **not encrypted**.
  Protect them with file permissions and disk encryption. Treat backups like
  the database itself.
- **On your computer**, the app keeps your sign-in and your voice key in the
  system keychain (Windows Credential Manager or the Linux keyring). If there
  is no keychain, it uses an encrypted file. Details:
  [credential-storage.md](credential-storage.md).

## What the server owner can and cannot do

**Can:**

- read, search, delete and back up any text or file
- see who is online, who is in which call, and each session's device and
  address
- ban, sign people out, change roles and settings (each is written to the
  audit log)

**Cannot:**

- listen to a call from what the server stores or relays
- see your password or reuse a sign-in token from the database
- swap the key of someone you already know without a notice
- read your messages on another OwnCord server

**Can, with effort:** someone with full access to the server machine can change
its code, database or settings. No protection survives that, not even call
encryption, as explained above.

## Lost access

- Your **recovery kit** gets you back in when your password and devices are
  gone. The server keeps only a check value, so it cannot show it again. Keep
  it offline.
- The **server owner** can issue a one-time recovery code after checking who
  you are outside OwnCord. Nobody else can reset your password.
- Five wrong tries lock recovery for 15 minutes.

## Several devices

You can be signed in on up to 25 devices. You can see and sign out each one in
**Settings**, or sign out everywhere. Changing your password signs out every
other device.

## Deleted accounts

Deleting an account removes its messages, files and sign-ins for good, and
wipes the free space they used. Restoring an old backup does not bring it back:
the server deletes it again at start-up, as long as the owner restored the
whole data folder.

The audit log keeps entries about a deleted account, but without the name.

## What OwnCord does not have

- **No federation.** Servers never talk to each other.
- **No directory.** Nobody finds your server unless you give them the address.
- **No shared accounts.** The same username on two servers is two different
  people.
- **No telemetry, no phone-home.** A server on a network without internet
  works. The few things it connects out for (update checks, the voice server
  download, the GIF picker, Let's Encrypt) only happen when someone uses them.
- **No encrypted text chat.** That would cost search, moderation and history.

## For contributors

Code comments that point to `docs/trust-model.md` for the desktop preview
destination policy (C-09), the outbound connections table or the at-rest and
transport tables mean the [evidence page](architecture/trust-model-evidence.md),
which keeps those sections with their code and test references.
