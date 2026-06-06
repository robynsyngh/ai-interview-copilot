/**
 * Standalone extension page whose ONLY job is to trigger the microphone
 * permission prompt for the EXTENSION origin.
 *
 * Why this exists: the side panel and the offscreen document cannot surface
 * Chrome's microphone permission prompt (they have no address-bar mic control),
 * so a previously denied/dismissed grant is impossible to fix from there. A
 * real tab on the extension origin DOES show the prompt and the address-bar
 * mic icon, and the grant persists for the whole extension origin — including
 * the offscreen document that actually captures audio.
 */

const statusEl = document.getElementById("status") as HTMLElement;
const retryEl = document.getElementById("retry") as HTMLButtonElement;

async function requestMicrophone(): Promise<void> {
  statusEl.textContent = "Requesting microphone…";
  statusEl.style.color = "#cbd5f5";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // We only needed the grant, not the stream — release the device immediately.
    stream.getTracks().forEach((track) => track.stop());
    statusEl.textContent =
      "✅ Microphone enabled. Close this tab and click Start interview in the side panel.";
    statusEl.style.color = "#34d399";
    retryEl.style.display = "none";
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "Error";
    const detail = err instanceof Error ? err.message : String(err);
    statusEl.textContent =
      `❌ ${name}: ${detail}. Click the mic icon in the address bar above, choose Allow, then press Retry.`;
    statusEl.style.color = "#fca5a5";
    retryEl.style.display = "inline-block";
  }
}

retryEl.addEventListener("click", () => void requestMicrophone());
void requestMicrophone();
