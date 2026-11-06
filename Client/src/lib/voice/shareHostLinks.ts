/**
 * The one place the camera and screen share modules reach up into the voice
 * feature and the voice store. They import these names from here, so the
 * upward imports stay in this file and the other share modules stay in lib/.
 */

export {
  setLocalCamera,
  setLocalScreenshare,
  bumpLocalShareRev,
  voiceStore,
} from "@stores/voice.store";
export {
  isLinuxDesktop,
  PORTAL_NOT_STARTED,
  PICKER_DISMISSED,
} from "../../features/voice/native/platform";
export { nativeCameraSupport } from "../../features/voice/native/devices";
export { channelPeerDecode } from "../../features/voice/peerDecode";
export { resolveCodecChoice, h264GpuPublish } from "../../features/voice/videoCodec";
export { getScreenSourcePicker } from "../../features/voice/native/screenPickerSlot";
export { readSenderSample } from "../../features/voice/shareSenderStats";
