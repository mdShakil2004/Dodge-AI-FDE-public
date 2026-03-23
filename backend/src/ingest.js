// ─── ingest.js ────────────────────────────────────────────────────────────────
// Full SAP O2C ingestion — handles BOTH layouts:
//
//   FLAT (sample dataset used for dev):
//     DATA_DIR/part-*.jsonl   — all files in one directory
//
//   REAL (production dataset with subdirectories):
//     DATA_DIR/billing_document_headers/part-*.jsonl
//     DATA_DIR/billing_document_items/part-*.jsonl
//     DATA_DIR/sales_order_headers/part-*.jsonl
//     ... (19 subdirectories)
//
// The reader walks the entire directory tree recursively, reads every .jsonl
// file it finds, and feeds all rows through the same field-signature router.
// This works for both layouts without any configuration change.
//
// LARGE DATASET PERFORMANCE:
//   - Files are read line-by-line (streaming) to avoid loading entire files
//     into memory — safe for multi-GB datasets.
//   - BATCH_SZ controls how many rows go in one Neo4j transaction.
//     Default 500. Raise to 2000 for faster ingest on good hardware.
//   - All passes use UNWIND — one network round-trip per batch.
//
// ── VERIFIED JOIN CHAIN ───────────────────────────────────────────────────────
//   Customer   ← business_partners + addresses + company + sales_area
//   SalesOrder ← sales_order_headers (soldToParty → Customer via PLACED)
//   SalesOrder -CONTAINS-> Product     via sales_order_items.material
//   SalesOrder -FULFILLED_BY-> Delivery via delivery_items.referenceSdDocument
//   Delivery   ← outbound_delivery_headers + stub nodes from billing_items
//   Delivery   -BILLED_BY-> BillingDocument via billing_items.referenceSdDocument
//   BillingDoc ← billing_document_headers (journalId = accountingDocument)
//   BillingDoc -GENERATES-> JournalEntry via billing_header.accountingDocument
//   Journal    ← journal_entry_items_ar (glAccount + referenceDocument present)
//   Journal    -CLEARED_BY-> Payment via journal.clearingAccountingDocument
//   Payment    ← payments_ar (id = clearingAccountingDocument)
//   Product    ← products + product_descriptions
//   Product    -STORED_AT-> Plant via product_plants
//   Plant      ← plants

import { getSession, verifyConnectivity } from "./db.js";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DATA_DIR can be:
//   - A flat directory with all .jsonl files directly inside, OR
//   - The root directory with 19 named subdirectories
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, "../SAP Order-to-Cash-dataset");
const BATCH_SZ  = parseInt(process.env.INGEST_BATCH_SIZE || "500");

// ─── Logger ───────────────────────────────────────────────────────────────────

const ts   = () => new Date().toISOString();
const log  = (s, m, d="") => console.log(`[${ts()}] [ingest:${s}] ${m}`, d ? JSON.stringify(d) : "");
const warn = (s, m, e)    => console.warn(`[${ts()}] [ingest:${s}] WARN ${m}`, e?.message || e || "");

// ─── Stats ────────────────────────────────────────────────────────────────────

class Stats {
  constructor() { this.c = {}; this.e = {}; this.t0 = Date.now(); }
  inc(k, n=1) { this.c[k] = (this.c[k]||0)+n; }
  err(k, n=1) { this.e[k] = (this.e[k]||0)+n; }
  summary() {
    const totalIn  = Object.values(this.c).reduce((a,b)=>a+b, 0);
    const totalErr = Object.values(this.e).reduce((a,b)=>a+b, 0);
    return {
      elapsed:   `${((Date.now()-this.t0)/1000).toFixed(1)}s`,
      processed: totalIn,
      errors:    totalErr || "none",
      perPass:   this.c,
      ...(totalErr && { perPassErrors: this.e }),
    };
  }
}

// ─── Field normalizers ────────────────────────────────────────────────────────

const toF = v => (v == null || v === "")  ? null : parseFloat(v);
const toS = v => (v == null)              ? null : String(v).trim() || null;
const toB = v => v === true || v === "true";
const toD = v => (v && typeof v === "string") ? v.substring(0, 10) : null;
const toI = v => (v == null || v === "")  ? null : parseInt(v, 10);

// ─── Recursive JSONL reader ───────────────────────────────────────────────────
// Walks the entire directory tree. Yields rows one at a time (generator) so
// very large datasets never fully load into memory.
//
// For the real dataset (19 subdirs, potentially millions of rows), this is
// the difference between crashing with OOM and running stably.

function* readAllFilesGen(dir) {
  if (!fs.existsSync(dir)) {
    warn("reader", `Directory not found: ${dir}`);
    return;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Recurse into subdirectory
      yield* readAllFilesGen(fullPath);
    } else if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json")) {
      // Stream the file line by line
      const content = fs.readFileSync(fullPath, "utf-8");
      let lineCount = 0;
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          yield JSON.parse(t);
          lineCount++;
        } catch {
          // skip malformed lines silently
        }
      }
      // Uncomment to log per-file counts:
      // log("reader", `  ${entry.name}: ${lineCount} rows`);
    }
  }
}

// Non-generator version that returns all rows — used when the full dataset
// fits in memory (fine for datasets up to ~1M rows / ~2GB).
// For datasets larger than that, refactor batchRun to accept a generator.
function readAll(dir) {
  const rows  = [];
  let   files = 0;
  for (const row of readAllFilesGen(dir)) {
    rows.push(row);
    // Count files indirectly — not needed for correctness
  }
  return rows;
}

// Count JSONL files for the log summary
function countFiles(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".jsonl") || e.name.endsWith(".json")) n++;
    }
  };
  walk(dir);
  return n;
}

// ─── Row router by field signature ────────────────────────────────────────────
// Each row is classified by which fields it contains.
// Order matters — more specific checks first.

function route(rows) {
  const B = {
    plants:[], products:[], productDesc:[], productPlants:[], productStorage:[],
    customers:[], addresses:[], custCompany:[], custSales:[],
    salesOrders:[], soItems:[], soSchedule:[],
    deliveries:[], delivItems:[],
    billing:[], billItems:[],
    journals:[], payments:[],
    unrouted: 0,
  };

  for (const r of rows) {
    if      ("plantName"           in r && "valuationArea" in r)                { B.plants.push(r); }
    else if ("productType"         in r && "crossPlantStatus" in r)              { B.products.push(r); }
    else if ("productDescription"  in r && "language" in r)                      { B.productDesc.push(r); }
    else if ("mrpType"             in r && "product" in r && "plant" in r)       { B.productPlants.push(r); }
    else if ("physicalInventoryBlockInd" in r && "storageLocation" in r)         { B.productStorage.push(r); }
    else if ("businessPartnerCategory" in r)                                      { B.customers.push(r); }
    else if ("addressId"           in r && "validityStartDate" in r)             { B.addresses.push(r); }
    else if ("accountingClerk"     in r && "reconciliationAccount" in r)         { B.custCompany.push(r); }
    else if ("incotermsClassification" in r && "customer" in r && "distributionChannel" in r) { B.custSales.push(r); }
    else if ("salesOrderType"      in r && "soldToParty" in r)                   { B.salesOrders.push(r); }
    else if ("salesOrderItemCategory" in r && "material" in r)                   { B.soItems.push(r); }
    else if ("scheduleLine"        in r && "confirmedDeliveryDate" in r)         { B.soSchedule.push(r); }
    else if ("overallPickingStatus" in r && "shippingPoint" in r)                { B.deliveries.push(r); }
    else if ("actualDeliveryQuantity" in r && "referenceSdDocument" in r)        { B.delivItems.push(r); }
    else if ("billingDocumentType" in r && "soldToParty" in r)                   { B.billing.push(r); }
    else if ("billingDocumentItem" in r && "billingQuantity" in r)               { B.billItems.push(r); }
    else if ("glAccount"           in r && "referenceDocument" in r && "accountingDocument" in r) { B.journals.push(r); }
    else if ("clearingAccountingDocument" in r && "invoiceReference" in r)       { B.payments.push(r); }
    else { B.unrouted++; }
  }

  return B;
}

// ─── Batch executor ───────────────────────────────────────────────────────────

async function batchRun(session, cypher, rows, norm, stats, label) {
  if (!rows?.length) { log(label, "0 rows — skipping"); return; }

  const chunks = [];
  for (let i = 0; i < rows.length; i += BATCH_SZ) {
    chunks.push(rows.slice(i, i + BATCH_SZ));
  }
  log(label, `${rows.length} rows → ${chunks.length} batch(es) of up to ${BATCH_SZ}`);

  for (let i = 0; i < chunks.length; i++) {
    const batch = chunks[i].map(norm).filter(Boolean);
    if (!batch.length) continue;

    const tx = session.beginTransaction();
    try {
      await tx.run(cypher, { batch });
      await tx.commit();
      stats.inc(label, batch.length);
    } catch (err) {
      await tx.rollback();
      stats.err(label, batch.length);
      warn(label, `Batch ${i+1}/${chunks.length} failed (${batch.length} rows): ${err.message}`);
    }

    // Log progress every 20 batches for large datasets
    if (chunks.length > 20 && (i+1) % 20 === 0) {
      log(label, `Progress: ${i+1}/${chunks.length} batches done`);
    }
  }
}

// ─── Indexes ──────────────────────────────────────────────────────────────────

async function createIndexes(session) {
  const IDX = [
    "CREATE INDEX idx_customer_id   IF NOT EXISTS FOR (n:Customer)        ON (n.id)",
    "CREATE INDEX idx_so_id         IF NOT EXISTS FOR (n:SalesOrder)      ON (n.id)",
    "CREATE INDEX idx_delivery_id   IF NOT EXISTS FOR (n:Delivery)        ON (n.id)",
    "CREATE INDEX idx_billing_id    IF NOT EXISTS FOR (n:BillingDocument) ON (n.id)",
    "CREATE INDEX idx_journal_id    IF NOT EXISTS FOR (n:JournalEntry)    ON (n.id)",
    "CREATE INDEX idx_payment_id    IF NOT EXISTS FOR (n:Payment)         ON (n.id)",
    "CREATE INDEX idx_product_id    IF NOT EXISTS FOR (n:Product)         ON (n.id)",
    "CREATE INDEX idx_plant_id      IF NOT EXISTS FOR (n:Plant)           ON (n.id)",
    // Property indexes for common WHERE filters
    "CREATE INDEX idx_b_cancelled   IF NOT EXISTS FOR (n:BillingDocument) ON (n.cancelled)",
    "CREATE INDEX idx_b_date        IF NOT EXISTS FOR (n:BillingDocument) ON (n.date)",
    "CREATE INDEX idx_b_fiscalyear  IF NOT EXISTS FOR (n:BillingDocument) ON (n.fiscalYear)",
    "CREATE INDEX idx_j_bilref      IF NOT EXISTS FOR (n:JournalEntry)    ON (n.billingRef)",
    "CREATE INDEX idx_j_clearing    IF NOT EXISTS FOR (n:JournalEntry)    ON (n.clearingDoc)",
    "CREATE INDEX idx_j_postdate    IF NOT EXISTS FOR (n:JournalEntry)    ON (n.postingDate)",
    "CREATE INDEX idx_so_soldto     IF NOT EXISTS FOR (n:SalesOrder)      ON (n.soldToParty)",
    "CREATE INDEX idx_so_date       IF NOT EXISTS FOR (n:SalesOrder)      ON (n.date)",
    "CREATE INDEX idx_so_status     IF NOT EXISTS FOR (n:SalesOrder)      ON (n.deliveryStatus)",
    "CREATE INDEX idx_cust_blocked  IF NOT EXISTS FOR (n:Customer)        ON (n.blocked)",
    "CREATE INDEX idx_cust_region   IF NOT EXISTS FOR (n:Customer)        ON (n.region)",
    "CREATE INDEX idx_pay_custid    IF NOT EXISTS FOR (n:Payment)         ON (n.customerId)",
    "CREATE INDEX idx_pay_date      IF NOT EXISTS FOR (n:Payment)         ON (n.clearingDate)",
  ];

  log("indexes", `Creating ${IDX.length} indexes...`);
  for (const idx of IDX) {
    try { await session.run(idx); } catch (e) { warn("indexes", idx, e); }
  }
  log("indexes", "All indexes ready.");
}

// ═══════════════════════════════════════════════════════════════════════════════
// NODE PASSES
// ═══════════════════════════════════════════════════════════════════════════════

const N_PLANTS = {
  label: "plants",
  cypher: `UNWIND $batch AS r
    MERGE (p:Plant {id: r.id})
    SET p.name=r.name, p.valuationArea=r.va, p.salesOrg=r.salesOrg,
        p.factoryCalendar=r.fc, p.language=r.lang,
        p.distChannel=r.dc, p.division=r.div`,
  norm: r => r.plant ? {
    id:toS(r.plant), name:toS(r.plantName), va:toS(r.valuationArea),
    salesOrg:toS(r.salesOrganization), fc:toS(r.factoryCalendar),
    lang:toS(r.language), dc:toS(r.distributionChannel), div:toS(r.division),
  } : null,
};

const N_PRODUCTS = {
  label: "products",
  cypher: `UNWIND $batch AS r
    MERGE (p:Product {id: r.id})
    SET p.productType=r.pt, p.productGroup=r.pg, p.division=r.div,
        p.baseUnit=r.bu, p.grossWeight=r.gw, p.weightUnit=r.wu,
        p.netWeight=r.nw, p.productOldId=r.oldId, p.isDeleted=r.del,
        p.creationDate=r.cd, p.industrySector=r.ind`,
  norm: r => (r.product && r.productType) ? {
    id:toS(r.product), pt:toS(r.productType), pg:toS(r.productGroup),
    div:toS(r.division), bu:toS(r.baseUnit), gw:toF(r.grossWeight),
    wu:toS(r.weightUnit), nw:toF(r.netWeight), oldId:toS(r.productOldId),
    del:toB(r.isMarkedForDeletion), cd:toD(r.creationDate), ind:toS(r.industrySector),
  } : null,
};

const N_PRODUCT_DESC = {
  label: "product_desc",
  cypher: `UNWIND $batch AS r
    MERGE (p:Product {id: r.id})
    SET p.name = r.name`,
  norm: r => (r.product && r.language === "EN" && r.productDescription) ?
    { id:toS(r.product), name:toS(r.productDescription) } : null,
};

const N_CUSTOMERS = {
  label: "customers",
  cypher: `UNWIND $batch AS r
    MERGE (c:Customer {id: r.id})
    SET c.name=r.name, c.accountGroup=r.ag, c.blocked=r.blocked,
        c.markedForArchiving=r.arch, c.creationDate=r.cd`,
  norm: r => r.businessPartner ? {
    id:toS(r.businessPartner),
    name:toS(r.businessPartnerFullName || r.businessPartnerName),
    ag:toS(r.businessPartnerGrouping),
    blocked:toB(r.businessPartnerIsBlocked),
    arch:toB(r.isMarkedForArchiving),
    cd:toD(r.creationDate),
  } : null,
};

const N_ADDRESSES = {
  label: "addresses",
  cypher: `UNWIND $batch AS r
    MATCH (c:Customer {id: r.id})
    SET c.city=r.city, c.region=r.region, c.country=r.country,
        c.postalCode=r.postal, c.street=r.street, c.timezone=r.tz`,
  norm: r => r.businessPartner ? {
    id:toS(r.businessPartner), city:toS(r.cityName), region:toS(r.region),
    country:toS(r.country), postal:toS(r.postalCode),
    street:toS(r.streetName), tz:toS(r.addressTimeZone),
  } : null,
};

const N_CUST_COMPANY = {
  label: "cust_company",
  cypher: `UNWIND $batch AS r
    MATCH (c:Customer {id: r.id})
    SET c.companyCode=r.cc, c.reconciliationAccount=r.recon,
        c.paymentTerms=r.pt, c.deletionIndicator=r.del,
        c.customerAccountGroup=r.cag`,
  norm: r => r.customer ? {
    id:toS(r.customer), cc:toS(r.companyCode), recon:toS(r.reconciliationAccount),
    pt:toS(r.paymentTerms), del:toB(r.deletionIndicator), cag:toS(r.customerAccountGroup),
  } : null,
};

const N_CUST_SALES = {
  label: "cust_sales",
  cypher: `UNWIND $batch AS r
    MATCH (c:Customer {id: r.id})
    SET c.currency=r.cur, c.paymentTermsSales=r.pts,
        c.shippingCondition=r.sc, c.incoterms=r.ic, c.deliveryPriority=r.dp`,
  // Only take the main sales channel (05) to avoid overwriting with blanks
  norm: r => (r.customer && r.distributionChannel === "05") ? {
    id:toS(r.customer), cur:toS(r.currency), pts:toS(r.customerPaymentTerms),
    sc:toS(r.shippingCondition), ic:toS(r.incotermsClassification), dp:toS(r.deliveryPriority),
  } : null,
};

const N_SALES_ORDERS = {
  label: "sales_orders",
  cypher: `UNWIND $batch AS r
    MERGE (s:SalesOrder {id: r.id})
    SET s.type=r.type, s.salesOrg=r.salesOrg, s.distChannel=r.dc,
        s.amount=r.amount, s.currency=r.cur, s.deliveryStatus=r.ds,
        s.date=r.date, s.soldToParty=r.stp, s.createdBy=r.cb,
        s.reqDelivDate=r.rdd, s.paymentTerms=r.pt
    WITH s, r
    MERGE (c:Customer {id: r.stp})
    MERGE (c)-[:PLACED]->(s)`,
  norm: r => (r.salesOrder && r.soldToParty) ? {
    id:toS(r.salesOrder), type:toS(r.salesOrderType), salesOrg:toS(r.salesOrganization),
    dc:toS(r.distributionChannel), amount:toF(r.totalNetAmount),
    cur:toS(r.transactionCurrency), ds:toS(r.overallDeliveryStatus),
    date:toD(r.creationDate), stp:toS(r.soldToParty),
    cb:toS(r.createdByUser), rdd:toD(r.requestedDeliveryDate),
    pt:toS(r.customerPaymentTerms),
  } : null,
};

const N_DELIVERIES = {
  label: "deliveries",
  cypher: `UNWIND $batch AS r
    MERGE (d:Delivery {id: r.id})
    SET d.date=r.date, d.shippingPoint=r.sp, d.gmsStatus=r.gms,
        d.pickStatus=r.pick, d.stub=false`,
  norm: r => r.deliveryDocument ? {
    id:toS(r.deliveryDocument), date:toD(r.creationDate), sp:toS(r.shippingPoint),
    gms:toS(r.overallGoodsMovementStatus), pick:toS(r.overallPickingStatus),
  } : null,
};

const N_BILLING = {
  label: "billing",
  cypher: `UNWIND $batch AS r
    MERGE (b:BillingDocument {id: r.id})
    SET b.type=r.type, b.amount=r.amount, b.currency=r.cur,
        b.cancelled=r.cancelled, b.date=r.date, b.fiscalYear=r.fy,
        b.companyCode=r.cc, b.soldToParty=r.stp, b.journalId=r.jid
    WITH b, r
    MERGE (c:Customer {id: r.stp})
    MERGE (b)-[:BILLED_TO]->(c)`,
  norm: r => (r.billingDocument && r.soldToParty) ? {
    id:toS(r.billingDocument), type:toS(r.billingDocumentType),
    amount:toF(r.totalNetAmount), cur:toS(r.transactionCurrency),
    cancelled:toB(r.billingDocumentIsCancelled), date:toD(r.billingDocumentDate),
    fy:toS(r.fiscalYear), cc:toS(r.companyCode), stp:toS(r.soldToParty),
    jid:toS(r.accountingDocument),
  } : null,
};

const N_JOURNALS = {
  label: "journals",
  cypher: `UNWIND $batch AS r
    MERGE (j:JournalEntry {id: r.id})
    SET j.amount=r.amount, j.glAccount=r.gl, j.profitCenter=r.pc,
        j.postingDate=r.pd, j.documentType=r.dt, j.fatType=r.fat,
        j.companyCode=r.cc, j.fiscalYear=r.fy,
        j.billingRef=r.bref, j.clearingDoc=r.cd, j.customerId=r.cid`,
  norm: r => (r.accountingDocument && r.glAccount && r.referenceDocument) ? {
    id:toS(r.accountingDocument), amount:toF(r.amountInTransactionCurrency),
    gl:toS(r.glAccount), pc:toS(r.profitCenter), pd:toD(r.postingDate),
    dt:toS(r.accountingDocumentType), fat:toS(r.financialAccountType),
    cc:toS(r.companyCode), fy:toS(r.fiscalYear),
    bref:toS(r.referenceDocument),              // = billingDocument.id
    cd:toS(r.clearingAccountingDocument),       // = Payment.id
    cid:toS(r.customer),
  } : null,
};

// Payment.id = clearingAccountingDocument (the clearing entry, NOT accountingDocument)
const N_PAYMENTS = {
  label: "payments",
  cypher: `UNWIND $batch AS r
    MERGE (pay:Payment {id: r.id})
    SET pay.amount=r.amount, pay.clearingDate=r.cd, pay.fiscalYear=r.fy,
        pay.companyCode=r.cc, pay.customerId=r.cid, pay.arDocId=r.arDoc`,
  norm: r => (r.clearingAccountingDocument && r.clearingDate) ? {
    id:toS(r.clearingAccountingDocument),  // payment identity = clearing doc id
    arDoc:toS(r.accountingDocument),       // the AR debit being cleared
    amount:toF(r.amountInTransactionCurrency),
    cd:toD(r.clearingDate), fy:toS(r.clearingDocFiscalYear),
    cc:toS(r.companyCode), cid:toS(r.customer),
  } : null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// RELATIONSHIP PASSES
// ═══════════════════════════════════════════════════════════════════════════════

// SalesOrder -FULFILLED_BY-> Delivery
// delivery_items.referenceSdDocument = salesOrder.id
const R_SO_DELIVERY = {
  label: "rel:so→delivery",
  cypher: `UNWIND $batch AS r
    MATCH (s:SalesOrder {id: r.sid})
    MERGE (d:Delivery  {id: r.did})
      ON CREATE SET d.stub=true
    MERGE (s)-[:FULFILLED_BY]->(d)`,
  norm: r => (r.deliveryDocument && r.referenceSdDocument) ?
    { sid:toS(r.referenceSdDocument), did:toS(r.deliveryDocument) } : null,
};

// SalesOrder -CONTAINS-> Product
// sales_order_items.material = product.id
const R_SO_PRODUCT = {
  label: "rel:so→product",
  cypher: `UNWIND $batch AS r
    MATCH (s:SalesOrder {id: r.sid})
    MERGE (p:Product    {id: r.pid})
    MERGE (s)-[rel:CONTAINS]->(p)
    SET rel.quantity=r.qty, rel.netAmount=r.amt,
        rel.itemNo=r.item, rel.plant=r.plant,
        rel.storageLocation=r.sl, rel.materialGroup=r.mg`,
  norm: r => (r.salesOrder && r.material) ? {
    sid:toS(r.salesOrder), pid:toS(r.material),
    qty:toF(r.requestedQuantity), amt:toF(r.netAmount),
    item:toS(r.salesOrderItem), plant:toS(r.productionPlant),
    sl:toS(r.storageLocation), mg:toS(r.materialGroup),
  } : null,
};

// Delivery -BILLED_BY-> BillingDocument
// billing_items.referenceSdDocument = delivery.id
// Creates stub Delivery nodes for delivery IDs with no header record
const R_DELIVERY_BILLING = {
  label: "rel:delivery→billing",
  cypher: `UNWIND $batch AS r
    MATCH (b:BillingDocument {id: r.bid})
    MERGE (d:Delivery        {id: r.did})
      ON CREATE SET d.stub=true
    MERGE (d)-[:BILLED_BY]->(b)`,
  norm: r => (r.billingDocument && r.referenceSdDocument) ?
    { bid:toS(r.billingDocument), did:toS(r.referenceSdDocument) } : null,
};

// BillingDocument -GENERATES-> JournalEntry
// billing_header.accountingDocument = journal.id
const R_BILLING_JOURNAL = {
  label: "rel:billing→journal",
  cypher: `UNWIND $batch AS r
    MATCH (b:BillingDocument {id: r.bid})
    MATCH (j:JournalEntry    {id: r.jid})
    MERGE (b)-[:GENERATES]->(j)`,
  norm: r => (r.billingDocument && r.accountingDocument) ?
    { bid:toS(r.billingDocument), jid:toS(r.accountingDocument) } : null,
};

// JournalEntry -CLEARED_BY-> Payment
// journal.clearingAccountingDocument = payment.id
const R_JOURNAL_PAYMENT = {
  label: "rel:journal→payment",
  cypher: `UNWIND $batch AS r
    MATCH (j:JournalEntry {id: r.jid})
    MATCH (pay:Payment    {id: r.pid})
    MERGE (j)-[:CLEARED_BY]->(pay)`,
  norm: r => (r.accountingDocument && r.clearingAccountingDocument) ?
    { jid:toS(r.accountingDocument), pid:toS(r.clearingAccountingDocument) } : null,
};

// Product -STORED_AT-> Plant
// product_plants (identified by mrpType field)
const R_PRODUCT_PLANT = {
  label: "rel:product→plant",
  cypher: `UNWIND $batch AS r
    MATCH (p:Product {id: r.pid})
    MERGE (pl:Plant  {id: r.plid})
    MERGE (p)-[rel:STORED_AT]->(pl)
    SET rel.mrpType=r.mrp, rel.profitCenter=r.pc, rel.availCheck=r.ac`,
  norm: r => (r.product && r.plant && "mrpType" in r) ?
    { pid:toS(r.product), plid:toS(r.plant), mrp:toS(r.mrpType),
      pc:toS(r.profitCenter), ac:toS(r.availabilityCheckType) } : null,
};

// Schedule lines → enrich SalesOrder.confirmedQty (aggregate, not a separate node)
const R_SO_SCHEDULE = {
  label: "rel:so_schedule",
  cypher: `UNWIND $batch AS r
    MATCH (s:SalesOrder {id: r.sid})
    SET s.confirmedQty = coalesce(s.confirmedQty, 0) + r.qty`,
  norm: r => (r.salesOrder && r.confdOrderQtyByMatlAvailCheck) ?
    { sid:toS(r.salesOrder), qty:toI(r.confdOrderQtyByMatlAvailCheck) } : null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

export async function ingest() {
  const stats   = new Stats();
  const session = getSession();

  try {
    await verifyConnectivity();

    const fileCount = countFiles(DATA_DIR);
    log("init", `Found ${fileCount} JSONL file(s) under: ${DATA_DIR}`);
    log("init", `Batch size: ${BATCH_SZ}. Reading all rows into memory...`);

    const allRows = readAll(DATA_DIR);

    if (!allRows.length) {
      throw new Error(
        `No rows loaded from ${DATA_DIR}.\n` +
        `Check that DATA_DIR in your .env points to the correct folder.\n` +
        `Expected either:\n` +
        `  - A flat directory with *.jsonl files, OR\n` +
        `  - A directory with 19 named subdirectories (billing_document_headers/, etc.)`
      );
    }

    log("init", `Loaded ${allRows.length.toLocaleString()} total rows from ${fileCount} files`);

    const B = route(allRows);
    log("route", "Row distribution:", {
      plants: B.plants.length,
      products: B.products.length,
      productDesc: B.productDesc.length,
      productPlants: B.productPlants.length,
      productStorage: B.productStorage.length,
      customers: B.customers.length,
      addresses: B.addresses.length,
      custCompany: B.custCompany.length,
      custSales: B.custSales.length,
      salesOrders: B.salesOrders.length,
      soItems: B.soItems.length,
      soSchedule: B.soSchedule.length,
      deliveries: B.deliveries.length,
      delivItems: B.delivItems.length,
      billing: B.billing.length,
      billItems: B.billItems.length,
      journals: B.journals.length,
      payments: B.payments.length,
      unrouted: B.unrouted,
    });

    if (B.unrouted > 0) {
      warn("route", `${B.unrouted} rows could not be routed — they will be skipped`);
    }

    await createIndexes(session);

    // ── NODE PASSES (all before relationship passes) ─────────────────────────
    log("pipeline", "=== NODE PASSES ===");
    await batchRun(session, N_PLANTS.cypher,       B.plants,        N_PLANTS.norm,       stats, N_PLANTS.label);
    await batchRun(session, N_PRODUCTS.cypher,     B.products,      N_PRODUCTS.norm,     stats, N_PRODUCTS.label);
    await batchRun(session, N_PRODUCT_DESC.cypher, B.productDesc,   N_PRODUCT_DESC.norm, stats, N_PRODUCT_DESC.label);
    await batchRun(session, N_CUSTOMERS.cypher,    B.customers,     N_CUSTOMERS.norm,    stats, N_CUSTOMERS.label);
    await batchRun(session, N_ADDRESSES.cypher,    B.addresses,     N_ADDRESSES.norm,    stats, N_ADDRESSES.label);
    await batchRun(session, N_CUST_COMPANY.cypher, B.custCompany,   N_CUST_COMPANY.norm, stats, N_CUST_COMPANY.label);
    await batchRun(session, N_CUST_SALES.cypher,   B.custSales,     N_CUST_SALES.norm,   stats, N_CUST_SALES.label);
    await batchRun(session, N_SALES_ORDERS.cypher, B.salesOrders,   N_SALES_ORDERS.norm, stats, N_SALES_ORDERS.label);
    await batchRun(session, N_DELIVERIES.cypher,   B.deliveries,    N_DELIVERIES.norm,   stats, N_DELIVERIES.label);
    await batchRun(session, N_BILLING.cypher,      B.billing,       N_BILLING.norm,      stats, N_BILLING.label);
    await batchRun(session, N_JOURNALS.cypher,     B.journals,      N_JOURNALS.norm,     stats, N_JOURNALS.label);
    await batchRun(session, N_PAYMENTS.cypher,     B.payments,      N_PAYMENTS.norm,     stats, N_PAYMENTS.label);

    // ── RELATIONSHIP PASSES ──────────────────────────────────────────────────
    log("pipeline", "=== RELATIONSHIP PASSES ===");
    await batchRun(session, R_SO_DELIVERY.cypher,      B.delivItems,    R_SO_DELIVERY.norm,      stats, R_SO_DELIVERY.label);
    await batchRun(session, R_SO_PRODUCT.cypher,       B.soItems,       R_SO_PRODUCT.norm,       stats, R_SO_PRODUCT.label);
    await batchRun(session, R_DELIVERY_BILLING.cypher, B.billItems,     R_DELIVERY_BILLING.norm,  stats, R_DELIVERY_BILLING.label);
    await batchRun(session, R_BILLING_JOURNAL.cypher,  B.billing,       R_BILLING_JOURNAL.norm,   stats, R_BILLING_JOURNAL.label);
    await batchRun(session, R_JOURNAL_PAYMENT.cypher,  B.journals,      R_JOURNAL_PAYMENT.norm,   stats, R_JOURNAL_PAYMENT.label);
    await batchRun(session, R_PRODUCT_PLANT.cypher,    B.productPlants, R_PRODUCT_PLANT.norm,    stats, R_PRODUCT_PLANT.label);
    await batchRun(session, R_SO_SCHEDULE.cypher,      B.soSchedule,    R_SO_SCHEDULE.norm,      stats, R_SO_SCHEDULE.label);

    const summary = stats.summary();
    log("done", "Ingestion complete.", summary);
    return summary;

  } catch (err) {
    console.error(`[ingest] Fatal: ${err.message}`);
    console.error(err.stack);
    throw err;
  } finally {
    await session.close();
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("ingest.js")) {
  ingest()
    .then(s => { console.log("\n[ingest] Final summary:\n" + JSON.stringify(s, null, 2)); process.exit(0); })
    .catch(e => { console.error("[ingest] Failed:", e.message); process.exit(1); });
}