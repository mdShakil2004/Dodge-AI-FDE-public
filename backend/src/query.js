// ─── query.js ─────────────────────────────────────────────────────────────────
// Cypher validation + safe Neo4j execution layer.
//
// TIMEOUT RATIONALE:
//   The original 15s timeout was designed for a small demo dataset (~50 nodes).
//   With a real SAP dataset (100k+ nodes), aggregation queries like SUM/COUNT
//   across all BillingDocuments can legitimately take 30–60s on a local Neo4j.
//   We now default to 120s and expose NEO4J_QUERY_TIMEOUT_MS in .env.
//
//   If queries are consistently slow, the correct fix is to add indexes on the
//   properties being filtered (already done in ingest.js for `cancelled`, etc.)
//   and ensure Neo4j has enough heap (set NEO4J_SERVER_MEMORY_HEAP_INITIAL_SIZE
//   and NEO4J_SERVER_MEMORY_HEAP_MAX_SIZE in neo4j.conf).

import { getSession } from "./db.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_RESULTS       = 200;
const MAX_LIMIT_ALLOWED = 50;
const QUERY_TIMEOUT_MS  = parseInt(process.env.NEO4J_QUERY_TIMEOUT_MS || "180000");

// ─── Schema allowlists ────────────────────────────────────────────────────────

const ALLOWED_LABELS = new Set([
  "Customer", "SalesOrder", "Delivery",
  "BillingDocument", "JournalEntry", "Payment", "Product", "Plant",
]);

const ALLOWED_REL_TYPES = new Set([
  "PLACED", "CONTAINS", "FULFILLED_BY",
  "BILLED_BY", "BILLED_TO", "GENERATES", "CLEARED_BY", "STORED_AT",
]);

const WRITE_KEYWORDS = [
  "CREATE", "DELETE", "DETACH", "SET", "MERGE",
  "REMOVE", "DROP", "CALL", "FOREACH", "LOAD CSV",
];

const ALLOWED_STARTERS = new Set([
  "MATCH", "OPTIONAL", "WITH", "RETURN", "UNWIND",
]);

// ─── Cypher validator ─────────────────────────────────────────────────────────

/**
 * Statically validates a Cypher query string. No DB call.
 * @returns {{ valid: boolean, reason: string }}
 */
export function validateCypher(cypher) {
  if (!cypher || typeof cypher !== "string" || !cypher.trim()) {
    return { valid: false, reason: "Cypher query is empty or null." };
  }

  const q          = cypher.trim();
  // Normalise: collapse whitespace AND ensure there's a space after keywords
  // so "MATCH(n:Label)" becomes "MATCH (N:LABEL)" before we split on spaces.
  const normalised = q
    .replace(/\s+/g, " ")               // collapse all whitespace
    .replace(/([A-Z_]+)\(/gi, "$1 (")   // insert space before ( if missing: MATCH( → MATCH (
    .toUpperCase()
    .trim();

  // 1. Block write operations
  for (const kw of WRITE_KEYWORDS) {
    if (new RegExp(`\\b${kw.replace(" ", "\\s+")}\\b`).test(normalised)) {
      return { valid: false, reason: `Write operation "${kw}" is not allowed. Only read queries are permitted.` };
    }
  }

  // 2. Must start with an allowed keyword
  // Split on first non-word boundary to handle MATCH(c:Customer) without space
  const firstWordMatch = normalised.match(/^([A-Z]+)/);
  const firstWord = firstWordMatch ? firstWordMatch[1] : "";
  if (!ALLOWED_STARTERS.has(firstWord)) {
    return {
      valid:  false,
      reason: `Query must start with: ${[...ALLOWED_STARTERS].join(", ")}. Got: "${firstWord}".`,
    };
  }

  // 3. Must have RETURN
  if (!normalised.includes("RETURN")) {
    return { valid: false, reason: "Query must include a RETURN clause." };
  }

  // 4. Must have LIMIT within allowed range
  if (!normalised.includes("LIMIT")) {
    return { valid: false, reason: "Query must include a LIMIT clause." };
  }
  const limitMatch = normalised.match(/\bLIMIT\s+(\d+)/);
  if (limitMatch) {
    const v = parseInt(limitMatch[1], 10);
    if (v > MAX_LIMIT_ALLOWED) {
      return { valid: false, reason: `LIMIT ${v} exceeds maximum (${MAX_LIMIT_ALLOWED}).` };
    }
  }

  // 5. Schema: node labels
  for (const [, label] of q.matchAll(/\([\w\s]*:(\w+)/g)) {
    if (!ALLOWED_LABELS.has(label)) {
      return { valid: false, reason: `Unknown label "${label}". Allowed: ${[...ALLOWED_LABELS].join(", ")}.` };
    }
  }

  // 6. Schema: relationship types
  for (const [, rel] of q.matchAll(/\[[\w\s]*:(\w+)/g)) {
    if (!ALLOWED_REL_TYPES.has(rel)) {
      return { valid: false, reason: `Unknown relationship "${rel}". Allowed: ${[...ALLOWED_REL_TYPES].join(", ")}.` };
    }
  }

  return { valid: true, reason: "" };
}

// ─── Query executor ───────────────────────────────────────────────────────────

/**
 * Executes a validated Cypher query.
 * @param {string} cypher
 * @returns {Promise<{ records: object[], count: number, truncated: boolean }>}
 */
export async function runQuery(cypher) {
  const validation = validateCypher(cypher);
  if (!validation.valid) {
    throw new Error(`Cypher validation failed: ${validation.reason}`);
  }

  const session = getSession();

  try {
    // console.log(`[query] Executing with timeout ${QUERY_TIMEOUT_MS}ms`);
    const result = await session.run(cypher, {}, { timeout: QUERY_TIMEOUT_MS });

    const allRecords = result.records.map((record) => {
      const obj = {};
      for (const key of record.keys) {
        obj[key] = serializeNeo4jValue(record.get(key));
      }
      return obj;
    });

    const truncated = allRecords.length > MAX_RESULTS;
    const records   = truncated ? allRecords.slice(0, MAX_RESULTS) : allRecords;

    return { records, count: records.length, truncated };

  } catch (err) {
    const code = err.code ? ` [${err.code}]` : "";

    // Surface a more helpful message for the most common failure
    if (err.code === "Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration") {
      throw new Error(
        `Query timed out after ${QUERY_TIMEOUT_MS / 1000}s. ` +
        `Try a more specific query (add WHERE filters or reduce LIMIT). ` +
        `To increase the timeout, set NEO4J_QUERY_TIMEOUT_MS in your .env file.`
      );
    }

    throw new Error(`Query execution failed${code}: ${err.message}`);
  } finally {
    await session.close();
  }
}

// ─── Neo4j value serializer ───────────────────────────────────────────────────

function serializeNeo4jValue(value) {
  if (value === null || value === undefined) return null;

  const t = value?.constructor?.name;

  if (t === "Integer")    return value.toNumber();
  if (t === "Float")      return value.toNumber ? value.toNumber() : value;

  if (["Date","DateTime","LocalDateTime","Time","LocalTime","Duration"].includes(t)) {
    return value.toString();
  }

  if (t === "Node") {
    return { _label: value.labels?.[0] || "Unknown", ...serializeProps(value.properties) };
  }

  if (t === "Relationship") {
    return { _type: value.type, ...serializeProps(value.properties) };
  }

  if (t === "Path") {
    return { _type: "Path", start: serializeNeo4jValue(value.start), end: serializeNeo4jValue(value.end), length: value.length };
  }

  if (Array.isArray(value)) return value.map(serializeNeo4jValue);

  if (typeof value === "object" && !(value instanceof Date)) {
    return serializeProps(value);
  }

  return value;
}

function serializeProps(props) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = serializeNeo4jValue(v);
  }
  return out;
}