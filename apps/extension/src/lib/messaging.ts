/**
 * Internal message types passed between the extension's three contexts:
 *   - background service worker
 *   - side panel (React)
 *   - offscreen document (audio capture)
 *
 * The on-the-wire format that leaves the extension toward FastAPI lives in
 * `@copilot/shared`. Don't mix the two.
 */

export type RuntimeMessage =
  // Side panel -> background
  | {
      kind: "session.start";
      sessionId: string;
      liveStreamUrl: string;
      tabId: number;
    }
  | { kind: "session.stop" }
  // Background -> offscreen (carries the resolved chrome.tabCapture streamId)
  | {
      kind: "offscreen.start";
      sessionId: string;
      liveStreamUrl: string;
      streamId: string;
    }
  | { kind: "offscreen.stop" }
  // Offscreen -> background / side panel (status events)
  | { kind: "offscreen.ready" }
  | { kind: "offscreen.started" }
  | { kind: "offscreen.error"; message: string }
  | { kind: "offscreen.audio-level"; rms: number };
