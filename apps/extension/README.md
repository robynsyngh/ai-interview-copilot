# `apps/extension` — Chrome MV3 extension

The green top band of the DFD. Owns:

- **P1** Audio Capture — `src/offscreen/offscreen.ts`
  Uses the [Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) so the
  audio context survives the side panel being closed. Audio is captured via
  `chrome.tabCapture` (skeleton stub today).
- **P2** Session Initializer — `src/sidepanel/App.tsx`
  React UI in the side panel that POSTs to `/api/session` and asks the
  background worker to spin up the offscreen capture.
- Background service worker (`src/background/index.ts`) wires the two together.

## Build

From the **repo root**:

```bash
pnpm install
pnpm dev:ext   # vite build --watch into apps/extension/dist
```

Then in Chrome:

1. Visit `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select `apps/extension/dist`.
4. Click the toolbar icon to open the side panel.

## Notes

- The offscreen document and side panel both reference `localhost:8000` for
  the API and `localhost:3000` for the dashboard. Edit `src/sidepanel/App.tsx`
  if you deploy the API elsewhere.
- Replace the placeholder PNGs in `public/icons/` before publishing.
- The actual `chrome.tabCapture` wiring is a clearly-marked TODO inside
  `offscreen.ts` so the WebSocket / control plane can be reviewed independently.
