/**
 * The voice store and native names the camera and screen share modules use,
 * gathered in one place so each of them imports from a single neighbour.
 */

export {
  setLocalCamera,
  setLocalScreenshare,
  bumpLocalShareRev,
  voiceStore,
} from "@stores/voice.store";
export { isLinuxDesktop, PORTAL_NOT_STARTED, PICKER_DISMISSED } from "./native/platform";
export { nativeCameraSupport } from "./native/devices";
export { channelPeerDecode } from "./peerDecode";
export { resolveCodecChoice, h264GpuPublish } from "./videoCodec";
export { getScreenSourcePicker } from "./native/screenPickerSlot";
export { readSenderSample } from "./shareSenderStats";
