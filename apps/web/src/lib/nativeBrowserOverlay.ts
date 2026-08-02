// FILE: nativeBrowserOverlay.ts
// Purpose: Signals React overlay changes to native browser surfaces so they can
//          re-evaluate visibility and pointer-event occlusion.
// Layer: Web/Electron surface coordination

export const NATIVE_BROWSER_OVERLAY_SYNC_EVENT = "synara:native-browser-overlay-sync";

export function notifyNativeBrowserOverlayChanged(): void {
  window.dispatchEvent(new Event(NATIVE_BROWSER_OVERLAY_SYNC_EVENT));
}
