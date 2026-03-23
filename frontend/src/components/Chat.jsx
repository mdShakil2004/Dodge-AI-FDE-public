import { useState, useRef, useEffect } from "react";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000"

const T = {
  bg:         "#0a0c10",
  surface:    "#111318",
  surfaceHi:  "#181c24",
  border:     "#1e2330",
  text:       "#e2e6f0",
  muted:      "#6b7590",
  accent:     "#3b6fff",
  accentGlow: "rgba(59,111,255,0.18)",
  success:    "#22c97a",
  warning:    "#f59e0b",
  danger:     "#ef4444",
  fontMono:   "'JetBrains Mono', 'Fira Code', monospace",
  fontDisplay:"'Outfit', 'DM Sans', sans-serif",
};

const SUGGESTIONS = [
  "Show all customers and their sales orders",
  "Total revenue from non-cancelled invoices",
  "Which customers have unpaid billing documents?",
  "List all products with their order counts",
  "Top 10 highest-value sales orders",
];

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0" }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          width: 6, height: 6, borderRadius: "50%",
          background: T.accent,
          animation: "chat-bounce 1.2s ease-in-out infinite",
          animationDelay: `${i * 0.2}s`,
        }} />
      ))}
    </div>
  );
}

// ─── Cypher code block ────────────────────────────────────────────────────────

function CypherBlock({ query }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(query).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={{
      background: T.bg, border: `1px solid ${T.border}`,
      borderRadius: 8, marginTop: 8, overflow: "hidden",
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "6px 12px", borderBottom: `1px solid ${T.border}`,
        background: T.surfaceHi,
      }}>
        <span style={{ fontSize: 10, color: T.muted, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Cypher
        </span>
        <button onClick={copy} style={{
          background: "none", border: `1px solid ${T.border}`,
          color: T.muted, borderRadius: 4, padding: "2px 8px",
          fontSize: 10, cursor: "pointer", fontFamily: T.fontDisplay,
          /* Minimum 44px tap target height on mobile handled by parent padding */
        }}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre style={{
        margin: 0, padding: "10px 12px",
        fontSize: 11, fontFamily: T.fontMono, color: "#a5b4fc",
        overflowX: "auto", lineHeight: 1.6, whiteSpace: "pre-wrap",
      }}>
        {query}
      </pre>
    </div>
  );
}

// ─── Chat bubble ──────────────────────────────────────────────────────────────

function ChatBubble({ msg }) {
  const [showCypher, setShowCypher] = useState(false);

  if (msg.role === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <div style={{
          background: T.accent, color: "#fff",
          padding: "10px 14px",
          borderRadius: "14px 14px 4px 14px",
          maxWidth: "85%",
          fontSize: 13, lineHeight: 1.6,
          fontFamily: T.fontDisplay,
          boxShadow: `0 2px 12px ${T.accentGlow}`,
          wordBreak: "break-word",
        }}>
          {msg.content}
        </div>
      </div>
    );
  }

  if (msg.type === "error") {
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{
          background: "#1a0f0f",
          border: `1px solid ${T.danger}44`,
          borderLeft: `3px solid ${T.danger}`,
          padding: "10px 14px",
          borderRadius: "4px 14px 14px 14px",
          maxWidth: "90%",
        }}>
          <div style={{ fontSize: 10, color: T.danger, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>
            Error
          </div>
          <div style={{ fontSize: 12, color: "#fca5a5", lineHeight: 1.6, fontFamily: T.fontDisplay, wordBreak: "break-word" }}>
            {msg.content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        background: T.surfaceHi, border: `1px solid ${T.border}`,
        padding: "12px 14px",
        borderRadius: "4px 14px 14px 14px",
        maxWidth: "95%",
      }}>
        {msg.explanation && (
          <div style={{ fontSize: 13, color: T.text, lineHeight: 1.7, marginBottom: 8, fontFamily: T.fontDisplay }}>
            {msg.explanation}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{
            fontSize: 11, color: T.success,
            background: "rgba(34,201,122,0.1)", border: "1px solid rgba(34,201,122,0.25)",
            borderRadius: 20, padding: "3px 10px", fontWeight: 700, fontFamily: T.fontDisplay,
          }}>
            {msg.recordCount} record{msg.recordCount !== 1 ? "s" : ""}
          </div>

          {msg.truncated && (
            <div style={{
              fontSize: 11, color: T.warning,
              background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.25)",
              borderRadius: 20, padding: "3px 10px", fontWeight: 700, fontFamily: T.fontDisplay,
            }}>
              truncated
            </div>
          )}

          {msg.elapsed_ms != null && (
            <div style={{ fontSize: 10, color: T.muted, marginLeft: "auto", fontFamily: T.fontMono }}>
              {msg.elapsed_ms}ms
            </div>
          )}
        </div>

        {msg.cypherQuery && (
          <>
            <button onClick={() => setShowCypher((s) => !s)} style={{
              marginTop: 8, background: "none", border: "none",
              color: T.muted, cursor: "pointer", fontSize: 11, padding: 0,
              display: "flex", alignItems: "center", gap: 4,
              fontFamily: T.fontDisplay,
            }}>
              <span style={{ fontSize: 9 }}>{showCypher ? "▾" : "▸"}</span>
              {showCypher ? "Hide" : "Show"} query
            </button>
            {showCypher && <CypherBlock query={msg.cypherQuery} />}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Auto-grow textarea helper ────────────────────────────────────────────────
// On mobile, single-row textareas are too easy to accidentally submit.
// We let the textarea grow up to 4 rows as the user types.

function useAutoGrow(ref, value) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`; // max ~4 rows
  }, [value, ref]);
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export default function Chat({ onResult, onStats }) {
  const [input, setInput]       = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading]   = useState(false);
  const endRef   = useRef(null);
  const inputRef = useRef(null);

  useAutoGrow(inputRef, input);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(question) {
    const q = question.trim();
    if (!q || loading) return;

    setMessages((prev) => [...prev, { role: "user", content: q, id: Date.now() }]);
    setInput("");
    setLoading(true);

    try {
      const res  = await fetch(`${API_URL}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setMessages((prev) => [...prev, {
          role: "assistant", type: "error",
          content: data.error || `Server error (${res.status})`,
          id: Date.now() + 1,
        }]);
      } else {
        const count = data.count || data.data?.length || 0;
        setMessages((prev) => [...prev, {
          role: "assistant", type: "success",
          explanation: data.explanation || "",
          cypherQuery: data.query,
          recordCount: count,
          truncated:   data.truncated || false,
          elapsed_ms:  data.elapsed_ms,
          id: Date.now() + 1,
        }]);
        if (onResult && data.data) onResult(data);
        if (onStats)              onStats({ count, elapsed_ms: data.elapsed_ms });
      }
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: "assistant", type: "error",
        content: err.message === "Failed to fetch"
          ? "Cannot connect to server. due to low internet?"
          : err.message,
        id: Date.now() + 1,
      }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function handleKey(e) {
    // On mobile (software keyboard), Enter should NOT submit — user needs Shift+Enter or the button
    // On desktop, Enter submits; Shift+Enter = newline
    const isMobile = window.innerWidth < 640;
    if (e.key === "Enter" && !e.shiftKey && !isMobile) {
      e.preventDefault();
      send(input);
    }
  }

  const isEmpty = messages.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", fontFamily: T.fontDisplay }}>

      {/* Messages */}
      <div style={{
        flex: 1, overflowY: "auto",
        padding: "16px 16px 8px",
        scrollbarWidth: "thin",
        scrollbarColor: `${T.border} transparent`,
        WebkitOverflowScrolling: "touch", // smooth momentum scroll on iOS
      }}>
        {isEmpty && (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 20 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.15 }}>⬡</div>
              <p style={{ color: T.text, fontSize: 14, fontWeight: 600, margin: "0 0 4px" }}>SAP O2C Intelligence</p>
              <p style={{ color: T.muted, fontSize: 12, margin: 0 }}>Ask anything about your data</p>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {SUGGESTIONS.map((s, i) => (
                <button key={i} onClick={() => send(s)} style={{
                  background: T.surfaceHi, border: `1px solid ${T.border}`,
                  borderRadius: 8,
                  /* Min 44px height for touch targets */
                  padding: "11px 13px",
                  textAlign: "left",
                  color: T.muted, fontSize: 13, cursor: "pointer",
                  fontFamily: T.fontDisplay, lineHeight: 1.4,
                  transition: "all 0.15s",
                }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.accent + "88"; e.currentTarget.style.color = T.text; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.muted; }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => <ChatBubble key={msg.id} msg={msg} />)}

        {loading && (
          <div style={{ marginBottom: 12 }}>
            <div style={{
              background: T.surfaceHi, border: `1px solid ${T.border}`,
              padding: "12px 14px", borderRadius: "4px 14px 14px 14px",
              display: "inline-block",
            }}>
              <TypingIndicator />
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Input bar — safe-area padding for iPhone home bar */}
      <div style={{
        padding: "8px 10px",
        paddingBottom: "max(10px, env(safe-area-inset-bottom, 10px))",
        borderTop: `1px solid ${T.border}`,
        display: "flex", gap: 8, alignItems: "flex-end",
        background: T.surface,
      }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder={loading ? "Processing…" : "Ask about orders, payments, customers…"}
          disabled={loading}
          rows={1}
          style={{
            flex: 1,
            background: T.surfaceHi,
            border: `1px solid ${T.border}`,
            borderRadius: 10,
            padding: "10px 14px",
            color: T.text, fontSize: 14,
            fontFamily: T.fontDisplay,
            resize: "none", outline: "none",
            lineHeight: 1.5,
            minHeight: 44,    // touch target
            maxHeight: 120,   // ~4 rows
            overflowY: "auto",
            transition: "border-color 0.15s",
          }}
          onFocus={(e) => { e.target.style.borderColor = T.accent + "88"; }}
          onBlur={(e)  => { e.target.style.borderColor = T.border; }}
        />
        <button
          onClick={() => send(input)}
          disabled={loading || !input.trim()}
          style={{
            background:   loading || !input.trim() ? T.surfaceHi : T.accent,
            border:       `1px solid ${loading || !input.trim() ? T.border : T.accent}`,
            borderRadius: 10,
            /* 44×44 minimum touch target */
            width: 44, height: 44,
            cursor:  loading || !input.trim() ? "default" : "pointer",
            color:   loading || !input.trim() ? T.muted : "#fff",
            fontSize: 18,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0, transition: "all 0.15s",
            boxShadow: !loading && input.trim() ? `0 0 12px ${T.accentGlow}` : "none",
          }}
        >
          {loading ? (
            <div style={{
              width: 16, height: 16,
              border: `2px solid ${T.muted}`,
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }} />
          ) : "↑"}
        </button>
      </div>
    </div>
  );
}