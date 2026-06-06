import type { LiveFeedEvent } from "@copilot/shared";

const WS_BASE_URL = process.env.NEXT_PUBLIC_WS_BASE_URL ?? "ws://localhost:8000";

export type LiveFeedHandler = (event: LiveFeedEvent | { type: "heartbeat" }) => void;

export function connectLiveFeed(sessionId: string, onMessage: LiveFeedHandler): WebSocket {
  const url = `${WS_BASE_URL}/api/live-feed/${sessionId}`;
  const ws = new WebSocket(url);
  ws.onmessage = (raw) => {
    try {
      const parsed = JSON.parse(raw.data) as LiveFeedEvent | { type: "heartbeat" };
      onMessage(parsed);
    } catch (err) {
      console.error("[live-feed] bad message", err);
    }
  };
  return ws;
}
