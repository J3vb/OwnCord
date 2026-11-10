/**
 * Holds a published video sender's layers under a bitrate cap without a
 * republish: the top layer runs at the stream's capped rate and every lower
 * layer at the lower of its own rate and that top. The Linux host applies the
 * same rule to its own senders (`native_voice/session/video_bitrate.rs`).
 */

/** What a sender's layers carried when we first saw them, and what we last set,
 *  so a lifted cap can restore a layer and a re-read after the SDK re-sized the
 *  layers does not mistake our own clamp for the SDK's choice. */
interface SenderLayers {
  original: (number | undefined)[];
  applied: (number | undefined)[];
}

const layersBySender = new WeakMap<RTCRtpSender, SenderLayers>();

/** The top layer of `encodings`: the one at full size (the last of equals). */
function topIndex(encodings: readonly RTCRtpEncodingParameters[]): number {
  let best = -1;
  encodings.forEach((e, i) => {
    if (best < 0 || (e.scaleResolutionDownBy ?? 1) <= (encodings[best]?.scaleResolutionDownBy ?? 1))
      best = i;
  });
  return best;
}

/** The rates each layer should carry under a top of `top`: the top layer takes
 *  `top`, every other layer the lower of its own original rate and `top` (a
 *  layer with no original rate stays unset). Pure. */
export function cappedLayerRates(
  original: readonly (number | undefined)[],
  topAt: number,
  top: number,
): (number | undefined)[] {
  return original.map((rate, i) => {
    if (i === topAt) return top;
    return rate === undefined ? undefined : Math.min(rate, top);
  });
}

/** Remember the sender's layers as the originals. Call right after a publish
 *  and after the SDK re-sizes the layers; a layer still carrying what we last
 *  set keeps its older original. */
export function recordSenderLayers(sender: RTCRtpSender | undefined): void {
  if (sender === undefined) return;
  const encodings = sender.getParameters().encodings ?? [];
  const prev = layersBySender.get(sender);
  const same = prev !== undefined && prev.original.length === encodings.length;
  const original = encodings.map((e, i) =>
    same && prev.applied[i] === e.maxBitrate ? prev.original[i] : e.maxBitrate,
  );
  layersBySender.set(sender, { original, applied: encodings.map((e) => e.maxBitrate) });
}

/** Set the sender's top layer to `top` bits per second (and `maxFramerate`
 *  when given), with every lower layer held under it, in one setParameters.
 *  The first call on a sender records its layers. */
export async function setSenderTop(
  sender: RTCRtpSender | undefined,
  top: number,
  maxFramerate?: number,
): Promise<void> {
  if (sender === undefined) return;
  if (!layersBySender.has(sender)) recordSenderLayers(sender);
  const params = sender.getParameters();
  const encodings = params.encodings ?? [];
  const topAt = topIndex(encodings);
  const layers = layersBySender.get(sender);
  if (topAt < 0 || layers === undefined) return;
  // A re-size since the last record changes the layer count: start over.
  if (layers.original.length !== encodings.length) recordSenderLayers(sender);
  const original = layersBySender.get(sender)?.original ?? [];
  const next = cappedLayerRates(original, topAt, top);
  encodings.forEach((e, i) => {
    const rate = next[i];
    if (rate === undefined) delete e.maxBitrate;
    else e.maxBitrate = rate;
  });
  const topEncoding = encodings[topAt];
  if (topEncoding !== undefined && maxFramerate !== undefined)
    topEncoding.maxFramerate = maxFramerate;
  await sender.setParameters(params);
  layersBySender.set(sender, { original, applied: next });
}
