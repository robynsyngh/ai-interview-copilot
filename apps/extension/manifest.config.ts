import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "AI Interview Co-Pilot",
  description: "Capture meeting audio, stream to FastAPI, and render real-time interview hints.",
  version: "0.1.0",
  minimum_chrome_version: "116",

  permissions: ["sidePanel", "tabCapture", "offscreen", "storage", "tabs", "scripting"],
  host_permissions: ["http://localhost:8000/*", "ws://localhost:8000/*", "https://meet.google.com/*"],

  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },

  side_panel: {
    default_path: "src/sidepanel/index.html",
  },

  action: {
    default_title: "Open Interview Co-Pilot",
  },

  web_accessible_resources: [
    {
      resources: ["src/offscreen/offscreen.html", "audio-processor.js"],
      matches: ["<all_urls>"],
    },
  ],
});
