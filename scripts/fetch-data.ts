/**
 * scripts/fetch-data.ts
 *
 * Downloads the full SNCF tgvmax dataset via the Opendatasoft Explore API v2.1
 * export endpoint and writes:
 *   data/tgvmax.json  – full mapped record array (compact JSON)
 *   data/meta.json    – freshness metadata
 *
 * Run via: npm run fetch-data  (tsx scripts/fetch-data.ts)
 */

// node-shims.d.ts in the same directory provides ambient declarations for
// fs, path, and process so we can import them without @types/node.
import * as fs from "fs";
import * as path from "path";
import { encodeShard, type EncodableTrain } from "../src/data/shard";
import { stationFileName } from "../src/data/stationShard";
import { parseTimeToMinutes } from "../src/util/time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MappedRecord {
  date: string;
  origine: string;
  destination: string;
  heure_depart: string;
  heure_arrivee: string;
  train_no: string;
  od_happy_card: string;
  axe?: string;
}

interface Meta {
  updatedAt: string;
  source: string;
  recordCount: number;
  isSample: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_URL =
  "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax/exports/json";
const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const REPO_ROOT = process.cwd();
const OUT_DATA = path.resolve(REPO_ROOT, "public", "data", "tgvmax.json");
const OUT_META = path.resolve(REPO_ROOT, "public", "data", "meta.json");
/**
 * Paid shards: SNCF trains that run but have no free MAX seat, one compact file per
 * date plus an index. Written for the "show paid trains" toggle, and deliberately
 * NOT committed (see .gitignore) — at ~322k trains a month they would bloat git
 * history permanently, so the deploy regenerates them each time.
 */
const OUT_PAID_DIR = path.resolve(REPO_ROOT, "public", "data", "paid");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url: string): Promise<unknown[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[fetch-data] Attempt ${attempt}/${MAX_RETRIES}: GET ${url}`);
      const response = await fetchWithTimeout(url, TIMEOUT_MS);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const data: unknown = await response.json();

      if (!Array.isArray(data)) {
        throw new Error(`Expected JSON array, got ${typeof data}`);
      }

      return data as unknown[];
    } catch (err) {
      lastError = err;
      const isAbort = err instanceof Error && err.name === "AbortError";
      const label = isAbort ? "timeout" : String(err);
      console.error(`[fetch-data] Attempt ${attempt} failed: ${label}`);

      if (attempt < MAX_RETRIES) {
        const backoffMs = 2_000 * attempt; // 2s, 4s
        console.log(`[fetch-data] Retrying in ${backoffMs / 1000}s…`);
        await sleep(backoffMs);
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapRecord(raw: Record<string, unknown>): MappedRecord {
  const rec: MappedRecord = {
    date: String(raw["date"] ?? ""),
    origine: String(raw["origine"] ?? ""),
    destination: String(raw["destination"] ?? ""),
    heure_depart: String(raw["heure_depart"] ?? ""),
    heure_arrivee: String(raw["heure_arrivee"] ?? ""),
    train_no: String(raw["train_no"] ?? ""),
    od_happy_card: String(raw["od_happy_card"] ?? ""),
  };
  if (raw["axe"] != null) {
    rec.axe = String(raw["axe"]);
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Paid shards
// ---------------------------------------------------------------------------

/**
 * Group the non-MAX records by date and write one compact shard per day, plus an
 * index the app reads to know which days exist. Best-effort: a failure here must not
 * fail the job, because the free snapshot — the thing the app actually needs — has
 * already been written by the time this runs.
 */
function writePaidShards(paid: MappedRecord[], updatedAt: string): void {
  const legs: EncodableTrain[] = [];
  let skipped = 0;
  for (const r of paid) {
    if (!r.date || !r.origine || !r.destination) continue;
    if (r.origine === r.destination) continue; // self-loops, as the app's normalizer drops
    const departMin = parseTimeToMinutes(r.heure_depart);
    let arriveMin = parseTimeToMinutes(r.heure_arrivee);
    if (Number.isNaN(departMin) || Number.isNaN(arriveMin)) {
      skipped++;
      continue;
    }
    if (arriveMin < departMin) arriveMin += 1440; // crosses midnight
    legs.push({
      date: r.date,
      origin: r.origine,
      destination: r.destination,
      departMin,
      arriveMin,
      trainNo: r.train_no,
      ...(r.axe ? { category: r.axe } : {}),
    });
  }

  // One file per station, holding every leg where it is the origin or the destination.
  // Same layout as the foreign networks, so the app has a single loading path — and so
  // an exact-trip search and its whole 30-day calendar cost two files, not a month of
  // the entire country.
  const byStation = new Map<string, EncodableTrain[]>();
  for (const leg of legs) {
    for (const id of [leg.origin, leg.destination]) {
      const bucket = byStation.get(id);
      if (bucket) bucket.push(leg);
      else byStation.set(id, [leg]);
    }
  }

  fs.mkdirSync(OUT_PAID_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_PAID_DIR)) {
    const full = path.join(OUT_PAID_DIR, f);
    if (f.endsWith(".json")) fs.unlinkSync(full);
    else if (f === "s") fs.rmSync(full, { recursive: true, force: true });
  }
  const stationsDir = path.join(OUT_PAID_DIR, "s");
  fs.mkdirSync(stationsDir, { recursive: true });

  const counts: Record<string, number> = {};
  let bytes = 0;
  const dates = new Set<string>();
  for (const l of legs) dates.add(l.date);
  for (const [id, bucket] of byStation) {
    const shard = encodeShard(bucket, { source: "sncf-tgvmax", operator: "SNCF", free: false });
    const json = JSON.stringify(shard);
    fs.writeFileSync(path.join(stationsDir, stationFileName(id)), json, "utf-8");
    bytes += json.length;
    counts[id] = bucket.length;
  }

  const sorted = [...dates].sort();
  fs.writeFileSync(
    path.join(OUT_PAID_DIR, "index.json"),
    JSON.stringify({
      v: 2,
      source: "sncf-tgvmax",
      operator: "SNCF",
      country: "FR",
      updatedAt,
      from: sorted[0] ?? "",
      to: sorted[sorted.length - 1] ?? "",
      hubs: [],
      counts,
    }),
    "utf-8",
  );
  console.log(
    `[fetch-data] Wrote ${byStation.size} paid station files (${(bytes / 1_048_576).toFixed(0)} MB total` +
      `${skipped ? `, ${skipped} unparseable rows skipped` : ""}) → ${OUT_PAID_DIR}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[fetch-data] Starting SNCF tgvmax dataset download…");

  let rawArray: unknown[];
  try {
    rawArray = await fetchWithRetry(API_URL);
  } catch (err) {
    console.error("[fetch-data] All attempts failed. Not overwriting existing data.");
    console.error(err);
    process.exit(1);
  }

  if (rawArray.length === 0) {
    console.error("[fetch-data] Received empty array from API. Not overwriting existing data.");
    process.exit(1);
  }

  console.log(`[fetch-data] Downloaded ${rawArray.length} raw records. Mapping…`);

  const mapped: MappedRecord[] = rawArray.map((item) =>
    mapRecord(item as Record<string, unknown>)
  );

  // The app only ever shows reservable MAX seats, so drop the (huge) majority of
  // rows where od_happy_card !== "OUI". The full export is ~77 MB and ~90% of it
  // is unavailable trains the UI never displays — keeping it would make the
  // client download/parse a payload large enough to hang or crash mobile
  // browsers. Filtering here keeps the served snapshot ~6 MB.
  const records = mapped.filter((r) => r.od_happy_card.toUpperCase() === "OUI");
  console.log(
    `[fetch-data] Kept ${records.length} reservable (OUI) of ${mapped.length} mapped records.`,
  );

  // Never overwrite a good snapshot with nothing. If the OUI filter yields zero (an
  // upstream schema change, or a genuinely dry response that still passed the array
  // check), the whole 30-day window being empty is far more likely a fault than real
  // — keep yesterday's data instead of wiping the site down to the tiny sample.
  if (records.length === 0) {
    console.error("[fetch-data] Zero reservable (OUI) records after mapping. Not overwriting existing data.");
    process.exit(1);
  }

  const meta: Meta = {
    updatedAt: new Date().toISOString(),
    source: "SNCF Open Data — tgvmax (Licence Ouverte)",
    recordCount: records.length,
    isSample: false,
  };

  // Ensure data/ directory exists
  const dataDir = path.dirname(OUT_DATA);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  fs.writeFileSync(OUT_DATA, JSON.stringify(records), "utf-8");
  console.log(`[fetch-data] Wrote ${records.length} records → ${OUT_DATA}`);

  fs.writeFileSync(OUT_META, JSON.stringify(meta, null, 2), "utf-8");
  console.log(`[fetch-data] Wrote metadata → ${OUT_META}`);

  // Everything the app strictly needs is now on disk. The paid shards are an
  // enhancement behind a toggle, so a failure here is logged and swallowed rather
  // than failing the job and leaving the free snapshot uncommitted.
  try {
    const paid = mapped.filter((r) => r.od_happy_card.toUpperCase() !== "OUI");
    writePaidShards(paid, meta.updatedAt);
  } catch (err) {
    console.error("[fetch-data] Paid shard generation failed (the toggle will find no data):", err);
  }

  console.log(`[fetch-data] Done. updatedAt=${meta.updatedAt}`);
}

main().catch((err: unknown) => {
  console.error("[fetch-data] Unexpected error:", err);
  process.exit(1);
});
