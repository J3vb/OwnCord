// The app's zoom controller, bound to the desktop window. Kept apart from
// `zoom.ts` so that module and its tests never import the platform registry.
import { desktop } from "../../platform/desktop";
import { createZoomController } from "./zoom";

export const appZoom = createZoomController(desktop.window);
export { ZOOM_LEVELS, zoomIndex } from "./zoom";
