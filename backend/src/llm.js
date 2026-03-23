// ─── llm.js ───────────────────────────────────────────────────────────────────
// Natural language → Cypher via OpenRouter. Full schema, robust fallback chain.
//
// RETRY POLICY:
//   HTTP 404  → model not found / retired      → try next model
//   HTTP 429  → rate limited                   → try next model
//   HTTP 503  → model unavailable              → try next model
//   Timeout   → model too slow (>30s)          → try next model  ← NEW
//   Empty res → model returned nothing         → try next model  ← NEW
//   HTTP 401  → bad API key                    → throw immediately
//   HTTP 400  → malformed request              → throw immediately
//   Other     → unknown error                  → throw immediately

import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

// ─── Model priority list ──────────────────────────────────────────────────────
// Ordered by: reliability > speed > quality for Cypher generation.
// All confirmed available March 2026. "openrouter/free" is the guaranteed fallback.

const MODEL_PRIORITY = process.env.LLM_MODEL
  ? [process.env.LLM_MODEL]
  : [
      // Confirmed working March 2026 — ordered fastest/most-reliable first
      "meta-llama/llama-3.3-70b-instruct:free",       // fast, reliable JSON output
      "nvidia/nemotron-3-super-120b-a12b:free",        // 262K ctx, strong instruction follow
      "arcee-ai/trinity-large-preview:free",           // 400B MoE, good structured output
      "deepseek/deepseek-r1:free",                     // strong reasoning, sometimes slow
      "openrouter/free",                               // guaranteed fallback — never 404s
    ];

// Per-model timeout in ms. Smaller/faster models get tighter limits.
const MODEL_TIMEOUTS = {
  "meta-llama/llama-3.3-70b-instruct:free":   20_000,
  "nvidia/nemotron-3-super-120b-a12b:free":   22_000,
  "arcee-ai/trinity-large-preview:free":      25_000,
  "deepseek/deepseek-r1:free":                30_000,
  "openrouter/free":                          35_000,
};
const DEFAULT_TIMEOUT = 25_000;

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ─── Graph schema ─────────────────────────────────────────────────────────────

const GRAPH_SCHEMA = `
## Node Labels and Properties

Customer
  id (string)              — business partner ID, e.g. "310000108"
  name (string)            — full organisation name
  region (string)          — Indian state code: "RJ", "MH", "KA", "WB", "TN", etc.
  country (string)         — always "IN"
  city (string)
  postalCode (string)
  blocked (boolean)        — true if business partner is blocked
  markedForArchiving (boolean)
  companyCode (string)     — always "ABCD"
  reconciliationAccount (string)
  paymentTerms (string)    — e.g. "Z001", "Z009"
  deletionIndicator (boolean)
  currency (string)        — always "INR"
  creationDate (string, YYYY-MM-DD)

SalesOrder
  id (string)              — e.g. "740506"
  type (string)            — "OR" = standard order
  salesOrg (string)        — always "ABCD"
  distChannel (string)     — "05", "10", "11", "RC", "RB"
  amount (float)           — total net amount in INR
  currency (string)
  deliveryStatus (string)  — "C" = complete, "A" = partial, "" = not started
  date (string, YYYY-MM-DD)
  soldToParty (string)     — Customer id
  createdBy (string)
  requestedDelivDate (string, YYYY-MM-DD)
  paymentTerms (string)
  confirmedQty (integer)   — total confirmed quantity from schedule lines

Delivery
  id (string)              — e.g. "80737721"
  date (string, YYYY-MM-DD)
  shippingPoint (string)   — e.g. "1920", "KA05", "MH05"
  gmsStatus (string)       — goods movement status: "A" = not started
  pickStatus (string)      — "C" = picking complete
  stub (boolean)           — true if created as reference without a header record

BillingDocument
  id (string)              — e.g. "90504248"
  type (string)            — "F2" = standard invoice
  amount (float)           — net amount in INR
  currency (string)
  cancelled (boolean)      — true if cancelled
  date (string, YYYY-MM-DD)
  fiscalYear (string)      — e.g. "2025"
  companyCode (string)
  soldToParty (string)
  journalId (string)       — linked accounting document id

JournalEntry
  id (string)              — accounting document number, e.g. "9400000220"
  amount (float)           — positive = AR debit, negative = clearing credit
  glAccount (string)       — e.g. "15500020"
  profitCenter (string)    — e.g. "ABC001"
  postingDate (string, YYYY-MM-DD)
  documentType (string)    — "RV" = billing-related, "DZ" = payment
  fatType (string)         — "D" = customer receivable
  companyCode (string)
  fiscalYear (string)
  billingRef (string)      — the billing document this journal came from
  clearingDoc (string)     — the clearing/payment document id
  customerId (string)

Payment
  id (string)              — clearing document number, e.g. "9400635977"
  amount (float)
  clearingDate (string, YYYY-MM-DD)
  fiscalYear (string)
  companyCode (string)
  customerId (string)
  arDocId (string)         — the AR journal entry being cleared

Product
  id (string)              — material code, e.g. "S8907367001003"
  name (string)            — product description, e.g. "BODYSPRAY 150ML"
  productType (string)     — "ZF01"=finished good, "ZFS1"=sub-item, "ZPKG"=packaging
  productGroup (string)    — e.g. "ZFG1001", "ZPKG004"
  division (string)        — "01" or "02"
  baseUnit (string)        — "PC"
  grossWeight (float)
  weightUnit (string)      — "KG"
  productOldId (string)    — legacy code, e.g. "ABC-WEB-243"
  isDeleted (boolean)

Plant
  id (string)              — plant code, e.g. "1001", "WB05", "KA05"
  name (string)            — e.g. "Lake Christopher Plant"
  valuationArea (string)
  salesOrg (string)
  factoryCalendar (string) — "IN"

## Relationships

(Customer)-[:PLACED]->(SalesOrder)
(Customer)<-[:BILLED_TO]-(BillingDocument)
(SalesOrder)-[:FULFILLED_BY]->(Delivery)
(SalesOrder)-[:CONTAINS {quantity:float, netAmount:float, itemNo:string, plant:string}]->(Product)
(Delivery)-[:BILLED_BY]->(BillingDocument)
(BillingDocument)-[:GENERATES]->(JournalEntry)
(JournalEntry)-[:CLEARED_BY]->(Payment)
(Product)-[:STORED_AT {mrpType:string, profitCenter:string, availCheck:string}]->(Plant)

## Important notes
- Filter cancelled billing docs: WHERE b.cancelled = false
- Full O2C path: Customer → SalesOrder → Delivery → BillingDocument → JournalEntry → Payment
- Products starting with "B" are bundles; "S" are single items
- Distribution channel "05"=modern trade, "11"=direct, "RC"/"RB"=returns
`;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Cypher query generator for a Neo4j SAP Order-to-Cash graph.

${GRAPH_SCHEMA}

## STRICT RULES

1. OUTPUT: Respond with exactly ONE JSON object on a single line. No markdown. No extra text.
   Success: {"query":"MATCH ...","explanation":"one sentence"}
   Failure: {"query":null,"explanation":"reason why"}

2. SCHEMA: Only use labels, relationships, properties listed above. Never invent identifiers.

3. READ-ONLY: Only MATCH, OPTIONAL MATCH, WITH, WHERE, RETURN, ORDER BY, LIMIT, UNWIND, COUNT, SUM, AVG, MIN, MAX.
   Never CREATE, MERGE, SET, DELETE, REMOVE, DROP, DETACH, CALL, FOREACH.

4. SYNTAX: Always put a space between a keyword and the opening parenthesis.
   CORRECT:   MATCH (n:Customer)
   INCORRECT: MATCH(n:Customer)

5. LIMIT: Always include. Lists: LIMIT 25. Single-row aggregations: LIMIT 1.

6. RETURN: Specific properties only, never whole nodes. Give aggregations clear aliases.

7. CANCELLED: Always add WHERE b.cancelled = false unless question is about cancelled docs.

8. PERFORMANCE: Never start a query with a bare MATCH on a large node type with no filter.
   - Top N orders WITH customer: MATCH (c:Customer)-[:PLACED]->(s:SalesOrder) RETURN ... ORDER BY s.amount DESC LIMIT 10
   - NOT: MATCH (s:SalesOrder) OPTIONAL MATCH (c:Customer)-[:PLACED]->(s) ...
   - Use OPTIONAL MATCH only when you genuinely need rows where a relationship might be missing.

9. EXPLANATION: One plain-English sentence about business meaning. No Cypher terms.

## QUERY PATTERNS

Total revenue:
{"query":"MATCH (b:BillingDocument) WHERE b.cancelled = false RETURN SUM(b.amount) AS totalRevenue LIMIT 1","explanation":"Returns total net revenue across all active billing documents."}

Top 10 highest-value sales orders:
{"query":"MATCH (c:Customer)-[:PLACED]->(s:SalesOrder) RETURN s.id AS orderId, s.amount AS netAmount, s.date AS orderDate, c.name AS customerName ORDER BY s.amount DESC LIMIT 10","explanation":"Lists the ten sales orders with the highest net amount, sorted descending."}

Customer orders:
{"query":"MATCH (c:Customer)-[:PLACED]->(s:SalesOrder) RETURN c.name, c.id, s.id, s.amount, s.date ORDER BY s.amount DESC LIMIT 25","explanation":"Lists all customers with their sales orders, sorted by value."}

Products with revenue:
{"query":"MATCH (s:SalesOrder)-[r:CONTAINS]->(p:Product) RETURN p.name, p.id, SUM(r.quantity) AS totalQty, SUM(r.netAmount) AS totalRevenue ORDER BY totalRevenue DESC LIMIT 25","explanation":"Shows all products with total quantities ordered and revenue generated."}

Unpaid invoices:
{"query":"MATCH (c:Customer)<-[:BILLED_TO]-(b:BillingDocument) WHERE b.cancelled = false OPTIONAL MATCH (b)-[:GENERATES]->(j:JournalEntry)-[:CLEARED_BY]->(pay:Payment) WITH c, b, pay WHERE pay IS NULL RETURN c.name AS customerName, b.id AS invoiceId, b.amount AS amount, b.date AS invoiceDate ORDER BY b.amount DESC LIMIT 25","explanation":"Shows customers with billing documents that have not yet been paid."}

Full O2C path:
{"query":"MATCH (c:Customer)-[:PLACED]->(s:SalesOrder)-[:FULFILLED_BY]->(d:Delivery)-[:BILLED_BY]->(b:BillingDocument)-[:GENERATES]->(j:JournalEntry) WHERE b.cancelled = false RETURN c.name, s.id, d.id, b.id, b.amount, j.amount LIMIT 25","explanation":"Shows the complete order-to-cash chain from customer to accounting entry."}

Products per plant:
{"query":"MATCH (p:Product)-[:STORED_AT]->(pl:Plant) RETURN pl.name, pl.id, COUNT(p) AS productCount ORDER BY productCount DESC LIMIT 25","explanation":"Shows how many products are assigned to each plant."}

Blocked customers:
{"query":"MATCH (c:Customer) WHERE c.blocked = true RETURN c.id, c.name, c.region, c.city LIMIT 25","explanation":"Lists all customers that are currently blocked."}

Revenue by customer:
{"query":"MATCH (c:Customer)<-[:BILLED_TO]-(b:BillingDocument) WHERE b.cancelled = false RETURN c.name, c.id, SUM(b.amount) AS totalBilled, COUNT(b) AS invoiceCount ORDER BY totalBilled DESC LIMIT 25","explanation":"Shows total billed amount per customer, sorted highest first."}
`;

// ─── Main export ──────────────────────────────────────────────────────────────

export async function nlToCypher(question) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set in .env");

  let lastErr  = null;
  let attempts = 0;

  for (const model of MODEL_PRIORITY) {
    attempts++;
    try {
      const result = await callModel(model, question, apiKey);
      return result;
    } catch (err) {
      lastErr = err;

      const shouldRetry = isRetryable(err);
      console.warn(`[llm] ${model} failed (${err.message?.substring(0, 80)}) — ${shouldRetry ? "retrying next" : "non-retryable, throwing"}`);

      if (shouldRetry) continue;
      throw formatErr(err);
    }
  }

  throw new Error(`All ${attempts} LLM models failed. Last error: ${lastErr?.message}`);
}

// ─── Retryable error classifier ───────────────────────────────────────────────
// Returns true if we should try the next model in the priority list.

function isRetryable(err) {
  const status = err.response?.status;
  const body   = err.response?.data;

  // HTTP 400 is normally a bad request (non-retryable), BUT OpenRouter returns
  // 400 when a model ID is invalid/retired — that should fall through to the next model.
  if (status === 400) {
    const msg = (body?.error?.message || "").toLowerCase();
    if (msg.includes("not a valid model") || msg.includes("invalid model") || msg.includes("model not found")) {
      return true;
    }
    return false; // other 400s (malformed JSON, etc.) are not retryable
  }

  // Standard retryable HTTP codes
  if (status === 404 || status === 429 || status === 503 || status === 502) return true;

  const msg = err.message?.toLowerCase() || "";

  // Network-level failures
  if (msg.includes("timeout"))        return true;
  if (msg.includes("econnreset"))     return true;
  if (msg.includes("econnrefused"))   return true;
  if (msg.includes("socket hang up")) return true;
  if (msg.includes("network error"))  return true;
  if (msg.includes("empty response")) return true;
  if (msg.includes("no choices"))     return true;

  return false;
}

// ─── Single model caller ──────────────────────────────────────────────────────

async function callModel(model, question, apiKey) {
  const timeout = MODEL_TIMEOUTS[model] ?? DEFAULT_TIMEOUT;
  // console.log(`[llm] Trying: ${model} (timeout: ${timeout/1000}s)`);

  let res;
  try {
    res = await axios.post(OPENROUTER_URL, {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: question },
      ],
      temperature: 0,
      max_tokens:  1200,   // raised from 700 — Cypher + explanation can hit 700 chars easily
    }, {
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost:4000",
        "X-Title":      "SAP O2C Intelligence",
      },
      timeout,
    });
  } catch (err) {
    // Axios wraps timeout as ECONNABORTED — normalise the message so isRetryable() catches it
    if (err.code === "ECONNABORTED" || err.message?.includes("timeout")) {
      throw new Error(`timeout of ${timeout}ms exceeded for ${model}`);
    }
    throw err;
  }

  const choices = res.data?.choices;
  if (!choices || choices.length === 0) {
    throw new Error(`empty response — no choices returned from ${model}`);
  }

  const raw = choices[0]?.message?.content;
  if (!raw || raw.trim() === "") {
    throw new Error(`empty response from ${model}`);
  }

  const u = res.data?.usage || {};
  // console.log(`[llm] OK: ${res.data?.model || model} | prompt:${u.prompt_tokens ?? "?"} compl:${u.completion_tokens ?? "?"}`);

  return parse(raw);
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parse(text) {
  const preview = text.substring(0, 200).replace(/\n/g, " ");
  console.log(`[llm] raw: ${preview}${text.length > 200 ? "…" : ""}`);

  // 1. Direct parse — ideal path
  try { const o = JSON.parse(text.trim()); if (isValid(o)) return sanitize(o); } catch {}

  // 2. Strip markdown fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) { try { const o = JSON.parse(fence[1].trim()); if (isValid(o)) return sanitize(o); } catch {} }

  // 3. Extract first complete {...} block (model added preamble)
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) { try { const o = JSON.parse(brace[0]); if (isValid(o)) return sanitize(o); } catch {} }

  // 4. Truncation recovery — model hit max_tokens mid-JSON.
  //    The raw text looks like: {"query":"MATCH ... LIMIT 25","explanation":"...
  //    We extract the Cypher string directly from the partial JSON.
  const truncatedQuery = text.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (truncatedQuery) {
    let q = truncatedQuery[1]
      .replace(/\\n/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .trim();
    q = fixCypher(q);
    if (q) {
      console.warn("[llm] Truncated JSON — extracted query via partial parse");
      const explanationMatch = text.match(/"explanation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return {
        query:       q,
        explanation: explanationMatch ? explanationMatch[1].trim() : "Query extracted from truncated response.",
      };
    }
  }

  // 5. Last resort: pull any MATCH...RETURN...LIMIT block from raw text
  const cypherMatch = text.match(/MATCH\s[\s\S]+?RETURN\s[\s\S]+?LIMIT\s+\d+/i);
  if (cypherMatch) {
    const q = fixCypher(cypherMatch[0].trim());
    if (q) {
      console.warn("[llm] Extracted raw Cypher from unstructured response");
      return { query: q, explanation: "Query extracted from model response." };
    }
  }

  console.warn("[llm] Could not parse any usable query from response");
  return { query: null, explanation: "Could not generate a valid query. Please try rephrasing." };
}

const isValid = o => o && typeof o === "object" && ("query" in o || "explanation" in o);

function sanitize(o) {
  return {
    query:       o.query       ? fixCypher(String(o.query).trim()) : null,
    explanation: o.explanation ? String(o.explanation).trim()      : "",
  };
}

function fixCypher(q) {
  q = q.replace(/["`']+$/, "").trim();

  // Normalise missing space after Cypher keywords — some models output MATCH(x) not MATCH (x)
  // This prevents the validator's firstWord check from failing on "MATCH(C:CUSTOMER)..."
  q = q.replace(/\b(MATCH|OPTIONAL\s+MATCH|WITH|WHERE|RETURN|ORDER\s+BY|UNWIND)\(/gi,
    (_, kw) => `${kw} (`);

  if (!/\bRETURN\b/i.test(q)) { console.warn("[llm] No RETURN clause — query rejected"); return null; }
  if (!/\bLIMIT\b/i.test(q))  { q += " LIMIT 25"; console.warn("[llm] LIMIT missing — appended LIMIT 25"); }
  return q;
}

function formatErr(err) {
  if (err.response) {
    return new Error(`OpenRouter HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
  }
  return new Error(`OpenRouter network: ${err.message}`);
}