// The in-place camera switch could not run (the new device would not open
// beside the live one, or the host refused), and the live camera is still on
// its old device. `mediaControl` answers it with the restart path. Kept apart
// from the native chunk so shared code can import it.

export class CameraSwitchUnavailable extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "CameraSwitchUnavailable";
  }
}

// The new device opened beside the live one but never gave a picture (an
// infrared sensor): a restart would only take the working camera down for
// the same result. The live camera is still on its old device.
export class CameraDeviceUnusable extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = "CameraDeviceUnusable";
  }
}
