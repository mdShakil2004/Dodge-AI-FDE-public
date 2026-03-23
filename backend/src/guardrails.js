// ─── guardrails.js ────────────────────────────────────────────────────────────
// Two-stage input validation before any LLM call is made.
//
// Stage 1: structural checks (length, injection patterns)
// Stage 2: domain relevance (must mention an O2C concept)
//
// Domain now covers all 19 SAP dataset types including plants, products,
// storage locations, schedule lines, and customer assignments.

// ─── Injection / prompt-manipulation patterns ─────────────────────────────────

const BLOCKED_PATTERNS = [
  /\b(drop\s+index|drop\s+constraint|drop\s+database)\b/i,
  /\b(hack|exploit|inject|truncate|delete\s+from)\b/i,
  /\b(ignore\s+(previous|all|prior)\s+instructions?)\b/i,
  /\b(forget\s+(everything|your\s+instructions?))\b/i,
  /\b(new\s+instructions?|system\s+prompt|you\s+are\s+now)\b/i,
  /\b(act\s+as|pretend\s+(you\s+are|to\s+be))\b/i,
  /\b(disregard|override)\s+(your\s+)?(rules?|instructions?|guidelines?)\b/i,
  /\.env\b/i,
  /\b(api[-_\s]?key|password|secret|token|credential)\b/i,
];

// ─── Domain term set ──────────────────────────────────────────────────────────
// Covers all 19 dataset types, their business synonyms, and common query verbs.
// At least one term must appear for a query to pass.

const DOMAIN_TERMS = new Set([
  // ── Entities ──────────────────────────────────────────────────────────────
  // Customers / Business Partners
  "customer", "customers", "client", "clients", "buyer", "buyers",
  "partner", "partners", "business partner", "sold to",

  // Sales Orders
  "order", "orders", "sales order", "sales orders", "so",
  "schedule line", "schedule lines", "delivery date", "confirmed qty",

  // Deliveries
  "delivery", "deliveries", "shipment", "shipments", "shipped", "dispatch",
  "outbound", "picking", "goods movement", "shipping point",

  // Billing Documents
  "billing", "bill", "bills", "invoice", "invoices", "invoiced",
  "billing document", "credit memo", "debit memo", "cancelled",

  // Journal Entries
  "journal", "journals", "journal entry", "journal entries",
  "accounting", "ledger", "gl account", "posting", "accounts receivable", "ar",

  // Payments
  "payment", "payments", "paid", "cleared", "outstanding", "open item",
  "clearing", "remittance",

  // Products / Materials
  "product", "products", "material", "materials", "item", "items",
  "sku", "bundle", "gift set", "bodyspray", "perfume", "facewash",
  "hairwax", "charcoal", "combo",

  // Plants
  "plant", "plants", "warehouse", "location", "storage",
  "storage location", "mrp", "availability",

  // ── Financial / business terms ─────────────────────────────────────────────
  "amount", "net", "total", "revenue", "value", "gross",
  "receivable", "balance", "fiscal", "fiscal year", "company code",
  "profit center", "cost center", "reconciliation",
  "incoterms", "payment terms", "credit",

  // ── SAP-specific ───────────────────────────────────────────────────────────
  "distribution channel", "sales organization", "sales area",
  "division", "material group", "product group", "product type",
  "account group", "deletion indicator", "blocked", "archived",

  // ── Query action words (only effective when paired with a domain noun) ─────
  "show", "list", "find", "get", "count", "sum", "average", "avg",
  "how many", "which", "what", "who", "top", "highest", "lowest",
  "all", "between", "recent", "latest", "unpaid", "open",
  "cancelled", "active", "completed",
]);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @param {string} question
 * @returns {{ allowed: boolean, reason: string }}
 */
export function checkGuardrails(question) {
  // ── Structural checks ────────────────────────────────────────────────────

  if (!question || typeof question !== "string") {
    return { allowed: false, reason: "Question must be a non-empty string." };
  }

  const trimmed = question.trim();

  if (trimmed.length < 4) {
    return { allowed: false, reason: "Question is too short. Please ask a specific question about your SAP data." };
  }

  if (trimmed.length > 600) {
    return { allowed: false, reason: "Question is too long. Please keep it under 600 characters." };
  }

  // ── Injection checks ─────────────────────────────────────────────────────

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      console.warn(`[guardrails] Blocked by pattern: ${pattern}`);
      return {
        allowed: false,
        reason:  "This system only answers questions about SAP Order-to-Cash data.",
      };
    }
  }

  // ── Domain relevance ─────────────────────────────────────────────────────
  // Tokenise into lowercase unigrams and bigrams, check against the domain set.

  const lower  = trimmed.toLowerCase();
  const words  = lower.split(/\s+/);
  const tokens = new Set(words);

  // Add bigrams
  for (let i = 0; i < words.length - 1; i++) {
    tokens.add(`${words[i]} ${words[i + 1]}`);
  }

  const hasDomainTerm = [...tokens].some((t) => DOMAIN_TERMS.has(t));

  if (!hasDomainTerm) {
    return {
      allowed: false,
      reason: "This system is designed to answer dataset-related queries only. Ask about customers, orders, deliveries, invoices, payments, products, or plants.",
    };
  }

  return { allowed: true, reason: "" };
}