# GraphO2C — SAP Order-to-Cash Intelligence System

> Ask natural language questions about your SAP data. Get answers from a live knowledge graph.

GraphO2C transforms fragmented SAP Order-to-Cash relational data into a unified **Neo4j knowledge graph** and lets you query it in plain English. Type a question, the system converts it to Cypher via an LLM, executes it against Neo4j, and visualises the result as an interactive graph or data table.

---

## Live Demo

| Layer | URL |
|---|---|
| Frontend | `https://your-app.vercel.app` |
| Backend API | `https://your-app.railway.app` |
| Health check | `https://your-app.railway.app/health` |

---

## Screenshots

> Graph view showing the full O2C path: Customer → Order → Delivery → Invoice → Payment

---

## Architecture

```
┌─────────────────────────────────┐     ┌──────────────────────────────────┐
│         Frontend (Vercel)       │     │       Backend (Railway)           │
│                                 │     │                                   │
│  React + React Flow             │────▶│  Express API  (server.js)        │
│  Chat UI  (Chat.jsx)            │     │  Guardrails   (guardrails.js)    │
│  Graph    (Graph.jsx)           │◀────│  LLM Layer    (llm.js)           │
│  DataTable                      │     │  Validator    (query.js)         │
│                                 │     │  Neo4j Driver (db.js)            │
└─────────────────────────────────┘     └────────────────┬─────────────────┘
                                                         │
                                                         ▼
                                        ┌──────────────────────────────────┐
                                        │     Neo4j AuraDB (cloud)         │
                                        │                                   │
                                        │  8 node types · 8 rel types      │
                                        │  Customer → SalesOrder →         │
                                        │  Delivery → BillingDocument →    │
                                        │  JournalEntry → Payment          │
                                        └──────────────────────────────────┘
```

### Request lifecycle

```
User question
    │
    ▼
[1] Input validation      — length, encoding
[2] Domain guardrails     — must be an O2C question
[3] LLM → Cypher          — schema-locked system prompt, fallback chain
[4] Cypher validation     — allowlist check, write-op block
[5] Neo4j execution       — 120s timeout, 200 row cap
[6] Response              — { data, explanation, count, elapsed_ms }
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, React Flow, Vite |
| Backend | Node.js 20, Express 5 |
| Database | Neo4j 5 (AuraDB Free / self-hosted) |
| LLM | OpenRouter API (free model fallback chain) |
| Hosting — Frontend | Vercel |
| Hosting — Backend | Railway |
| Data format | JSONL (19 SAP dataset folders) |

---

## Graph Schema

### Node types

| Label | Key properties | Description |
|---|---|---|
| `Customer` | `id`, `name`, `region`, `city`, `blocked` | Business partner master |
| `SalesOrder` | `id`, `amount`, `date`, `deliveryStatus` | SO header |
| `Delivery` | `id`, `shippingPoint`, `gmsStatus` | Outbound delivery |
| `BillingDocument` | `id`, `amount`, `cancelled`, `date` | Invoice / credit memo |
| `JournalEntry` | `id`, `amount`, `glAccount`, `postingDate` | AR accounting entry |
| `Payment` | `id`, `amount`, `clearingDate` | Clearing / payment |
| `Product` | `id`, `name`, `productType`, `productGroup` | Material master |
| `Plant` | `id`, `name`, `salesOrg` | Manufacturing / storage plant |

### Relationships

```
(Customer)-[:PLACED]->(SalesOrder)
(Customer)<-[:BILLED_TO]-(BillingDocument)
(SalesOrder)-[:FULFILLED_BY]->(Delivery)
(SalesOrder)-[:CONTAINS {quantity, netAmount}]->(Product)
(Delivery)-[:BILLED_BY]->(BillingDocument)
(BillingDocument)-[:GENERATES]->(JournalEntry)
(JournalEntry)-[:CLEARED_BY]->(Payment)
(Product)-[:STORED_AT {mrpType, availCheck}]->(Plant)
```

---

## Dataset

The system ingests **19 SAP O2C dataset folders** (JSONL format):

```
SAP Order-to-Cash-dataset/
├── billing_document_headers/
├── billing_document_items/
├── billing_document_cancellations/
├── business_partners/
├── business_partner_addresses/
├── customer_company_assignments/
├── customer_sales_area_assignments/
├── sales_order_headers/
├── sales_order_items/
├── sales_order_schedule_lines/
├── outbound_delivery_headers/
├── outbound_delivery_items/
├── journal_entry_items_accounts_receivable/
├── payments_accounts_receivable/
├── products/
├── product_descriptions/
├── product_plants/
├── product_storage_locations/
└── plants/
```

The ingestion pipeline (`ingest.js`) identifies each file by field signature (not filename), handles both flat and subdirectory layouts, and is fully idempotent — re-running it updates existing nodes rather than creating duplicates.

---

## LLM Layer

Natural language is converted to Cypher using a **schema-locked system prompt** with a priority fallback chain of free models:

| Priority | Model | Timeout |
|---|---|---|
| 1 | `meta-llama/llama-3.3-70b-instruct:free` | 20s |
| 2 | `nvidia/nemotron-3-super-120b-a12b:free` | 22s |
| 3 | `arcee-ai/trinity-large-preview:free` | 25s |
| 4 | `deepseek/deepseek-r1:free` | 30s |
| 5 | `openrouter/free` (auto-selects available model) | 35s |

If a model times out, returns a 404/429/503, or returns an invalid model ID (400), the system automatically retries with the next model. The last entry (`openrouter/free`) never 404s.

### Anti-hallucination design

The LLM generates a **Cypher query**, not an answer. The answer comes from the database. This means:

- If data doesn't exist, the query returns 0 rows — not a fabricated response
- The schema-locked prompt makes unlisted properties impossible to generate
- A second validation layer (`query.js`) enforces the schema allowlist independently of the LLM

---

## Project Structure

```
backend/
├── src/
│   └── server.js           # Express API, request lifecycle
├── db.js                   # Neo4j driver singleton, connection pooling
├── llm.js                  # OpenRouter API, fallback chain, response parser
├── query.js                # Cypher validator, Neo4j executor
├── guardrails.js           # Domain filtering, injection blocking
├── ingest.js               # Full O2C ingestion pipeline
└── .env                    # Environment variables (not committed)

frontend/
├── src/
│   ├── App.jsx             # Root component
│   ├── page/
│   │   └── Page.jsx        # App shell, responsive layout (mobile/tablet/desktop)
│   ├── components/
│   │   ├── Chat.jsx        # Chat UI, suggestion chips, typing indicator
│   │   └── Graph.jsx       # React Flow graph, custom nodes/edges, DataTable
│   └── utils/
│       └── graph-utils.js  # Record → React Flow node/edge transformer
└── vite.config.js
```

---

## Local Development

### Prerequisites

- Node.js 20+
- Neo4j Desktop (local) or Neo4j AuraDB (cloud free tier)
- OpenRouter API key — [openrouter.ai](https://openrouter.ai) (free)

### 1. Clone and install

```bash
git clone https://github.com/your-username/grapho2c.git
cd grapho2c

# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Configure environment

Create `backend/.env`:

```dotenv
# Neo4j — local
NEO4J_URI=neo4j://127.0.0.1:7687
NEO4J_USER=neo4j
NEO4J_PASS=your_local_password

# LLM
OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxxxxxx

# Optional tuning
NODE_ENV=development
PORT=4000
NEO4J_QUERY_TIMEOUT_MS=120000
INGEST_BATCH_SIZE=500
```

Create `frontend/.env.local`:

```dotenv
VITE_API_URL=http://localhost:4000
```

### 3. Ingest data

```bash
cd backend

# Windows CMD
set DATA_DIR=.\SAP Order-to-Cash-dataset
node src/ingest.js

# macOS / Linux
DATA_DIR=./SAP\ Order-to-Cash-dataset node src/ingest.js
```

Expected output:

```
[ingest:init] Found 49 JSONL file(s) under: ...
[ingest:init] Loaded 21,393 total rows from 49 files
...
[ingest:done] Ingestion complete. {"elapsed":"72.8s","processed":5013,"errors":"none"}
```

### 4. Start backend

```bash
cd backend
npm run dev
# Server running on http://localhost:4000
```

### 5. Start frontend

```bash
cd frontend
npm run dev
# App running on http://localhost:5173
```

---

## Deployment

### Backend → Railway

1. Push to GitHub
2. [railway.app](https://railway.app) → New Project → Deploy from GitHub → select `backend/`
3. Set Start Command: `node src/server.js`
4. Add environment variables in Railway dashboard:

```dotenv
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USER=<auradb-username>
NEO4J_PASS=<auradb-password>
NEO4J_DATABASE=<auradb-database>
OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxxxxxx
NODE_ENV=production
ALLOWED_ORIGINS=https://your-app.vercel.app
NEO4J_QUERY_TIMEOUT_MS=120000
```

### Database → Neo4j AuraDB

1. [console.neo4j.io](https://console.neo4j.io) → Create Free Instance
2. Wait 60 seconds for the instance to boot
3. Re-run ingest pointed at AuraDB (Windows CMD):

```cmd
set NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
set NEO4J_USER=<auradb-username>
set NEO4J_PASS=<auradb-password>
set NEO4J_DATABASE=<auradb-database>
set DATA_DIR=.\SAP Order-to-Cash-dataset
node src/ingest.js
```

### Frontend → Vercel

1. [vercel.com](https://vercel.com) → New Project → Import from GitHub → select `frontend/`
2. Framework Preset: **Vite** (auto-detected)
3. Add environment variable:

```dotenv
VITE_API_URL=https://your-app.railway.app
```

4. Deploy

#### One code change required before deploying frontend

In `frontend/src/components/Chat.jsx` line 3, change:

```js
// Before
const API_URL = "http://localhost:4000";

// After
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
```

This is the only code change needed for deployment. Everything else reads from environment variables.

---

## Environment Variables Reference

### Backend

| Variable | Required | Default | Description |
|---|---|---|---|
| `NEO4J_URI` | ✅ | — | Neo4j connection URI |
| `NEO4J_USER` | ✅ | — | Neo4j username |
| `NEO4J_PASS` | ✅ | — | Neo4j password |
| `NEO4J_DATABASE` | — | `neo4j` | Database name (required for AuraDB) |
| `OPENROUTER_API_KEY` | ✅ | — | OpenRouter API key |
| `PORT` | — | `4000` | HTTP port |
| `NODE_ENV` | — | `development` | `production` hides Cypher from responses |
| `ALLOWED_ORIGINS` | — | `*` | Comma-separated CORS allowed origins |
| `NEO4J_QUERY_TIMEOUT_MS` | — | `120000` | Neo4j query timeout in ms |
| `NEO4J_CONN_TIMEOUT` | — | `5000` | TCP connection timeout in ms |
| `NEO4J_ACQUIRE_TIMEOUT` | — | `30000` | Pool acquisition timeout in ms |
| `NEO4J_POOL_SIZE` | — | `50` | Max connection pool size |
| `INGEST_BATCH_SIZE` | — | `500` | Rows per Neo4j transaction during ingest |
| `DATA_DIR` | — | `../SAP Order-to-Cash-dataset` | Path to JSONL dataset |
| `LLM_MODEL` | — | — | Override model (bypasses fallback chain) |

### Frontend

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_API_URL` | ✅ (prod) | `http://localhost:4000` | Backend API URL |

---

## API Reference

### `POST /query`

Converts a natural language question to Cypher, executes it, and returns structured results.

**Request:**
```json
{ "question": "Top 10 highest-value sales orders" }
```

**Response:**
```json
{
  "explanation": "Lists the ten sales orders with the highest net amount.",
  "data": [
    { "orderId": "740506", "netAmount": 17108.25, "orderDate": "2025-03-31" }
  ],
  "count": 10,
  "truncated": false,
  "elapsed_ms": 843,
  "query": "MATCH (c:Customer)-[:PLACED]->..."  // dev mode only
}
```

**Error responses:**

| HTTP | `type` | Meaning |
|---|---|---|
| 400 | `guardrail` | Question not related to O2C data |
| 400 | `input_validation` | Missing or empty question |
| 400 | `validation` | Generated Cypher failed schema check |
| 502 | `llm_error` | All LLM models failed |
| 500 | `execution_error` | Neo4j query failed |

### `GET /health`

```json
{ "status": "ok", "db": "connected", "timestamp": "2026-03-23T09:00:00.000Z" }
```

---

## Example Queries

| Question | What it returns |
|---|---|
| `Show all customers and their sales orders` | Customer names with order IDs, amounts, dates |
| `Total revenue from non-cancelled invoices` | Single sum in INR |
| `Which customers have unpaid billing documents?` | Customers with outstanding invoices |
| `Top 10 highest-value sales orders` | Orders ranked by net amount |
| `List all products with their order counts` | Products with total qty and revenue |
| `Show the full O2C path for customer 320000083` | Complete chain from order to payment |
| `Which plants store the most products?` | Plants ranked by product count |
| `Show all blocked customers` | Customers with blocked=true |
| `Revenue by customer this fiscal year` | Sum per customer |

---

## Security

- **Read-only enforcement** — write keywords (`CREATE`, `MERGE`, `SET`, `DELETE`, `DROP`, etc.) are blocked at the validator layer before any query reaches Neo4j
- **Schema allowlist** — only the 8 defined node labels and 8 relationship types are permitted; any hallucinated identifier is rejected
- **Injection protection** — the guardrails layer blocks prompt injection patterns before the LLM is called
- **Domain filtering** — queries unrelated to SAP O2C are rejected before spending any LLM tokens
- **No credentials in responses** — the `query` field (generated Cypher) is only included in `NODE_ENV=development` responses

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m 'Add your feature'`
4. Push: `git push origin feature/your-feature`
5. Open a Pull Request

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Acknowledgements

- [Neo4j](https://neo4j.com) — graph database
- [React Flow](https://reactflow.dev) — graph visualisation
- [OpenRouter](https://openrouter.ai) — LLM API aggregator
- [Railway](https://railway.app) — backend hosting
- [Vercel](https://vercel.com) — frontend hosting
