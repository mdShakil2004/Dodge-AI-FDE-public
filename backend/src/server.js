// ─── server.js ────────────────────────────────────────────────────────────────
// Express API server.
//
// Request lifecycle (POST /query):
//   1. Input validation   — is the body well-formed?
//   2. Domain guardrails  — is this an O2C question?
//   3. LLM               — natural language → { query, explanation }
//   4. Cypher validation  — is the generated query safe and schema-conformant?
//   5. Neo4j execution   — run the query, get structured data
//   6. Response          — return data + explanation + cypher (for dev mode)
//
// How hallucination is prevented:
//   - The LLM generates a QUERY, not an answer. The answer comes from the DB.
//   - The schema-locked system prompt makes unlisted properties ungenerable.
//   - The validator enforces the allowlist a second time as defence in depth.
//   - If the DB returns 0 rows, the user sees 0 rows — not a fabricated answer.

import express    from "express";
import cors       from "cors";
import dotenv     from "dotenv";
import { checkGuardrails }         from "./guardrails.js";
import { nlToCypher }              from "./llm.js";
import { validateCypher, runQuery } from "./query.js";
import { verifyConnectivity }      from "./db.js";

dotenv.config();

const app     = express();
const IS_DEV  = process.env.NODE_ENV !== "production";
const PORT    = parseInt(process.env.PORT || "4000");

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(",") || "*",
  methods: ["GET", "POST"],
}));
app.use(express.json({ limit: "64kb" }));

// ─── Request logger ───────────────────────────────────────────────────────────

function makeRequestId() {
  return Math.random().toString(36).slice(2, 9).toUpperCase();
}

function log(reqId, stage, msg, data = "") {
  const ts = new Date().toISOString();
  const extra = data ? ` ${JSON.stringify(data)}` : "";
  // console.log(`[${ts}] [${reqId}] [${stage}] ${msg}${extra}`);
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  try {
    await verifyConnectivity();
    res.json({ status: "ok", db: "connected", timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "degraded", db: "disconnected", error: err.message });
  }
});

// ─── Main query endpoint ──────────────────────────────────────────────────────

app.post("/query", async (req, res) => {
  const reqId = makeRequestId();
  const startMs = Date.now();

  // ── Step 1: Input validation ───────────────────────────────────────────────

  const { question } = req.body || {};

  if (!question || typeof question !== "string" || question.trim().length === 0) {
    return res.status(400).json({
      error: "Missing or invalid 'question' field.",
      type:  "input_validation",
    });
  }

  const q = question.trim();
  log(reqId, "input", `"${q}"`);

  // ── Step 2: Domain guardrails ──────────────────────────────────────────────

  const guard = checkGuardrails(q);
  if (!guard.allowed) {
    log(reqId, "guardrail", "BLOCKED", { reason: guard.reason });
    return res.status(400).json({
      error: guard.reason,
      type:  "guardrail",
    });
  }

  // ── Step 3: LLM ───────────────────────────────────────────────────────────

  let llmResult;
  try {
    log(reqId, "llm", "Calling LLM...");
    llmResult = await nlToCypher(q);
    log(reqId, "llm", "Response received", {
      hasQuery:      !!llmResult.query,
      explanation:   llmResult.explanation?.substring(0, 80),
    });
  } catch (err) {
    log(reqId, "llm", "ERROR", { message: err.message });
    return res.status(502).json({
      error: "Failed to generate a query. The AI service may be temporarily unavailable.",
      type:  "llm_error",
    });
  }

  if (!llmResult.query) {
    log(reqId, "llm", "DECLINED", { explanation: llmResult.explanation });
    return res.json({
      query:       null,
      data:        [],
      count:       0,
      explanation: llmResult.explanation || "Could not generate a query for this question.",
      type:        "llm_decline",
    });
  }

  // ── Step 4: Cypher validation ──────────────────────────────────────────────

  const validation = validateCypher(llmResult.query);
  if (!validation.valid) {
    log(reqId, "validate", "FAILED", { reason: validation.reason, query: llmResult.query });
    return res.status(400).json({
      error:       `The generated query is not valid: ${validation.reason}`,
      type:        "validation",
      ...(IS_DEV && { query: llmResult.query }), // expose in dev only
    });
  }

  log(reqId, "validate", "OK", { query: llmResult.query.substring(0, 120) });

  // ── Step 5: Execute ────────────────────────────────────────────────────────

  let queryResult;
  try {
    log(reqId, "neo4j", "Executing query...");
    queryResult = await runQuery(llmResult.query);
    log(reqId, "neo4j", `OK — ${queryResult.count} records${queryResult.truncated ? " (truncated)" : ""}`);
  } catch (err) {
    log(reqId, "neo4j", "ERROR", { message: err.message });
    return res.status(500).json({
      error: IS_DEV
        ? `Query execution failed: ${err.message}`
        : "Query execution failed. Please try rephrasing your question.",
      type: "execution_error",
      ...(IS_DEV && { query: llmResult.query }),
    });
  }

  // ── Step 6: Response ───────────────────────────────────────────────────────

  const elapsed = Date.now() - startMs;
  log(reqId, "response", `Sending ${queryResult.count} records in ${elapsed}ms`);

  return res.json({
    explanation: llmResult.explanation,
    data:        queryResult.records,
    count:       queryResult.count,
    truncated:   queryResult.truncated,
    elapsed_ms:  elapsed,
    // Only expose the generated Cypher in non-production (useful for dev UI)
    ...(IS_DEV && { query: llmResult.query }),
  });
});

// ─── 404 handler ──────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Endpoint not found." });
});

// ─── Global error handler ─────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error.", type: "unhandled" });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  try {
    console.log("[server] Verifying database connection...");
    await verifyConnectivity();

    app.listen(PORT, () => {
      console.log(`[server] Running on http://localhost:${PORT}`);
      console.log(`[server] Mode: ${IS_DEV ? "development" : "production"}`);
      console.log(`[server] POST /query  — Natural language → Cypher → Neo4j`);
      console.log(`[server] GET  /health — Health check`);
    });
  } catch (err) {
    console.error("[server] Startup failed:", err.message);
    process.exit(1);
  }
}

start();