/** Which container a voice clip is recorded in. */

/** In order of preference; WebView2 gives webm/opus. No MP4: the server's type
 *  sniff does not recognise every MP4 audio brand, so an engine that records
 *  only MP4 takes the WAV fallback instead. */
export const RECORDER_MIMES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
];

export interface MimeSupport {
  isTypeSupported(type: string): boolean;
}

/** The first of RECORDER_MIMES the recorder supports, or null (use the PCM fallback). */
export function pickRecorderMime(recorder: MimeSupport | null | undefined): string | null {
  if (recorder === null || recorder === undefined) return null;
  for (const mime of RECORDER_MIMES) {
    try {
      if (recorder.isTypeSupported(mime)) return mime;
    } catch {
      // A recorder that throws on a type does not support it.
    }
  }
  return null;
}

/** The file extension for a recorded clip's container. */
export function clipExtension(mime: string): string {
  const base = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (base === "audio/webm") return "webm";
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/mp4") return "m4a";
  return "wav";
}

/** `voice-message.<ext>` */
export function clipFilename(mime: string): string {
  return `voice-message.${clipExtension(mime)}`; // i18n-exempt: a file name, not UI text
}
