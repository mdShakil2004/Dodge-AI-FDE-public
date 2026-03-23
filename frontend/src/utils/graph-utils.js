/**
 * graph-utils.js
 * Converts Neo4j query results → React Flow nodes + edges.
 * Supports all 8 node types from the full SAP O2C schema.
 */

// ─── Primary key map ──────────────────────────────────────────────────────────
// All nodes store their business key as `id` after ingest normalization.

export const PRIMARY_KEYS = {
  Customer:        "id",
  SalesOrder:      "id",
  Delivery:        "id",
  BillingDocument: "id",
  JournalEntry:    "id",
  Payment:         "id",
  Product:         "id",
  Plant:           "id",
};

// ─── Relationship label map ───────────────────────────────────────────────────

export const REL_LABELS = {
  "Customer→SalesOrder":          "PLACED",
  "SalesOrder→Customer":          "PLACED",
  "SalesOrder→Delivery":          "FULFILLED_BY",
  "Delivery→SalesOrder":          "FULFILLED_BY",
  "Delivery→BillingDocument":     "BILLED_BY",
  "BillingDocument→Delivery":     "BILLED_BY",
  "BillingDocument→Customer":     "BILLED_TO",
  "Customer→BillingDocument":     "BILLED_TO",
  "BillingDocument→JournalEntry": "GENERATES",
  "JournalEntry→BillingDocument": "GENERATES",
  "JournalEntry→Payment":         "CLEARED_BY",
  "Payment→JournalEntry":         "CLEARED_BY",
  "SalesOrder→Product":           "CONTAINS",
  "Product→SalesOrder":           "CONTAINS",
  "Product→Plant":                "STORED_AT",
  "Plant→Product":                "STORED_AT",
};

// ─── Node visual palette ─────────────────────────────────────────────────────

export const NODE_PALETTE = {
  Customer:        { fill:"#1a2340", stroke:"#3b6fff", glow:"rgba(59,111,255,0.35)",  text:"#93b4ff", icon:"◎" },
  SalesOrder:      { fill:"#1a2b20", stroke:"#22c97a", glow:"rgba(34,201,122,0.35)",  text:"#6ee7a8", icon:"◈" },
  Delivery:        { fill:"#252014", stroke:"#f59e0b", glow:"rgba(245,158,11,0.35)",  text:"#fcd34d", icon:"◆" },
  BillingDocument: { fill:"#241a24", stroke:"#c084fc", glow:"rgba(192,132,252,0.35)", text:"#d8b4fe", icon:"◉" },
  JournalEntry:    { fill:"#1a2424", stroke:"#06b6d4", glow:"rgba(6,182,212,0.35)",   text:"#67e8f9", icon:"◇" },
  Payment:         { fill:"#241a1a", stroke:"#f87171", glow:"rgba(248,113,113,0.35)", text:"#fca5a5", icon:"◎" },
  Product:         { fill:"#1a1f2a", stroke:"#a78bfa", glow:"rgba(167,139,250,0.35)", text:"#c4b5fd", icon:"◈" },
  Plant:           { fill:"#1a2218", stroke:"#4ade80", glow:"rgba(74,222,128,0.35)",  text:"#86efac", icon:"◫" },
  Default:         { fill:"#161a22", stroke:"#4b5563", glow:"rgba(75,85,99,0.2)",     text:"#9ca3af", icon:"○" },
};

// ─── Layout constants ─────────────────────────────────────────────────────────

const COLS  = 4;
const GAP_X = 290;
const GAP_Y = 140;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function makeNodeId(value) {
  const label = value._label || "Unknown";
  const pkKey = PRIMARY_KEYS[label] || "id";
  const pkVal = value[pkKey] || JSON.stringify(value).substring(0, 32);
  return `${label}::${pkVal}`;
}

function buildTopValue(value, label) {
  const pk = PRIMARY_KEYS[label];
  if (pk && value[pk]) return String(value[pk]);
  const first = Object.entries(value).find(
    ([k, v]) => k !== "_label" && v != null && typeof v !== "object"
  );
  return first ? `${first[0]}: ${first[1]}` : label;
}

function buildSubtitle(value, label) {
  // Pick the most meaningful secondary field per node type
  const SUBTITLE_FIELDS = {
    Customer:        ["name", "city", "region"],
    SalesOrder:      ["amount", "currency", "deliveryStatus"],
    Delivery:        ["shippingPoint", "gmsStatus", "date"],
    BillingDocument: ["amount", "currency", "cancelled"],
    JournalEntry:    ["amount", "glAccount", "documentType"],
    Payment:         ["amount", "clearingDate"],
    Product:         ["name", "productType"],
    Plant:           ["name", "salesOrg"],
  };

  const preferredFields = SUBTITLE_FIELDS[label] || [];
  const parts = [];

  for (const field of preferredFields) {
    if (value[field] != null && value[field] !== "" && typeof value[field] !== "object") {
      const v = String(value[field]);
      parts.push(field === "amount" ? `₹${parseFloat(v).toFixed(2)}` : v);
      if (parts.length >= 2) break;
    }
  }

  if (parts.length) return parts.join(" · ");

  // Fallback: first two non-null non-id fields
  return Object.entries(value)
    .filter(([k, v]) => k !== "_label" && k !== PRIMARY_KEYS[label] && v != null && typeof v !== "object" && String(v).trim())
    .slice(0, 2)
    .map(([, v]) => String(v))
    .join(" · ");
}

function buildNodeObj(value, highlighted = true) {
  const label      = value._label || "Unknown";
  const id         = makeNodeId(value);
  const properties = { ...value };
  delete properties._label;

  return {
    id,
    type: "custom",
    data: {
      nodeLabel:  label,
      id:         buildTopValue(value, label),
      subtitle:   buildSubtitle(value, label),
      properties,
      highlighted,
    },
    position: { x: 0, y: 0 },
  };
}

function buildEdgeObj(id, src, tgt, srcLabel, tgtLabel, highlighted) {
  const pal    = NODE_PALETTE[srcLabel] || NODE_PALETTE.Default;
  const relKey = `${srcLabel}→${tgtLabel}`;
  return {
    id,
    source:   src,
    target:   tgt,
    type:     "custom",
    animated: highlighted,
    data: {
      label:       REL_LABELS[relKey] || "",
      stroke:      highlighted ? pal.stroke : "#2a3148",
      highlighted,
    },
    zIndex: highlighted ? 10 : 0,
  };
}

function isFlatResult(records) {
  return records.every(
    (r) => !Object.values(r).some((v) => v && typeof v === "object" && v._label)
  );
}

function buildFlatNodes(records) {
  return records.slice(0, 50).map((rec, i) => {
    const entries  = Object.entries(rec);
    const topEntry = entries[0];
    const rest     = entries
      .slice(1, 3)
      .map(([k, v]) => {
        if (v == null) return null;
        const s = String(v);
        return s ? `${k}: ${s}` : null;
      })
      .filter(Boolean)
      .join(" · ");

    return {
      id:   `flat-${i}`,
      type: "custom",
      data: {
        nodeLabel:   "Result",
        id:          topEntry ? `${topEntry[0]}: ${topEntry[1]}` : `Row ${i + 1}`,
        subtitle:    rest,
        properties:  rec,
        highlighted: true,
      },
      position: {
        x: (i % COLS) * GAP_X,
        y: Math.floor(i / COLS) * GAP_Y,
      },
    };
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Merges a new set of query result records into the existing graph state.
 * Existing nodes dim; new nodes highlight.
 *
 * @param {{ nodes: object[], edges: object[] }} currentGraph
 * @param {object[]} records - raw records from /query response
 * @returns {{ nodes: object[], edges: object[] }}
 */
export function mergeGraphData(currentGraph, records) {
  if (!records || records.length === 0) return currentGraph;

  // Flat results (COUNT, SUM, etc.) — render as result cards, replace graph
  if (isFlatResult(records)) {
    return { nodes: buildFlatNodes(records), edges: [] };
  }

  // Extract new nodes and edges from this result
  const newNodeMap = new Map();
  const newEdgeMap = new Map();

  for (const record of records) {
    const nodeVals = Object.values(record).filter(
      (v) => v && typeof v === "object" && !Array.isArray(v) && v._label
    );

    for (const val of nodeVals) {
      const node = buildNodeObj(val, true);
      if (!newNodeMap.has(node.id)) newNodeMap.set(node.id, node);
    }

    // Build edges between every pair of nodes in the same record
    for (let i = 0; i < nodeVals.length - 1; i++) {
      for (let j = i + 1; j < nodeVals.length; j++) {
        const srcId = makeNodeId(nodeVals[i]);
        const tgtId = makeNodeId(nodeVals[j]);
        const eid   = `e::${srcId}::${tgtId}`;
        if (!newEdgeMap.has(eid)) {
          newEdgeMap.set(
            eid,
            buildEdgeObj(eid, srcId, tgtId, nodeVals[i]._label, nodeVals[j]._label, true)
          );
        }
      }
    }
  }

  if (newNodeMap.size === 0) return currentGraph;

  // Dim existing graph
  const mergedNodes = new Map();
  const mergedEdges = new Map();

  for (const n of currentGraph?.nodes || []) {
    mergedNodes.set(n.id, { ...n, data: { ...n.data, highlighted: false } });
  }
  for (const e of currentGraph?.edges || []) {
    mergedEdges.set(e.id, {
      ...e,
      animated: false,
      data: { ...e.data, highlighted: false, stroke: "#2a3148" },
    });
  }

  // Inject new nodes — place brand-new ones in grid after existing
  let newIdx = mergedNodes.size;
  for (const [id, node] of newNodeMap) {
    if (mergedNodes.has(id)) {
      const ex = mergedNodes.get(id);
      mergedNodes.set(id, {
        ...ex,
        data: { ...ex.data, ...node.data, highlighted: true },
      });
    } else {
      node.position = {
        x: (newIdx % COLS) * GAP_X,
        y: Math.floor(newIdx / COLS) * GAP_Y,
      };
      newIdx++;
      mergedNodes.set(id, node);
    }
  }

  // Inject new edges
  for (const [id, edge] of newEdgeMap) {
    mergedEdges.set(id, edge);
  }

  return {
    nodes: Array.from(mergedNodes.values()),
    edges: Array.from(mergedEdges.values()),
  };
}