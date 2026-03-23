import { useState, useEffect, useCallback, memo } from "react";
import ReactFlow, {
  Controls,
  MiniMap,
  Background,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  getSmoothStepPath,
} from "reactflow";
import "reactflow/dist/style.css";
import { NODE_PALETTE } from "../utils/graph-utils";

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  bg:         "#0a0c10",
  surface:    "#111318",
  surfaceHi:  "#181c24",
  border:     "#1e2330",
  borderHi:   "#2a3148",
  text:       "#e2e6f0",
  muted:      "#6b7590",
  accent:     "#3b6fff",
  success:    "#22c97a",
  warning:    "#f59e0b",
  danger:     "#ef4444",
  fontMono:   "'JetBrains Mono', 'Fira Code', monospace",
  fontDisplay:"'Outfit', 'DM Sans', sans-serif",
};

// ─── Custom Node ──────────────────────────────────────────────────────────────
// memo() prevents re-renders when parent re-renders but node data hasn't changed.
// isMobileWidth() is called at render time — no hook needed here since CustomNode
// doesn't need to react to window resize (the parent Graph does).

const CustomNode = memo(({ data, selected }) => {
  const pal      = NODE_PALETTE[data.nodeLabel] || NODE_PALETTE.Default;
  const topVal   = data.id       || "";
  const subtitle = data.subtitle || "";
  const mobile   = window.innerWidth < 640;

  return (
    <div style={{
      background:   pal.fill,
      border:       `1.5px solid ${selected ? pal.stroke : pal.stroke + "88"}`,
      borderRadius: 12,
      padding:      mobile ? "8px 11px" : "10px 14px",
      minWidth:     mobile ? 150 : 200,
      maxWidth:     mobile ? 200 : 260,
      boxShadow:    selected
        ? `0 0 0 2px ${pal.stroke}, 0 0 24px ${pal.glow}, 0 4px 24px rgba(0,0,0,0.5)`
        : `0 0 12px ${data.highlighted ? pal.glow : "transparent"}, 0 2px 12px rgba(0,0,0,0.4)`,
      transition:   "box-shadow 0.2s ease, border-color 0.2s ease",
      cursor:       "pointer",
      fontFamily:   T.fontDisplay,
      opacity:      data.highlighted === false ? 0.4 : 1,
    }}>
      <Handle type="target" position={Position.Top}    style={{ opacity: 0, pointerEvents: "none" }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: "none" }} />

      {/* Type badge row */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
        <span style={{ color: pal.stroke, fontSize: mobile ? 12 : 14, lineHeight: 1 }}>{pal.icon}</span>
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: "0.08em",
          color: pal.text, textTransform: "uppercase", opacity: 0.85,
        }}>
          {data.nodeLabel}
        </span>
        {data.highlighted && (
          <span style={{
            marginLeft: "auto", width: 5, height: 5, borderRadius: "50%",
            background: pal.stroke, boxShadow: `0 0 5px ${pal.stroke}`, flexShrink: 0,
          }} />
        )}
      </div>

      {/* Primary value */}
      <div style={{
        fontSize:     mobile ? 11 : 12,
        fontWeight:   600,
        color:        T.text,
        fontFamily:   T.fontMono,
        wordBreak:    "break-all",
        lineHeight:   1.4,
        marginBottom: subtitle ? 3 : 0,
      }}>
        {topVal}
      </div>

      {/* Subtitle — omitted on mobile to keep cards compact */}
      {subtitle && !mobile && (
        <div style={{
          fontSize: 11, color: T.muted, lineHeight: 1.4,
          borderTop: `1px solid ${pal.stroke}22`, paddingTop: 4, marginTop: 4,
        }}>
          {subtitle}
        </div>
      )}
    </div>
  );
});
CustomNode.displayName = "CustomNode";

// ─── Custom Edge ──────────────────────────────────────────────────────────────

function CustomEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data, animated,
}) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 8,
  });

  const stroke   = data?.stroke || "#2a3148";
  const isActive = data?.highlighted;
  const mobile   = window.innerWidth < 640;

  return (
    <>
      <defs>
        <marker
          id={`arr-${id}`}
          markerWidth="10" markerHeight="10"
          refX="8" refY="3"
          orient="auto" markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L8,3 z" fill={stroke} />
        </marker>
      </defs>

      <path
        id={id} d={edgePath} fill="none"
        stroke={stroke}
        strokeWidth={isActive ? 2 : 1}
        strokeDasharray={isActive && animated ? "6 3" : "none"}
        markerEnd={`url(#arr-${id})`}
        style={{
          opacity:    isActive ? 1 : 0.3,
          filter:     isActive ? `drop-shadow(0 0 4px ${stroke}66)` : "none",
          transition: "opacity 0.3s ease",
        }}
      />

      {/* Relationship label — active edges, desktop only */}
      {data?.label && isActive && !mobile && (
        <>
          <rect
            x={labelX - 36} y={labelY - 10} width={72} height={20} rx={4}
            fill={T.surface} stroke={stroke + "55"} strokeWidth={1}
          />
          <text
            x={labelX} y={labelY + 4}
            textAnchor="middle"
            style={{
              fontSize: 9, fill: stroke,
              fontFamily: T.fontDisplay, fontWeight: 700, letterSpacing: "0.05em",
            }}
          >
            {data.label}
          </text>
        </>
      )}
    </>
  );
}

// ─── Register ONCE at module scope ────────────────────────────────────────────
// Critical: if these objects are created inside a component function,
// React Flow detects a new reference every render and remounts all nodes.
// Defining them here means the reference is stable for the lifetime of the module.

const NODE_TYPES = { custom: CustomNode };
const EDGE_TYPES = { custom: CustomEdge };

// ─── Node Detail Panel ────────────────────────────────────────────────────────
// Desktop: right-side drawer (280px)
// Mobile:  bottom sheet (max 60% height, rounded top corners)

function DetailPanel({ node, onClose, isMobile }) {
  if (!node) return null;
  const { nodeLabel, properties } = node.data;
  const pal     = NODE_PALETTE[nodeLabel] || NODE_PALETTE.Default;
  const entries = Object.entries(properties || {}).filter(([, v]) => v != null);

  const panelStyle = isMobile
    ? {
        position: "absolute", left: 0, right: 0, bottom: 0,
        maxHeight: "60%",
        background: T.surface,
        borderTop: `1px solid ${T.border}`,
        borderRadius: "16px 16px 0 0",
        display: "flex", flexDirection: "column",
        fontFamily: T.fontDisplay,
        zIndex: 30,
        boxShadow: "0 -8px 32px rgba(0,0,0,0.6)",
      }
    : {
        position: "absolute", right: 0, top: 0, bottom: 0, width: 280,
        background: T.surface,
        borderLeft: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column",
        fontFamily: T.fontDisplay,
        zIndex: 20,
        boxShadow: "-8px 0 32px rgba(0,0,0,0.4)",
      };

  return (
    <div style={panelStyle}>
      {/* Drag handle pill — mobile only */}
      {isMobile && (
        <div style={{ display: "flex", justifyContent: "center", padding: "10px 0 6px" }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, background: T.border }} />
        </div>
      )}

      {/* Header */}
      <div style={{
        padding: "14px 18px",
        borderBottom: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 26, height: 26, borderRadius: 6,
            background: pal.fill, border: `1.5px solid ${pal.stroke}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, color: pal.stroke,
          }}>
            {pal.icon}
          </div>
          <div>
            <div style={{ fontSize: 9, color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 700 }}>
              Node type
            </div>
            <div style={{ fontSize: 13, color: pal.text, fontWeight: 700 }}>{nodeLabel}</div>
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none", border: "none", color: T.muted,
            cursor: "pointer", fontSize: 16, borderRadius: 4,
            minWidth: 44, minHeight: 44,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          ✕
        </button>
      </div>

      {/* Property list */}
      <div style={{ flex: 1, overflow: "auto", padding: "8px 0" }}>
        {entries.map(([key, val]) => {
          const display = typeof val === "object" ? JSON.stringify(val) : String(val);
          const isNum   = !isNaN(Number(val)) && val !== "" && val !== null;
          const isBool  = typeof val === "boolean";
          return (
            <div key={key} style={{ padding: "8px 18px", borderBottom: `1px solid ${T.border}22` }}>
              <div style={{
                fontSize: 9, color: T.muted, fontWeight: 600,
                letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 3,
              }}>
                {key}
              </div>
              <div style={{
                fontSize: 12, fontFamily: T.fontMono, lineHeight: 1.5,
                color:    isBool ? (val ? T.success : T.danger) : isNum ? T.success : T.text,
                wordBreak: "break-all",
              }}>
                {isBool ? (val ? "true" : "false") : (display || "—")}
              </div>
            </div>
          );
        })}
        {entries.length === 0 && (
          <div style={{ padding: "24px 18px", color: T.muted, fontSize: 13 }}>No properties</div>
        )}
      </div>
    </div>
  );
}

// ─── Data Table ───────────────────────────────────────────────────────────────

export function DataTable({ records }) {
  if (!records || records.length === 0) {
    return (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        height: "100%", color: T.muted, fontFamily: T.fontDisplay, fontSize: 13,
      }}>
        No records to display
      </div>
    );
  }

  const cols = Object.keys(records[0]);
  const CELL = {
    padding: "10px 14px", fontSize: 12,
    borderBottom: `1px solid ${T.border}`,
    fontFamily: T.fontMono,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    maxWidth: 240,
  };

  return (
    <div style={{ overflowX: "auto", overflowY: "auto", height: "100%", WebkitOverflowScrolling: "touch" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: T.surfaceHi, position: "sticky", top: 0, zIndex: 2 }}>
            {cols.map((c) => (
              <th key={c} style={{
                ...CELL,
                color: T.accent, fontWeight: 700, textAlign: "left",
                letterSpacing: "0.04em", textTransform: "uppercase", fontSize: 10,
                borderBottom: `1px solid ${T.borderHi}`,
              }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((row, i) => (
            <tr
              key={i}
              style={{ background: i % 2 === 0 ? T.surface : T.surfaceHi + "88" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(59,111,255,0.07)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = i % 2 === 0 ? T.surface : T.surfaceHi + "88"; }}
            >
              {cols.map((c) => {
                const v       = row[c];
                const display = v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
                const isNum   = v !== null && v !== "" && !isNaN(Number(v));
                return (
                  <td key={c} style={{ ...CELL, color: isNum ? T.success : T.text }}>{display}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Graph component ──────────────────────────────────────────────────────────

export default function Graph({ nodes: inputNodes, edges: inputEdges, onInit }) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode]  = useState(null);
  const [mobile, setMobile]              = useState(() => window.innerWidth < 640);

  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < 640);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);

  useEffect(() => {
    setNodes(inputNodes || []);
    setEdges(inputEdges || []);
    setSelectedNode(null);
  }, [inputNodes, inputEdges]);

  const onNodeClick = useCallback((_, node) => setSelectedNode(node), []);
  const onPaneClick = useCallback(() => setSelectedNode(null),         []);

  const isEmpty = !inputNodes || inputNodes.length === 0;

  return (
    <div style={{
      width: "100%", height: "100%",
      position: "relative", overflow: "hidden",
      background: T.bg,
    }}>
      {/* Empty state */}
      {isEmpty && (
        <div style={{
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center",
          height: "100%", gap: 12,
          fontFamily: T.fontDisplay, padding: 20, textAlign: "center",
        }}>
          <div style={{ fontSize: 40, opacity: 0.10 }}>⬡</div>
          <p style={{ color: T.muted, fontSize: 14, margin: 0 }}>Graph will render here</p>
          <p style={{ color: T.muted, fontSize: 12, margin: 0, opacity: 0.6 }}>
            {mobile ? "Tap Chat to ask a question" : "Ask a question to explore relationships"}
          </p>
        </div>
      )}

      {/*
        React Flow is ALWAYS rendered (not conditionally mounted) so its
        ResizeObserver always reads real dimensions and never warns about 0×0.
        When empty we hide it visually with visibility:hidden + pointerEvents:none.
        This also preserves pan/zoom state across query results.
      */}
      <div style={{
        position: "absolute", inset: 0,
        visibility: isEmpty ? "hidden" : "visible",
        pointerEvents: isEmpty ? "none" : "auto",
      }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onInit={onInit}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          minZoom={0.06}
          maxZoom={2.5}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          attributionPosition="bottom-left"
          panOnDrag
          zoomOnPinch
          zoomOnScroll={!mobile}
        >
          {!mobile && (
            <Controls
              position="top-right"
              style={{ background: T.surfaceHi, border: `1px solid ${T.border}`, borderRadius: 8 }}
            />
          )}
          {!mobile && (
            <MiniMap
              nodeColor={(n) => (NODE_PALETTE[n.data?.nodeLabel] || NODE_PALETTE.Default).stroke}
              maskColor="rgba(10,12,16,0.7)"
              style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8 }}
              position="bottom-right"
            />
          )}
          <Background color={T.border} gap={28} size={1} variant="dots" />
        </ReactFlow>

        {/* Node detail panel */}
        {selectedNode && (
          <DetailPanel
            node={selectedNode}
            onClose={() => setSelectedNode(null)}
            isMobile={mobile}
          />
        )}

        {/* Node type legend */}
        <div style={{
          position: "absolute", bottom: 12, left: 12,
          display: "flex",
          flexWrap:   mobile ? "nowrap" : "wrap",
          gap: 5,
          maxWidth:   mobile ? "calc(100% - 24px)" : 360,
          overflowX:  mobile ? "auto" : "visible",
          zIndex: 10,
          pointerEvents: "none",
          WebkitOverflowScrolling: "touch",
        }}>
          {Object.entries(NODE_PALETTE)
            .filter(([k]) => k !== "Default")
            .map(([label, pal]) => (
              <div key={label} style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "3px 8px", borderRadius: 20,
                background: pal.fill, border: `1px solid ${pal.stroke}55`,
                fontSize: mobile ? 9 : 10, color: pal.text,
                fontFamily: T.fontDisplay, fontWeight: 600,
                flexShrink: 0, whiteSpace: "nowrap",
              }}>
                <span style={{
                  width: 5, height: 5, borderRadius: "50%",
                  background: pal.stroke, boxShadow: `0 0 4px ${pal.stroke}`,
                }} />
                {label}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}