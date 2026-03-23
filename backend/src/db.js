// ─── db.js ───────────────────────────────────────────────────────────────────
// Production Neo4j connection with pooling, health check, and clean teardown.
// Single driver instance shared across the entire process.

import neo4j from "neo4j-driver";
import dotenv from "dotenv";

dotenv.config();

// ─── Validate required env vars at startup ───────────────────────────────────

const REQUIRED = ["NEO4J_URI", "NEO4J_USER", "NEO4J_PASS"];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    throw new Error(`[db] Missing required environment variable: ${key}`);
  }
}

// ─── Driver (singleton) ───────────────────────────────────────────────────────
// connectionTimeout      — how long to wait when opening a new TCP connection
//                          to Neo4j. Default in the driver is 5 000 ms.
// connectionAcquisitionTimeout — how long to wait to obtain a connection from
//                          the pool. The driver warns if this is set LOWER than
//                          connectionTimeout, because in the worst case the pool
//                          needs to open a new socket and connectionTimeout
//                          would be silently exceeded. We set acquisition to
//                          30 s (well above the 5 s connection timeout) so both
//                          values are consistent and the warning is suppressed.

const CONNECTION_TIMEOUT_MS    = parseInt(process.env.NEO4J_CONN_TIMEOUT    || "15000");
const ACQUISITION_TIMEOUT_MS   = parseInt(process.env.NEO4J_ACQUIRE_TIMEOUT || "30000");

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASS),
  {
    maxConnectionPoolSize:       parseInt(process.env.NEO4J_POOL_SIZE || "50"),
    connectionTimeout:           CONNECTION_TIMEOUT_MS,
    connectionAcquisitionTimeout: ACQUISITION_TIMEOUT_MS,
    logging:                     neo4j.logging.console(process.env.NEO4J_LOG_LEVEL || "warn"),
  }
);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns a new session from the shared driver pool.
 * Callers MUST call session.close() in a finally block.
 */
export function getSession(database = process.env.NEO4J_DATABASE || "neo4j") {
  return driver.session({ database });
}

/**
 * Verifies connectivity and server version. Call once at app startup.
 * Throws if the database is unreachable.
 */
export async function verifyConnectivity() {
  const info = await driver.getServerInfo();
  console.log(`[db] Connected to Neo4j ${info.agent} @ ${process.env.NEO4J_URI}`);
  return info;
}

/**
 * Graceful shutdown. Call on SIGTERM/SIGINT.
 * Drains in-flight sessions before closing the pool.
 */
export async function closeDriver() {
  await driver.close();
  // console.log("[db] Driver closed.");
}

// ─── Process-level teardown ───────────────────────────────────────────────────

process.on("SIGTERM", async () => { await closeDriver(); process.exit(0); });
process.on("SIGINT",  async () => { await closeDriver(); process.exit(0); });