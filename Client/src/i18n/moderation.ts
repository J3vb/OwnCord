import { defineCatalog } from "./format";

/** The Moderation Center queue and report evidence (B9-11, BPR-071). */
export const moderationText = defineCatalog("moderation", {
  intro:
    "Reports sent to this server's moderators. Reports about you are never shown here, and reports you sent show no internal notes.",
  "filter.label": "Show",
  "filter.active": "Open and in review",
  "filter.open": "Waiting for review",
  "filter.assigned": "In review",
  "filter.closed": "Closed",
  "count.active": {
    one: "{count} report open or in review",
    other: "{count} reports open or in review",
  },
  "count.open": {
    one: "{count} report waiting for review",
    other: "{count} reports waiting for review",
  },
  "count.assigned": { one: "{count} report in review", other: "{count} reports in review" },
  "count.closed": { one: "{count} closed report", other: "{count} closed reports" },
  "list.label": "Reports",
  "list.loading": "Loading reports…",
  "list.error": "Couldn't load reports.",
  retry: "Try again",
  denied: "You no longer have permission to moderate on this server.",
  "row.who": "About {subject}, reported by {reporter}",
  "row.filed": "Sent {date}",
  "name.unknown": "Unknown account",
  "date.unavailable": "date unavailable",
  "detail.loading": "Loading report…",
  "detail.error": "Couldn't load this report.",
  "detail.notFound": "This report is no longer available.",
  "detail.gone": "The report you had open is no longer in this list.",
  "fact.subject": "About",
  "fact.reporter": "Reported by",
  "fact.state": "Status",
  "fact.assignee": "Assigned to",
  "fact.unassigned": "No one",
  "fact.filed": "Sent",
  "fact.closed": "Closed",
  "detail.reporterNote": "Reporter's details",
  "evidence.title": "Evidence",
  "evidence.captured":
    "Captured {date}, when the report was sent. Shown as plain text: links and media are not loaded.",
  "evidence.none": "No messages were captured with this report.",
  "evidence.reported": "Reported message",
  "evidence.noText": "No text",
  "evidence.attachment": "{name} ({type}, {size})",
  "evidence.byReference":
    "Attachments are kept by reference only. The files are not part of the report and may have been deleted.",
  "evidence.consent":
    "This evidence comes from an age-restricted channel. It is shown only after you confirm, for your account, that you want to see that channel's content.",
  "evidence.channelFallback": "this channel",
  "evidence.unavailable":
    "This evidence can't be shown: the channel it came from can no longer be checked.",
});
