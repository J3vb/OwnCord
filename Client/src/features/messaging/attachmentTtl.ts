/**
 * How long an uploaded, unsent attachment id is trusted. The server's
 * maintenance sweep deletes unlinked attachments about an hour after upload
 * (Server/internal/app/maintenance.go), and a send silently skips an id it no
 * longer knows. A staged chip past this age (a margin under the sweep) is never
 * sent: it re-uploads from its file, or is marked expired when the file is gone
 * (a restored draft), and Send refuses until it is fresh. A queued send checks
 * the same age when its last upload lands (sendQueue.ts).
 */
export const ATTACHMENT_TTL_MS = 50 * 60 * 1000;
