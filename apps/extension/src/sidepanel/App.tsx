/**
 * P2 - Session Initializer (side panel UI).
 *
 * The capture target is bound to the tab where the user clicked the
 * extension's toolbar icon (the background SW writes that tab id under
 * `invokedTabId` in chrome.storage.session). We read it back here, look up
 * the tab metadata, and that's what gets captured on Start.
 *
 * To re-target, the user clicks the toolbar icon again on a different tab.
 * This is the only path that reliably produces an `activeTab` grant we can
 * later consume from the background's `tabCapture.getMediaStreamId` call.
 */

import { useEffect, useRef, useState } from "react";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  DocumentExtractResponse,
} from "@copilot/shared";
import type { RuntimeMessage } from "@/lib/messaging";

const API_BASE = "http://localhost:8000";
const WEB_BASE = "http://localhost:3000";
const WS_BASE = "ws://localhost:8000";

const INVOKED_TAB_KEY = "invokedTabId";

const ACCEPTED_DOC_EXT = [".pdf", ".docx", ".txt", ".md"];
const ACCEPTED_DOC_ATTR = ".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";
const MAX_DOC_BYTES = 8 * 1024 * 1024;

/** Upload a dropped/selected document to the API and return its extracted text. */
async function extractDocumentText(file: File): Promise<string> {
  if (file.size > MAX_DOC_BYTES) {
    throw new Error("File is too large (max 8 MB).");
  }
  const name = file.name.toLowerCase();
  if (!ACCEPTED_DOC_EXT.some((ext) => name.endsWith(ext))) {
    throw new Error("Unsupported file. Use a PDF, Word .docx, or .txt file.");
  }

  const body = new FormData();
  body.append("file", file, file.name);
  const res = await fetch(`${API_BASE}/api/documents/extract`, { method: "POST", body });
  if (!res.ok) {
    let detail = `Upload failed (${res.status}).`;
    try {
      const data = (await res.json()) as { detail?: string };
      if (data?.detail) detail = data.detail;
    } catch {
      /* fall back to the generic message */
    }
    throw new Error(detail);
  }
  const data = (await res.json()) as DocumentExtractResponse;
  return data.text;
}

type Status = "idle" | "starting" | "live" | "stopped" | "error";

interface TargetTab {
  id: number | null;
  url: string;
  title: string;
  favIconUrl?: string;
}

const NON_CAPTURABLE_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
  "devtools://",
  "view-source:",
];

function describeMicError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  switch (name) {
    case "NotAllowedError":
      return (
        "Mic permission is blocked. On macOS: System Settings → Privacy & Security → " +
        "Microphone → enable Google Chrome, then fully quit and reopen Chrome. Also click " +
        "the mic/camera icon in Chrome's address bar and choose Allow, then Start again."
      );
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone device was found. Connect a mic (or pick one in your OS sound settings) and retry.";
    case "NotReadableError":
    case "TrackStartError":
      return "The microphone is busy or unreadable - another app may have exclusive control. Close it and Start again.";
    case "OverconstrainedError":
      return "Your microphone doesn't support the requested settings.";
    default:
      return err instanceof Error ? `${err.name || "Error"}: ${err.message}` : String(err);
  }
}

function classifyTab(url: string): { capturable: boolean; reason?: string } {
  if (!url) return { capturable: false, reason: "Tab URL is unavailable." };
  for (const p of NON_CAPTURABLE_PREFIXES) {
    if (url.startsWith(p)) {
      return {
        capturable: false,
        reason: "Chrome's internal pages can't be captured. Click the toolbar icon while on a regular web tab.",
      };
    }
  }
  return { capturable: true };
}

async function loadInvokedTab(): Promise<TargetTab | null> {
  try {
    const stored = await chrome.storage.session.get(INVOKED_TAB_KEY);
    const tabId = stored[INVOKED_TAB_KEY] as number | undefined;
    if (!tabId) return null;
    const tab = await chrome.tabs.get(tabId);
    return {
      id: tab.id ?? null,
      url: tab.url ?? "",
      title: tab.title ?? "(untitled)",
      favIconUrl: tab.favIconUrl,
    };
  } catch (err) {
    console.warn("[sidepanel] failed to load invoked tab", err);
    return null;
  }
}

export function App() {
  const [jobDescription, setJobDescription] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [candidateName, setCandidateName] = useState("");
  const [mode, setMode] = useState<"interviewer" | "interviewee">("interviewer");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [target, setTarget] = useState<TargetTab | null>(null);
  const [micGranted, setMicGranted] = useState<boolean | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const onMessage = (message: RuntimeMessage) => {
      if (message.kind === "offscreen.started") {
        setError(null);
        setHint(null);
        setStatus((prev) => (prev === "starting" ? "live" : prev));
      }
      if (message.kind === "offscreen.audio-level") {
        setLevel(message.rms);
      }
      if (message.kind === "offscreen.error") {
        // A missing-mic warning is non-fatal: the session still runs tab-only.
        if (/Microphone unavailable/i.test(message.message)) {
          setHint(message.message);
          return;
        }
        setError(`Audio capture failed: ${message.message}`);
        setHint("Check the service worker/offscreen console for the underlying Chrome or WebSocket error.");
        setStatus("error");
      }
    };

    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const t = await loadInvokedTab();
      if (!cancelled) setTarget(t);
    };

    void refresh();

    // If the user clicks the toolbar icon while the panel is already open,
    // the background updates `invokedTabId` in session storage. Re-read on
    // change so the card stays in sync.
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: chrome.storage.AreaName,
    ) => {
      if (area === "session" && INVOKED_TAB_KEY in changes) void refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);

    // Tab metadata can update (favicon load, title change, navigation).
    const onTabUpdated = (
      tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
    ) => {
      if (target?.id === tabId && (changeInfo.url || changeInfo.title || changeInfo.favIconUrl)) {
        void refresh();
      }
    };
    chrome.tabs.onUpdated.addListener(onTabUpdated);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
    };
  }, [target?.id]);

  const classification = target ? classifyTab(target.url) : { capturable: false };
  const canStart =
    !!target?.id &&
    classification.capturable &&
    jobDescription.trim().length > 0 &&
    resumeText.trim().length > 0 &&
    status !== "starting" &&
    status !== "live";

  const startSession = async () => {
    setStatus("starting");
    setError(null);
    setHint(null);
    try {
      if (!target?.id) throw new Error("No invoked tab. Click the extension icon on the meeting tab first.");
      if (!classification.capturable) {
        throw new Error(classification.reason ?? "This tab cannot be captured.");
      }

      // Trigger the microphone permission prompt from this visible page. The
      // offscreen document (same extension origin) cannot show a prompt itself,
      // so granting it here lets the offscreen capture reuse the grant. We stop
      // the tracks immediately - we only needed the permission, not the stream.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
        setMicGranted(true);
        setMicError(null);
      } catch (micErr) {
        // Surface the precise reason instead of silently dropping to tab-only -
        // the user needs to know whether it's an OS permission, a denied prompt,
        // or a busy device so they can actually fix it.
        console.warn("[sidepanel] microphone permission not granted", micErr);
        setMicGranted(false);
        setMicError(describeMicError(micErr));
      }

      const payload: CreateSessionRequest = {
        candidate_name: candidateName.trim() || null,
        job_description: jobDescription,
        resume_text: resumeText,
        mode,
      };
      const res = await fetch(`${API_BASE}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      const session: CreateSessionResponse = await res.json();
      setSessionId(session.session_id);

      const start: RuntimeMessage = {
        kind: "session.start",
        sessionId: session.session_id,
        liveStreamUrl: `${WS_BASE}${session.live_stream_url}`,
        tabId: target.id,
      };
      const ack = await chrome.runtime.sendMessage(start);
      if (!ack?.ok) {
        const msg = ack?.error ?? "background did not ack";
        if (/has not been invoked|activeTab/i.test(String(msg))) {
          setHint(
            "Click the extension's toolbar icon again on the meeting tab. " +
              "That re-grants Chrome's activeTab permission for that tab.",
          );
        }
        throw new Error(msg);
      }

      await chrome.tabs.create({
        url: `${WEB_BASE}/interview/live?sessionId=${session.session_id}`,
      });
      setStatus("live");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  const openMicPermission = () => {
    // Open a real extension tab to grant mic permission for the extension
    // origin - the side panel itself can't surface the prompt or the
    // address-bar mic control needed to un-block a denied permission.
    void chrome.tabs.create({ url: chrome.runtime.getURL("src/permission/permission.html") });
  };

  const stopSession = async () => {
    try {
      await chrome.runtime.sendMessage({ kind: "session.stop" } satisfies RuntimeMessage);
    } finally {
      setStatus("stopped");
    }
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, height: "100%" }}>
      <header>
        <h1 style={{ fontSize: 18, margin: 0 }}>AI Interview Co-Pilot</h1>
        <p style={{ margin: "4px 0 0", color: "#94a3b8", fontSize: 12 }}>
          Status: <strong>{status}</strong>
          {sessionId && <span> · session {sessionId.slice(0, 8)}…</span>}
        </p>
      </header>

      <TargetTabCard target={target} classification={classification} />

      <div style={labelStyle}>
        Mode
        <div style={{ display: "flex", gap: 6 }}>
          <ModeButton
            active={mode === "interviewer"}
            disabled={status === "live" || status === "starting"}
            onClick={() => setMode("interviewer")}
            label="Interviewer"
            hint="Get rubrics to evaluate the candidate"
          />
          <ModeButton
            active={mode === "interviewee"}
            disabled={status === "live" || status === "starting"}
            onClick={() => setMode("interviewee")}
            label="Interviewee"
            hint="Get the exact answer to say"
          />
        </div>
      </div>

      {(status === "live" || status === "starting") && (
        <>
          <AudioMeter level={level} micGranted={micGranted} />
          {micGranted === false && micError && (
            <div
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                background: "rgba(250,204,21,0.10)",
                color: "#fde68a",
                fontSize: 11,
                lineHeight: 1.45,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <span>
                <strong>Your mic isn&apos;t being captured.</strong> {micError}
              </span>
              <button
                type="button"
                onClick={openMicPermission}
                style={{
                  alignSelf: "flex-start",
                  height: 30,
                  padding: "0 12px",
                  border: "1px solid #ca8a04",
                  borderRadius: 6,
                  background: "rgba(250,204,21,0.15)",
                  color: "#fde68a",
                  fontWeight: 600,
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                Enable microphone →
              </button>
            </div>
          )}
        </>
      )}

      <label style={labelStyle}>
        Candidate name (optional)
        <input
          style={inputStyle}
          value={candidateName}
          onChange={(event) => setCandidateName(event.target.value)}
          placeholder="Jane Doe"
        />
      </label>

      <DropTextarea
        label="Job description"
        value={jobDescription}
        onChange={setJobDescription}
        placeholder="Paste the JD…"
        minHeight={90}
        disabled={status === "live" || status === "starting"}
      />

      <DropTextarea
        label="Candidate resume text"
        value={resumeText}
        onChange={setResumeText}
        placeholder="Paste the resume contents…"
        minHeight={120}
        disabled={status === "live" || status === "starting"}
      />

      {error && (
        <div
          style={{
            padding: "8px 10px",
            borderRadius: 6,
            background: "rgba(248,113,113,0.12)",
            color: "#fca5a5",
            fontSize: 12,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <strong>Error</strong>
          <span style={{ opacity: 0.95 }}>{error}</span>
          {hint && <span style={{ color: "#fde68a", marginTop: 4 }}>▸ {hint}</span>}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
        <button onClick={startSession} disabled={!canStart} style={primaryButtonStyle}>
          {status === "starting" ? "Starting…" : "Start interview"}
        </button>
        <button onClick={stopSession} disabled={status !== "live"} style={secondaryButtonStyle}>
          Stop
        </button>
      </div>
    </div>
  );
}

/**
 * A textarea that doubles as a drag-and-drop / click-to-upload zone. Dropping a
 * PDF/DOCX/TXT posts it to the API for text extraction and fills the field with
 * the result. Typing/pasting still works exactly as before.
 */
function DropTextarea({
  label,
  value,
  onChange,
  placeholder,
  minHeight,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  minHeight: number;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  const ingest = async (file: File | undefined) => {
    if (!file || disabled) return;
    setDocError(null);
    setParsing(true);
    try {
      const text = await extractDocumentText(file);
      onChange(text);
      setFileName(file.name);
    } catch (err) {
      setDocError(err instanceof Error ? err.message : String(err));
      setFileName(null);
    } finally {
      setParsing(false);
    }
  };

  const onDrop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    setDragOver(false);
    void ingest(event.dataTransfer.files?.[0]);
  };

  return (
    <div style={labelStyle}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <span>{label}</span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || parsing}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            color: disabled ? "#475569" : "#60a5fa",
            fontSize: 11,
            cursor: disabled || parsing ? "default" : "pointer",
          }}
        >
          {parsing ? "Reading…" : "Upload file"}
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_DOC_ATTR}
        style={{ display: "none" }}
        onChange={(event) => {
          void ingest(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      <textarea
        style={{
          ...inputStyle,
          minHeight,
          resize: "vertical",
          border: dragOver ? "1px solid #3b82f6" : inputStyle.border,
          outline: dragOver ? "2px dashed #3b82f6" : "none",
          outlineOffset: dragOver ? -2 : 0,
          opacity: parsing ? 0.6 : 1,
        }}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={parsing ? "Reading file…" : `${placeholder} or drop a PDF/DOCX/TXT here`}
        disabled={disabled || parsing}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      />

      {fileName && !docError && (
        <span style={{ fontSize: 10, color: "#34d399" }}>Loaded from {fileName}</span>
      )}
      {docError && <span style={{ fontSize: 10, color: "#fca5a5" }}>{docError}</span>}
    </div>
  );
}

function TargetTabCard({
  target,
  classification,
}: {
  target: TargetTab | null;
  classification: { capturable: boolean; reason?: string };
}) {
  const okBorder = "1px solid #14532d";
  const warnBorder = "1px solid #7c2d12";
  const okBg = "rgba(16,185,129,0.07)";
  const warnBg = "rgba(248,113,113,0.07)";

  if (!target) {
    return (
      <div
        style={{
          padding: 10,
          borderRadius: 8,
          border: warnBorder,
          background: warnBg,
          fontSize: 12,
          color: "#fda4af",
        }}
      >
        No tab selected for capture. Click the AI Interview Co-Pilot icon on the meeting tab.
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        padding: 10,
        borderRadius: 8,
        background: classification.capturable ? okBg : warnBg,
        border: classification.capturable ? okBorder : warnBorder,
      }}
    >
      {target.favIconUrl ? (
        <img
          src={target.favIconUrl}
          alt=""
          width={20}
          height={20}
          style={{ borderRadius: 3, flexShrink: 0 }}
        />
      ) : (
        <div
          style={{
            width: 20,
            height: 20,
            borderRadius: 3,
            background: "#334155",
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: "#94a3b8" }}>
          {classification.capturable
            ? "Will capture this tab on Start"
            : "Cannot capture this tab"}
        </div>
        <div
          style={{
            fontSize: 13,
            color: "#e2e8f0",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {target.title || "(no title)"}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "#64748b",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {target.url || "—"}
        </div>
        {!classification.capturable && classification.reason && (
          <div style={{ fontSize: 11, color: "#fda4af", marginTop: 4 }}>
            {classification.reason}
          </div>
        )}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  disabled,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      style={{
        flex: 1,
        padding: "8px 6px",
        borderRadius: 6,
        border: active ? "1px solid #3b82f6" : "1px solid #334155",
        background: active ? "rgba(59,130,246,0.15)" : "transparent",
        color: active ? "#bfdbfe" : "#94a3b8",
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled && !active ? 0.5 : 1,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        alignItems: "flex-start",
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.8 }}>{hint}</span>
    </button>
  );
}

function AudioMeter({ level, micGranted }: { level: number; micGranted: boolean | null }) {
  // RMS is typically small; scale and clamp into a 0..1 bar with a sqrt curve
  // so quiet speech is still visible.
  const pct = Math.min(1, Math.sqrt(level) * 3);
  return (
    <div
      style={{
        padding: 10,
        borderRadius: 8,
        border: "1px solid #1e293b",
        background: "rgba(59,130,246,0.06)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#94a3b8" }}>
        <span>Audio level</span>
        <span style={{ color: micGranted === false ? "#fca5a5" : "#34d399" }}>
          {micGranted === false ? "mic off · tab only" : "mic + tab"}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: "#1e293b", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: `${Math.round(pct * 100)}%`,
            background: pct > 0.02 ? "#34d399" : "#475569",
            transition: "width 120ms linear",
          }}
        />
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "#cbd5f5",
};

const inputStyle: React.CSSProperties = {
  background: "#1e293b",
  border: "1px solid #334155",
  borderRadius: 6,
  color: "#e2e8f0",
  padding: "6px 8px",
  fontSize: 13,
};

const primaryButtonStyle: React.CSSProperties = {
  flex: 1,
  height: 36,
  border: "none",
  borderRadius: 6,
  background: "#3b82f6",
  color: "white",
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  flex: 1,
  height: 36,
  border: "1px solid #334155",
  borderRadius: 6,
  background: "transparent",
  color: "#e2e8f0",
  cursor: "pointer",
};
