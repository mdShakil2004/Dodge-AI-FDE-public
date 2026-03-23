import { useState, useEffect } from "react";
import Graph, { DataTable } from "../components/Graph";
import Chat from "../components/Chat";
import { mergeGraphData } from "../utils/graph-utils";

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  bg:         "#0a0c10",
  surface:    "#111318",
  surfaceHi:  "#181c24",
  border:     "#1e2330",
  text:       "#e2e6f0",
  muted:      "#6b7590",
  accent:     "#3b6fff",
  success:    "#22c97a",
  warning:    "#f59e0b",
  fontMono:   "'JetBrains Mono', 'Fira Code', monospace",
  fontDisplay:"'Outfit', 'DM Sans', sans-serif",
};

// ─── Breakpoint hook ──────────────────────────────────────────────────────────

function getBreakpoint(w) {
  if (w < 640)  return "mobile";
  if (w < 1024) return "tablet";
  return "desktop";
}

function useBreakpoint() {
  const [bp, setBp] = useState(() => getBreakpoint(window.innerWidth));
  useEffect(() => {
    const fn = () => setBp(getBreakpoint(window.innerWidth));
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return bp;
}

// ─── StatPill ─────────────────────────────────────────────────────────────────

function StatPill({ label, value, accent, compact }) {
  return (
    <div style={{
      display:      "flex",
      flexDirection: compact ? "row" : "column",
      alignItems:   compact ? "center" : "flex-start",
      gap:          compact ? 5 : 2,
      padding:      compact ? "4px 9px" : "7px 14px",
      borderRadius: 8,
      background:   T.surfaceHi,
      border:       `1px solid ${T.border}`,
      minWidth:     compact ? 0 : 72,
      flexShrink:   0,
    }}>
      <span style={{
        fontSize: 9, color: T.muted, fontWeight: 700,
        letterSpacing: "0.07em", textTransform: "uppercase", whiteSpace: "nowrap",
      }}>
        {label}
      </span>
      <span style={{
        fontSize:   compact ? 13 : 17,
        fontWeight: 700,
        color:      accent || T.text,
        fontFamily: T.fontDisplay,
        lineHeight: 1,
      }}>
        {value ?? "—"}
      </span>
    </div>
  );
}

// ─── TabBtn ───────────────────────────────────────────────────────────────────

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background:   active ? T.surfaceHi : "none",
      border:       active ? `1px solid ${T.border}` : "1px solid transparent",
      borderRadius: 8,
      padding:      "6px 14px",
      color:        active ? T.text : T.muted,
      cursor:       "pointer",
      fontSize:     12,
      fontFamily:   T.fontDisplay,
      fontWeight:   600,
      transition:   "all 0.15s",
      whiteSpace:   "nowrap",
    }}>
      {children}
    </button>
  );
}

// ─── Mobile bottom nav ────────────────────────────────────────────────────────

function MobileNav({ active, onChange, queryCount, nodeCount }) {
  const TABS = [
    { id: "graph", label: "Graph", icon: "⬡", badge: nodeCount  },
    { id: "table", label: "Table", icon: "⊞", badge: null        },
    { id: "chat",  label: "Chat",  icon: "◈", badge: queryCount  },
  ];

  return (
    <nav style={{
      display:      "flex",
      borderTop:    `1px solid ${T.border}`,
      background:   T.surface,
      flexShrink:   0,
      paddingBottom:"env(safe-area-inset-bottom, 0px)",
    }}>
      {TABS.map(({ id, label, icon, badge }) => {
        const on = active === id;
        return (
          <button key={id} onClick={() => onChange(id)} style={{
            flex:           1,
            display:        "flex",
            flexDirection:  "column",
            alignItems:     "center",
            justifyContent: "center",
            gap:            3,
            padding:        "10px 0 6px",
            background:     "none",
            border:         "none",
            cursor:         "pointer",
            borderTop:      on ? `2px solid ${T.accent}` : "2px solid transparent",
            position:       "relative",
            transition:     "border-color 0.15s",
          }}>
            <span style={{ fontSize: 16, color: on ? T.accent : T.muted, lineHeight: 1 }}>
              {icon}
            </span>
            <span style={{
              fontSize:   10, fontWeight: 600,
              color:      on ? T.text : T.muted,
              fontFamily: T.fontDisplay,
            }}>
              {label}
            </span>
            {badge > 0 && (
              <span style={{
                position:   "absolute", top: 5, right: "calc(50% - 18px)",
                minWidth:   14, height: 14, borderRadius: 7,
                background: T.accent, color: "#fff",
                fontSize: 8, fontWeight: 700,
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: "0 3px", fontFamily: T.fontDisplay,
              }}>
                {badge > 99 ? "99+" : badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ─── Shared header ────────────────────────────────────────────────────────────

function Header({ isMobile, totalNodes, totalEdges, queryCount, lastStats }) {
  return (
    <div style={{
      display:      "flex",
      alignItems:   "center",
      gap:          isMobile ? 8 : 14,
      padding:      isMobile ? "8px 12px" : "10px 20px",
      borderBottom: `1px solid ${T.border}`,
      background:   T.surface,
      flexShrink:   0,
      overflow:     "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 7,
          background: "linear-gradient(135deg,#1a2f5e,#0f1829)",
          border: `1px solid ${T.accent}44`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 13, color: T.accent,
        }}>⬡</div>
        {!isMobile && (
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text, lineHeight: 1 }}>GraphO2C</div>
            <div style={{ fontSize: 10, color: T.muted, lineHeight: 1, marginTop: 2 }}>SAP Intelligence</div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: isMobile ? 4 : 8, overflow: "hidden" }}>
        <StatPill label="Nodes"   value={totalNodes}              accent={T.accent}  compact={isMobile} />
        <StatPill label="Edges"   value={totalEdges}              accent={T.success} compact={isMobile} />
        {!isMobile && <StatPill label="Queries" value={queryCount}              accent={T.warning} />}
        {!isMobile && <StatPill label="Records" value={lastStats?.count ?? "—"} accent={T.text}   />}
      </div>

      <div style={{
        marginLeft: "auto",
        display: "flex", alignItems: "center", gap: 5,
        fontSize: isMobile ? 10 : 11, color: T.muted,
        fontFamily: T.fontDisplay, flexShrink: 0,
      }}>
        <div style={{
          width: 6, height: 6, borderRadius: "50%",
          background: T.success, boxShadow: `0 0 5px ${T.success}`,
        }} />
        {!isMobile && "Connected"}
        {!isMobile && lastStats?.elapsed_ms != null && (
          <span style={{ marginLeft: 4, fontFamily: T.fontMono, fontSize: 10 }}>
            {lastStats.elapsed_ms}ms
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Chat header row ──────────────────────────────────────────────────────────

function ChatHeader({ elapsed_ms }) {
  return (
    <div style={{
      padding: "10px 14px",
      borderBottom: `1px solid ${T.border}`,
      display: "flex", alignItems: "center", gap: 8,
      flexShrink: 0,
    }}>
      <div style={{
        width: 7, height: 7, borderRadius: "50%",
        background: T.accent, boxShadow: `0 0 5px ${T.accent}`,
      }} />
      <span style={{ fontSize: 12, fontWeight: 700, color: T.text, letterSpacing: "0.04em" }}>
        Query Assistant
      </span>
      {elapsed_ms != null && (
        <span style={{ marginLeft: "auto", fontSize: 10, color: T.muted, fontFamily: T.fontMono }}>
          {elapsed_ms}ms
        </span>
      )}
    </div>
  );
}

// ─── GraphTableArea ───────────────────────────────────────────────────────────
// Defined OUTSIDE Page() so React sees a stable component reference.
// If defined inside Page(), React treats it as a new type on every render,
// unmounts and remounts the entire subtree (including React Flow), and
// triggers the "nodeTypes created inside component" warning on every render.
//
// Uses visibility:hidden instead of display:none so React Flow's ResizeObserver
// always reads real pixel dimensions and never fires the "0×0 container" warning.

function GraphTableArea({
  graphNodes, graphEdges, records,
  activeTab, onTabChange,
  onInit, tabBarPadding,
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Tab bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: tabBarPadding || "8px 14px",
        borderBottom: `1px solid ${T.border}`,
        background: T.surface, flexShrink: 0,
      }}>
        <TabBtn active={activeTab === "graph"} onClick={() => onTabChange("graph")}>
          Graph View
        </TabBtn>
        <TabBtn active={activeTab === "table"} onClick={() => onTabChange("table")}>
          Table {records.length > 0 ? `(${records.length})` : ""}
        </TabBtn>
      </div>

      {/* Content area — both panels always in DOM, toggled with visibility */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>

        {/* Graph — visibility:hidden keeps layout dimensions alive for React Flow */}
        <div style={{
          position:      "absolute", inset: 0,
          visibility:    activeTab === "graph" ? "visible" : "hidden",
          pointerEvents: activeTab === "graph" ? "auto" : "none",
        }}>
          <Graph nodes={graphNodes} edges={graphEdges} onInit={onInit} />
        </div>

        {/* Table */}
        <div style={{
          position:      "absolute", inset: 0,
          visibility:    activeTab === "table" ? "visible" : "hidden",
          pointerEvents: activeTab === "table" ? "auto" : "none",
          background:    T.surface,
        }}>
          <DataTable records={records} />
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Page() {
  const bp = useBreakpoint();

  const [graph, setGraph]             = useState({ nodes: [], edges: [] });
  const [records, setRecords]         = useState([]);
  const [activeTab, setActiveTab]     = useState("graph");
  const [activePanel, setActivePanel] = useState("graph"); // mobile only
  const [lastStats, setLastStats]     = useState(null);
  const [queryCount, setQueryCount]   = useState(0);
  const [rfInstance, setRfInstance]   = useState(null);

  const isMobile  = bp === "mobile";
  const isTablet  = bp === "tablet";

  function handleResult(data) {
    if (!data?.data) return;
    setRecords(data.data);
    setGraph((prev) => mergeGraphData(prev, data.data));
    setQueryCount((c) => c + 1);
    if (isMobile) setActivePanel("graph");
  }

  function handleStats(s) { setLastStats(s); }

  const totalNodes = graph.nodes.length;
  const totalEdges = graph.edges.length;

  const chatContent = <Chat onResult={handleResult} onStats={handleStats} />;

  // ── MOBILE ────────────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <>
        <GlobalStyles />
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: T.bg }}>
          <Header isMobile totalNodes={totalNodes} totalEdges={totalEdges}
                  queryCount={queryCount} lastStats={lastStats} />

          {/* Panel area — all three panels always mounted, toggled with visibility */}
          <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>

            {/* Graph */}
            <div style={{
              position: "absolute", inset: 0,
              visibility:    activePanel === "graph" ? "visible" : "hidden",
              pointerEvents: activePanel === "graph" ? "auto" : "none",
            }}>
              <Graph nodes={graph.nodes} edges={graph.edges} onInit={setRfInstance} />
            </div>

            {/* Table */}
            <div style={{
              position: "absolute", inset: 0,
              visibility:    activePanel === "table" ? "visible" : "hidden",
              pointerEvents: activePanel === "table" ? "auto" : "none",
              background: T.surface,
            }}>
              <DataTable records={records} />
            </div>

            {/* Chat */}
            <div style={{
              position: "absolute", inset: 0,
              visibility:    activePanel === "chat" ? "visible" : "hidden",
              pointerEvents: activePanel === "chat" ? "auto" : "none",
              display: "flex", flexDirection: "column",
              background: T.surface,
            }}>
              <ChatHeader elapsed_ms={lastStats?.elapsed_ms} />
              {chatContent}
            </div>
          </div>

          <MobileNav
            active={activePanel}
            onChange={setActivePanel}
            queryCount={queryCount}
            nodeCount={totalNodes}
          />
        </div>
      </>
    );
  }

  // ── TABLET ────────────────────────────────────────────────────────────────
  if (isTablet) {
    return (
      <>
        <GlobalStyles />
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: T.bg }}>
          <Header isMobile={false} totalNodes={totalNodes} totalEdges={totalEdges}
                  queryCount={queryCount} lastStats={lastStats} />

          {/* Top 55% — graph/table switcher */}
          <div style={{ flex: "0 0 55%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <GraphTableArea
              graphNodes={graph.nodes} graphEdges={graph.edges}
              records={records}
              activeTab={activeTab} onTabChange={setActiveTab}
              onInit={setRfInstance}
            />
          </div>

          <div style={{ height: 1, background: T.border, flexShrink: 0 }} />

          {/* Bottom 45% — chat */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: T.surface }}>
            <ChatHeader elapsed_ms={lastStats?.elapsed_ms} />
            {chatContent}
          </div>
        </div>
      </>
    );
  }

  // ── DESKTOP ───────────────────────────────────────────────────────────────
  return (
    <>
      <GlobalStyles />
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: T.bg }}>
        <Header isMobile={false} totalNodes={totalNodes} totalEdges={totalEdges}
                queryCount={queryCount} lastStats={lastStats} />

        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* Left: graph + table */}
          <GraphTableArea
            graphNodes={graph.nodes} graphEdges={graph.edges}
            records={records}
            activeTab={activeTab} onTabChange={setActiveTab}
            onInit={setRfInstance}
            tabBarPadding="10px 16px"
          />

          {/* Right: chat sidebar */}
          <div style={{
            width: 360, flexShrink: 0,
            borderLeft: `1px solid ${T.border}`,
            background: T.surface,
            display: "flex", flexDirection: "column",
            overflow: "hidden",
          }}>
            <ChatHeader elapsed_ms={lastStats?.elapsed_ms} />
            {chatContent}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Global styles ────────────────────────────────────────────────────────────

function GlobalStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700&family=JetBrains+Mono:wght@400;700&display=swap');

      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      html, body, #root {
        height: 100%;
        background: ${T.bg};
        color: ${T.text};
        font-family: ${T.fontDisplay};
        overscroll-behavior: none;
      }

      html              { height: -webkit-fill-available; }
      body              { min-height: 100vh; min-height: -webkit-fill-available; }
      #root             { height: 100dvh; }
      .app-root         { height: 100%; }

      ::-webkit-scrollbar       { width: 4px; height: 4px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 2px; }

      button { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }

      .react-flow__attribution { display: none !important; }

      @keyframes spin        { to { transform: rotate(360deg); } }
      @keyframes chat-bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }
    `}</style>
  );
}