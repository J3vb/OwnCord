import { describe, expect, it } from "vitest";
import { bitrates, fakeSender } from "../../../tests/helpers/fakeSender";
import { cappedLayerRates, recordSenderLayers, setSenderTop } from "./senderLayers";

describe("cappedLayerRates", () => {
  it("the top layer takes the top and lower layers stay under it", () => {
    expect(cappedLayerRates([450_000, 1_700_000, 4_000_000], 2, 1_000_000)).toEqual([
      450_000, 1_000_000, 1_000_000,
    ]);
  });

  it("a layer without a rate stays without one", () => {
    expect(cappedLayerRates([undefined, 900_000], 1, 500_000)).toEqual([undefined, 500_000]);
  });
});

describe("setSenderTop", () => {
  const layers = [
    [4, 450_000],
    [2, 1_700_000],
    [1, 4_000_000],
  ] as const;

  it("does nothing for a sender that is gone", async () => {
    await expect(setSenderTop(undefined, 1_000_000)).resolves.toBeUndefined();
  });

  it("holds the lower layers under a new top in one setParameters", async () => {
    const fake = fakeSender(layers);
    await setSenderTop(fake.sender, 1_000_000, 30);
    expect(fake.setParameters).toHaveBeenCalledTimes(1);
    expect(bitrates(fake)).toEqual([450_000, 1_000_000, 1_000_000]);
    expect(fake.encodings[2]?.maxFramerate).toBe(30);
    expect(fake.encodings[0]?.maxFramerate).toBeUndefined();
  });

  it("finds the top layer by its size, whatever the encoding order", async () => {
    const fake = fakeSender([
      [1, 4_000_000],
      [4, 450_000],
    ]);
    await setSenderTop(fake.sender, 800_000);
    expect(bitrates(fake)).toEqual([800_000, 450_000]);
  });

  it("a lifted cap restores a lower layer the cap had held down", async () => {
    const fake = fakeSender(layers);
    await setSenderTop(fake.sender, 600_000);
    expect(bitrates(fake)).toEqual([450_000, 600_000, 600_000]);
    await setSenderTop(fake.sender, 4_000_000);
    expect(bitrates(fake)).toEqual([450_000, 1_700_000, 4_000_000]);
  });

  it("re-recording after the SDK re-sized keeps a clamped layer's older original", async () => {
    const fake = fakeSender(layers);
    await setSenderTop(fake.sender, 600_000);
    // The SDK left the clamped layers as they were: still the same originals.
    recordSenderLayers(fake.sender);
    await setSenderTop(fake.sender, 4_000_000);
    expect(bitrates(fake)).toEqual([450_000, 1_700_000, 4_000_000]);
  });

  it("re-recording after the SDK set new layer rates takes them as the originals", async () => {
    const fake = fakeSender(layers);
    await setSenderTop(fake.sender, 600_000);
    fake.encodings = [
      { scaleResolutionDownBy: 4, maxBitrate: 300_000 },
      { scaleResolutionDownBy: 2, maxBitrate: 900_000 },
      { scaleResolutionDownBy: 1, maxBitrate: 2_000_000 },
    ];
    recordSenderLayers(fake.sender);
    await setSenderTop(fake.sender, 5_000_000);
    expect(bitrates(fake)).toEqual([300_000, 900_000, 5_000_000]);
  });

  it("a layer count that changed since the last record starts over", async () => {
    const fake = fakeSender(layers);
    await setSenderTop(fake.sender, 600_000);
    fake.encodings = [{ scaleResolutionDownBy: 1, maxBitrate: 2_000_000 }];
    await setSenderTop(fake.sender, 1_000_000);
    expect(bitrates(fake)).toEqual([1_000_000]);
  });
});
