/**
 * Ctrl/Cmd+B/I/U markdown wrapping, shared by the composer and the inline
 * message editor. Pure, so it is testable without a DOM selection.
 */

/** Ctrl/Cmd shortcut → markdown marker it wraps the selection in. */
export const FORMAT_MARKERS: Readonly<Record<string, string>> = {
  b: "**",
  i: "*",
  u: "__",
};

export interface WrapResult {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/**
 * Wrap (or unwrap) `[start, end)` of `value` in `marker`, returning the new
 * value and where the selection should land. With an empty selection the
 * markers are inserted around the caret so typing continues inside them.
 *
 * Pure so the behaviour can be tested without a DOM selection.
 */
export function wrapWithMarker(
  value: string,
  start: number,
  end: number,
  marker: string,
): WrapResult {
  const selected = value.slice(start, end);
  const len = marker.length;

  // Already wrapped — pressing the shortcut again takes the markers back off.
  // The interior must not itself contain the marker: otherwise a selection
  // that merely starts and ends with it (e.g. multiple already-wrapped spans,
  // or a longer marker like "**" matching the outer edge of "*x*") would be
  // mistaken for a single wrapped span and have its interior markers stripped.
  if (
    selected.length > 2 * len &&
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    !selected.slice(len, selected.length - len).includes(marker)
  ) {
    const inner = selected.slice(len, selected.length - len);
    return {
      value: value.slice(0, start) + inner + value.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }
  if (value.slice(start - len, start) === marker && value.slice(end, end + len) === marker) {
    // The characters immediately outside the selection match this marker,
    // but matching alone doesn't prove they *are* this marker rather than
    // the edge of a longer run of the same repeated character — e.g. the
    // single "*" bordering a double-clicked word inside "**bold**" matches
    // the italic marker "*", but it's really one half of a "**" bold pair.
    // Compare the full contiguous run of the marker's character against
    // exactly one marker-width: a run that's a whole marker-width *longer*
    // means the true neighbour is a bigger marker, so unwrapping here would
    // tear it apart. Fall through to wrapping (adding this marker as an
    // extra layer) instead.
    const markerChar = marker[0];
    const runLength = (index: number, step: -1 | 1): number => {
      let i = index;
      let count = 0;
      while (value[i] === markerChar) {
        count++;
        i += step;
      }
      return count;
    };
    const leftRun = runLength(start - 1, -1);
    const rightRun = runLength(end, 1);
    const leftIsLongerMarker = leftRun - len === len;
    const rightIsLongerMarker = rightRun - len === len;
    if (!leftIsLongerMarker && !rightIsLongerMarker) {
      return {
        value: value.slice(0, start - len) + selected + value.slice(end + len),
        selectionStart: start - len,
        selectionEnd: start - len + selected.length,
      };
    }
  }

  return {
    value: value.slice(0, start) + marker + selected + marker + value.slice(end),
    selectionStart: start + len,
    selectionEnd: start + len + selected.length,
  };
}
