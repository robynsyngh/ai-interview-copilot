/**
 * MV3 service worker (background).
 *
 * Architecture note (subtle, important):
 *
 *   We deliberately DO NOT use `setPanelBehavior({ openPanelOnActionClick: true })`.
 *   When that flag is set, Chrome opens the side panel natively and our
 *   `chrome.action.onClicked` listener never fires. The side effect is that
 *   the activeTab permission grant is harder to reason about — Chrome may
 *   not associate the side-panel-open invocation with the tab the user
 *   intended to capture, which causes `chrome.tabCapture.getMediaStreamId`
 *   to fail with "Extension has not been invoked for the current page".
 *
 *   Instead, we listen for `chrome.action.onClicked`. Every click on the
 *   toolbar icon is a real, observable invocation. We:
 *     1. Record the clicked tab id under `invokedTabId` in session storage.
 *     2. Open the side panel for that tab via `chrome.sidePanel.open`.
 *     3. When the user later clicks Start in the side panel, we read
 *        `invokedTabId` and call `chrome.tabCapture.getMediaStreamId` against
 *        it. activeTab is guaranteed to be granted for that tab, because the
 *        user just invoked the extension on it.
 *
 *   To capture a different tab, the user clicks the icon again on that tab.
 */

import type { RuntimeMessage } from "@/lib/messaging";

const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html");
const INVOKED_TAB_KEY = "invokedTabId";

// Make sure clicking the action fires our `onClicked` listener instead of
// being intercepted by Chrome to open the side panel directly. This setting
// is persisted across extension reloads, so we re-assert it on every SW
// startup to undo any prior version that set it to `true`.
async function ensureActionClicksReachUs(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (err) {
    console.warn("[background] setPanelBehavior failed", err);
  }
}

console.info("[background] service worker booted");

void ensureActionClicksReachUs();
chrome.runtime.onInstalled.addListener(() => void ensureActionClicksReachUs());
chrome.runtime.onStartup.addListener(() => void ensureActionClicksReachUs());

chrome.action.onClicked.addListener(async (tab) => {
  console.info("[background] action click received, tabId=", tab?.id, "url=", tab?.url);
  try {
    if (!tab.id) {
      console.warn("[background] action click without tab id");
      return;
    }

    // `sidePanel.open()` is user-gesture sensitive. Call it before any
    // awaited badge/storage work, otherwise Chrome can reject it even though
    // we are inside the toolbar click handler.
    const openPanelPromise = chrome.sidePanel.open({ tabId: tab.id });

    await chrome.storage.session.set({ [INVOKED_TAB_KEY]: tab.id });
    console.info("[background] stored invokedTabId =", tab.id);

    // Visible feedback: brief green badge so the user knows the click landed.
    try {
      await chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
      await chrome.action.setBadgeText({ text: "•" });
      setTimeout(() => void chrome.action.setBadgeText({ text: "" }), 1500);
    } catch {
      /* non-essential */
    }

    await openPanelPromise;
    console.info("[background] sidePanel.open() resolved");
  } catch (err) {
    console.error("[background] action onClicked error", err);
    try {
      await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
      await chrome.action.setBadgeText({ text: "!" });
    } catch {
      /* non-essential */
    }
  }
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.kind === "session.start") {
        // The side panel passes the tabId it intends to capture. We trust it
        // because the side panel is loaded with `invokedTabId` from storage,
        // which was set when the user clicked our toolbar icon on that tab.
        const targetTabId = message.tabId;

        // Tear down any prior capture FIRST. If an earlier session left a
        // stream active on this tab (e.g. it ended in an error or was not
        // stopped cleanly), `chrome.tabCapture.getMediaStreamId` rejects with
        // "Cannot capture a tab with an active stream". We stop the offscreen
        // capture and close the document so the old MediaStream tracks are
        // released and the tab is free to be captured again.
        await chrome.runtime
          .sendMessage({ kind: "offscreen.stop" } satisfies RuntimeMessage)
          .catch(() => undefined);
        await closeOffscreen();

        await ensureOffscreen();

        const streamId = await new Promise<string>((resolve, reject) => {
          chrome.tabCapture.getMediaStreamId({ targetTabId }, (id) => {
            if (chrome.runtime.lastError || !id) {
              reject(
                new Error(
                  chrome.runtime.lastError?.message ??
                    "tabCapture.getMediaStreamId returned empty id",
                ),
              );
              return;
            }
            resolve(id);
          });
        });

        await chrome.runtime.sendMessage({
          kind: "offscreen.start",
          sessionId: message.sessionId,
          liveStreamUrl: message.liveStreamUrl,
          streamId,
        } satisfies RuntimeMessage);

        sendResponse({ ok: true });
      } else if (message.kind === "session.stop") {
        await chrome.runtime
          .sendMessage({ kind: "offscreen.stop" } satisfies RuntimeMessage)
          .catch(() => undefined);
        await closeOffscreen();
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: true });
      }
    } catch (err) {
      console.error("[background] message handler error", err);
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true;
});

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [OFFSCREEN_URL],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Capture meeting tab audio for live transcription.",
  });
}

async function closeOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [OFFSCREEN_URL],
  });
  if (contexts.length === 0) return;
  await chrome.offscreen.closeDocument();
}
