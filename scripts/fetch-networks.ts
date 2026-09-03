/**
 * scripts/fetch-networks.ts
 *
 * Builds the foreign-network train shards from public GTFS feeds — Deutsche Bahn
 * long-distance, SNCB/NMBS (Belgium), CFL (Luxembourg) and NS (Netherlands) — into
 * the same compact per-day format the SNCF paid shards use, so the app's search runs
 * over one merged pool with no per-operator code.
 *
 * Run via: npm run fetch-networks  (tsx scripts/fetch-networks.ts [network-id …])
 *
 * ## Why it is shaped like this
 *
 * A GTFS feed describes trips over a service calendar; the app wants "trains from A
 * to B on date D". Turning one into the other is three problems:
 *
 *  1. **Volume.** Expanding every trip into all its origin→destination pairs is
 *     quadratic in stops. Unrestricted, DB alone is ~10 MB gzipped a month and the
 *     Dutch feed ten times that. So pairs are emitted only between ALLOWLISTED
 *     stations — the busiest ones plus every crosswalk interchange — which keeps a
 *     day near the ~100 KB the SNCF shards cost.
 *  2. **Size on disk.** The Dutch feed is 208 MB zipped and its stop_times.txt near a
 *     gigabyte, so nothing is ever read whole: the zip is streamed twice, once for
 *     the small files and once to filter stop_times against the trips we kept.
 *  3. **Station identity.** A cross-border journey only exists if both feeds name the
 *     interchange identically — see data/crosswalk.json.
 *
 * Output per network, all gitignored and rebuilt by the deploy:
 *   public/data/<id>/<YYYY-MM-DD>.json  compact day shards
 *   public/data/<id>/index.json         the days that exist
 *   public/data/<id>/stations.json      coordinates, straight from the feed's stops
 */

import * as fs from "fs";
import * as path from "path";
import { Unzip, UnzipInflate } from "fflate";
import { encodeShard, type EncodableTrain } from "../src/data/shard";
import {
  buildCrosswalk,
  canonicalStationId,
  parseGtfsTime,
  splitCsvLine,
} from "../src/data/gtfs";

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

interface Network {
  /** Profile id — also the output directory name. */
  id: string;
  operator: string;
  country: string;
  /** Human-readable source + licence, recorded in the index for attribution. */
  source: string;
  /** Static feed URL, or a resolver for feeds published at dated URLs. */
  url?: string;
  resolveUrl?: () => Promise<string>;
  /**
   * How many of the feed's busiest stations to keep. Every crosswalk station is kept
   * regardless. Tuned so a day's shard stays around 100 KB: raising it grows output
   * quadratically, so change it with the printed stats in hand.
   */
  topStations: number;
  /**
   * GTFS route_type values to keep. 2 is rail; 100-117 are the "extended" rail types
   * the Belgian and Dutch feeds use, and omitting them would silently drop everything.
   */
  routeTypes?: number[];
}

const RAIL_TYPES = [2, ...Array.from({ length: 18 }, (_, i) => 100 + i)];

const NETWORKS: Network[] = [
  {
    id: "db-fernverkehr",
    operator: "DB",
    country: "DE",
    source: "gtfs.de — DB Fernverkehr (DELFI e.V., CC-BY 4.0)",
    url: "https://download.gtfs.de/germany/fv_free/latest.zip",
    topStations: 50,
  },
  {
    id: "sncb",
    operator: "SNCB",
    country: "BE",
    source: "iRail / NMBS-SNCB GTFS (Licence Ouverte)",
    url: "https://gtfs.irail.be/nmbs/gtfs/latest.zip",
    // Belgium runs a dense clock-face service over a small area, so all-pairs grows
    // fast here: a wider list costs far more per day than it does in Germany.
    topStations: 32,
  },
  {
    id: "cfl",
    operator: "CFL",
    country: "LU",
    source: "data.public.lu — Horaires et arrêts des transports publics (CC0)",
    resolveUrl: resolveLuxembourgFeed,
    topStations: 25,
    routeTypes: RAIL_TYPES,
  },
  {
    id: "ns",
    operator: "NS",
    country: "NL",
    source: "OVapi — GTFS Netherlands (CC-BY 4.0)",
    url: "https://gtfs.ovapi.nl/nl/gtfs-nl.zip",
    topStations: 32,
    routeTypes: RAIL_TYPES,
  },
];

/** Luxembourg publishes each release at its own dated URL, so resolve it each run. */
async function resolveLuxembourgFeed(): Promise<string> {
  const res = await fetch("https://data.public.lu/api/1/datasets/?q=GTFS", {
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json()) as {
    data?: { title?: string; resources?: { title?: string; url?: string }[] }[];
  };
  for (const ds of body.data ?? []) {
    if (!/GTFS/i.test(ds.title ?? "")) continue;
    // Resources are newest-first; take the first .zip.
    const zip = (ds.resources ?? []).find((res) => (res.url ?? "").endsWith(".zip"));
    if (zip?.url) return zip.url;
  }
  throw new Error("no GTFS zip found in the data.public.lu dataset listing");
}

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
const OUT_ROOT = path.resolve(REPO_ROOT, "public", "data");
const CROSSWALK_PATH = path.resolve(REPO_ROOT, "data", "crosswalk.json");
const CACHE_DIR = path.resolve(REPO_ROOT, ".gtfs-cache");
/** Days ahead to expand the service calendar over — matches the app's booking window. */
const WINDOW_DAYS = 30;
/** Ignore absurd legs (bad data, or a pair that is really two separate services). */
const MAX_LEG_MIN = 24 * 60;
/** How many of a network's busiest stations to publish as interchange hubs. */
const HUBS_PER_NETWORK = 12;

// ---------------------------------------------------------------------------
// Station naming
// ---------------------------------------------------------------------------

interface Crosswalk {
  /** normalized feed name → canonical station id */
  byName: Map<string, string>;
}

function loadCrosswalk(): Crosswalk {
  const raw = JSON.parse(fs.readFileSync(CROSSWALK_PATH, "utf-8")) as Record<string, unknown>;
  return { byName: buildCrosswalk(raw) };
}

// ---------------------------------------------------------------------------
// GTFS helpers
// ---------------------------------------------------------------------------

/** "YYYY-MM-DD" → "YYYYMMDD". */
const plainDate = (d: string): string => d.replace(/-/g, "");

// ---------------------------------------------------------------------------
// Streaming zip reader
// ---------------------------------------------------------------------------

/** Read a column out of the current CSV row; an absent column reads as "". */
type GtfsColumn = (name: string) => string;

/**
 * Stream selected entries out of a zip on disk, delivering one CSV row at a time as
 * a column getter.
 *
 * Nothing is buffered beyond a single line, because the Dutch feed's stop_times.txt
 * is close to a gigabyte uncompressed — reading it whole would exhaust memory on a
 * CI runner. Returns once the whole archive has been walked.
 */
async function streamZipCsv(
  zipPath: string,
  wanted: Set<string>,
  onRow: (file: string, col: GtfsColumn) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Per-entry parse state: the header, plus the tail of the last chunk that did not
    // end on a newline.
    const state = new Map<string, { columns: Map<string, number> | null; carry: string }>();
    const decoder = new TextDecoder("utf-8");

    const consume = (file: string, text: string, final: boolean): void => {
      const st = state.get(file);
      if (!st) return;
      const buf = st.carry + text;
      const lines = buf.split(/\r?\n/);
      // Unless this is the last chunk, the final piece may be a partial line.
      st.carry = final ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line) continue;
        const cells = splitCsvLine(line);
        if (!st.columns) {
          // Strip a UTF-8 BOM, which several feeds ship on the first header cell.
          st.columns = new Map(
            cells.map((c, i) => [(i === 0 ? c.replace(/^﻿/, "") : c).trim(), i] as const),
          );
          continue;
        }
        const columns = st.columns;
        // A getter rather than a materialised object: the Dutch feed has millions of
        // stop_times rows and almost all are discarded, so building an object per row
        // would be pure waste. It also types cleanly — an absent column reads as "".
        onRow(file, (col) => {
          const i = columns.get(col);
          return i === undefined ? "" : (cells[i] ?? "");
        });
      }
    };

    const unzip = new Unzip((stream) => {
      const name = stream.name.split("/").pop() ?? stream.name;
      if (!wanted.has(name)) return; // never even inflate what we don't need
      state.set(name, { columns: null, carry: "" });
      stream.ondata = (err, chunk, final): void => {
        if (err) {
          reject(err);
          return;
        }
        consume(name, decoder.decode(chunk, { stream: !final }), final);
      };
      stream.start();
    });
    unzip.register(UnzipInflate);

    const rs = fs.createReadStream(zipPath, { highWaterMark: 1 << 20 });
    rs.on("data", (chunk) => {
      try {
        unzip.push(new Uint8Array(chunk as Buffer), false);
      } catch (err) {
        rs.destroy();
        reject(err);
      }
    });
    rs.on("end", () => {
      try {
        unzip.push(new Uint8Array(0), true);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    rs.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function download(url: string, dest: string): Promise<void> {
  console.log(`  fetching ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(20 * 60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error("empty response body");
  // Stream to disk: these archives reach 200 MB and must not be held in memory.
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!out.write(Buffer.from(value))) {
      await new Promise<void>((r) => out.once("drain", () => r()));
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });
  console.log(`  downloaded ${(fs.statSync(dest).size / 1_048_576).toFixed(1)} MB`);
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * One physical station: every platform row that folds into it, the names those rows
 * use, and a position.
 *
 * The names matter more than they look. A feed's PARENT row often carries the
 * regional-transport name while the platforms carry the clean rail one — DB has
 * "S+U Berlin Hauptbahnhof" as the parent of eight platforms all called "Berlin Hbf",
 * and "Frankfurt (Main) Hauptbahnhof" beside "Frankfurt(Main)Hbf". Naming a station
 * after its parent therefore loses the busiest stations in the country to the
 * crosswalk. So every name is counted and the most-used one wins.
 */
interface StopInfo {
  names: Map<string, number>;
  lat: number;
  lon: number;
}

/**
 * The name to call a station: the one most of its rows use, and on a tie the shortest
 * — which reliably prefers "Hamburg Hbf" over "Hamburg, Hamburg Hbf" and
 * "Frankfurt(Main)Hbf" over "Frankfurt (Main) Hauptbahnhof".
 */
function bestName(info: StopInfo): string {
  let best = "";
  let bestCount = -1;
  for (const [name, count] of info.names) {
    if (count > bestCount || (count === bestCount && name.length < best.length)) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

interface TripStop {
  stopId: string;
  arr: number;
  dep: number;
  seq: number;
}

interface ConvertStats {
  trips: number;
  stations: number;
  pairs: number;
  days: number;
  bytes: number;
}

async function convert(net: Network, zipPath: string, cw: Crosswalk, today: string): Promise<ConvertStats> {
  const railTypes = new Set(net.routeTypes ?? [2]);

  // --- pass 1: the small files -------------------------------------------------
  const stops = new Map<string, StopInfo>();
  /** stop_id → the parent station's stop_id, so platforms fold into their station. */
  const parentOf = new Map<string, string>();
  const railRoutes = new Set<string>();
  const tripRoute = new Map<string, string>();
  const tripService = new Map<string, string>();
  /**
   * route_id → the label a traveller would recognise ("ICE", "S61", "TRN"). The
   * route_id itself is an opaque key like "gr:nmbssncb:791", which is useless in the
   * UI and needlessly long in the shard.
   */
  const routeLabel = new Map<string, string>();
  /**
   * trip_id → the printed train number. Feeds that publish trip_short_name give the
   * number a traveller actually looks for on the board; the trip_id is a fallback and
   * can be 50+ characters, so it is never preferred.
   */
  const tripNumber = new Map<string, string>();
  /** service_id → weekday bitmask + range, from calendar.txt. */
  const services = new Map<string, { days: boolean[]; start: string; end: string }>();
  /** service_id → date → added(true)/removed(false), from calendar_dates.txt. */
  const exceptions = new Map<string, Map<string, boolean>>();

  await streamZipCsv(
    zipPath,
    new Set(["stops.txt", "routes.txt", "trips.txt", "calendar.txt", "calendar_dates.txt"]),
    (file, c) => {
      if (file === "stops.txt") {
        const id = c("stop_id");
        if (!id) return;
        const lat = Number(c("stop_lat"));
        const lon = Number(c("stop_lon"));
        if (c("parent_station")) parentOf.set(id, c("parent_station"));
        if (!c("stop_name") || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
        // Platforms fold onto their parent, so a station is one node however many
        // tracks it has.
        const key = c("parent_station") || id;
        let info = stops.get(key);
        if (!info) {
          info = { names: new Map(), lat, lon };
          stops.set(key, info);
        }
        info.names.set(c("stop_name"), (info.names.get(c("stop_name")) ?? 0) + 1);
      } else if (file === "routes.txt") {
        if (railTypes.has(Number(c("route_type")))) {
          railRoutes.add(c("route_id"));
          const label = c("route_short_name") || c("route_long_name");
          if (label) routeLabel.set(c("route_id"), label);
        }
      } else if (file === "trips.txt") {
        tripRoute.set(c("trip_id"), c("route_id"));
        tripService.set(c("trip_id"), c("service_id"));
        const short = c("trip_short_name");
        if (short) tripNumber.set(c("trip_id"), short);
      } else if (file === "calendar.txt") {
        services.set(c("service_id"), {
          days: [c("sunday"), c("monday"), c("tuesday"), c("wednesday"), c("thursday"), c("friday"), c("saturday")].map((d) => d === "1"),
          start: c("start_date"),
          end: c("end_date"),
        });
      } else if (file === "calendar_dates.txt") {
        let m = exceptions.get(c("service_id"));
        if (!m) {
          m = new Map();
          exceptions.set(c("service_id"), m);
        }
        m.set(c("date"), c("exception_type") === "1");
      }
    },
  );

  // Trips we care about: rail routes only.
  const railTrips = new Set<string>();
  for (const [trip, route] of tripRoute) {
    if (railRoutes.has(route)) railTrips.add(trip);
  }
  console.log(`  ${stops.size} stops, ${railRoutes.size} rail routes, ${railTrips.size} rail trips`);
  if (railTrips.size === 0) throw new Error("no rail trips found — check routeTypes for this feed");

  // --- pass 2: stop_times for those trips only ---------------------------------
  const tripStops = new Map<string, TripStop[]>();
  /** How many trips call at each canonical station — the allowlist ranking. */
  const callCount = new Map<string, number>();

  /** Fold a platform onto its parent station, so all of a station's stops are one id. */
  const stationOf = (stopId: string): string => parentOf.get(stopId) ?? stopId;

  await streamZipCsv(zipPath, new Set(["stop_times.txt"]), (_file, c) => {
    if (!railTrips.has(c("trip_id"))) return;
    const arr = parseGtfsTime(c("arrival_time") || c("departure_time"));
    const dep = parseGtfsTime(c("departure_time") || c("arrival_time"));
    if (Number.isNaN(arr) || Number.isNaN(dep)) return;
    const station = stationOf(c("stop_id"));
    if (!stops.has(station) && !stops.has(c("stop_id"))) return;
    let list = tripStops.get(c("trip_id"));
    if (!list) {
      list = [];
      tripStops.set(c("trip_id"), list);
    }
    list.push({ stopId: stops.has(station) ? station : c("stop_id"), arr, dep, seq: Number(c("stop_sequence")) });
  });

  for (const list of tripStops.values()) {
    list.sort((a, b) => a.seq - b.seq);
    // Count each station once per trip, not once per call.
    const seen = new Set<string>();
    for (const s of list) {
      const info = stops.get(s.stopId);
      if (!info) continue;
      const id = canonicalStationId(bestName(info), cw.byName);
      if (seen.has(id)) continue;
      seen.add(id);
      callCount.set(id, (callCount.get(id) ?? 0) + 1);
    }
  }

  // --- the allowlist -----------------------------------------------------------
  // Busiest stations, plus every crosswalk interchange this feed actually serves —
  // those are the whole point of the exercise and must never be ranked out.
  const ranked = [...callCount.entries()].sort((a, b) => b[1] - a[1]);
  const allow = new Set(ranked.slice(0, net.topStations).map(([id]) => id));
  for (const id of callCount.keys()) {
    if ([...cw.byName.values()].includes(id)) allow.add(id);
  }

  // --- service calendar --------------------------------------------------------
  const windowDates: string[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    windowDates.push(new Date(Date.parse(`${today}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  }

  /** Does `service` run on `date` ("YYYY-MM-DD")? */
  const runsOn = (service: string, date: string): boolean => {
    const plain = plainDate(date);
    const ex = exceptions.get(service)?.get(plain);
    if (ex !== undefined) return ex; // an explicit exception always wins
    const cal = services.get(service);
    if (!cal) return false;
    if (plain < cal.start || plain > cal.end) return false;
    return cal.days[new Date(`${date}T00:00:00Z`).getUTCDay()] === true;
  };

  // --- emit --------------------------------------------------------------------
  const outDir = path.join(OUT_ROOT, net.id);
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) {
    if (f.endsWith(".json")) fs.unlinkSync(path.join(outDir, f));
  }

  // Coordinates for every allowlisted station, so foreign results reach the map.
  const stationOut = new Map<string, { id: string; label: string; lat: number; lng: number; country: string }>();
  for (const info of stops.values()) {
    const name = bestName(info);
    const id = canonicalStationId(name, cw.byName);
    if (!allow.has(id) || stationOut.has(id)) continue;
    stationOut.set(id, {
      id,
      // Drop the country tag from the display label — the country field carries it.
      label: name.replace(/\s*\((?:[A-Za-z]{2,3})\)\s*$/, "").trim(),
      lat: info.lat,
      lng: info.lon,
      country: net.country,
    });
  }

  const days: { date: string; count: number }[] = [];
  let bytes = 0;
  let pairTotal = 0;

  for (const date of windowDates) {
    const trains: EncodableTrain[] = [];
    for (const [tripId, list] of tripStops) {
      const service = tripService.get(tripId);
      if (!service || !runsOn(service, date)) continue;
      // Only the allowlisted calls, in order — pairs are drawn from these.
      const calls: { id: string; arr: number; dep: number }[] = [];
      for (const s of list) {
        const info = stops.get(s.stopId);
        if (!info) continue;
        const id = canonicalStationId(bestName(info), cw.byName);
        if (!allow.has(id)) continue;
        // A trip can call twice at one canonical id (a city aggregate); keep the first.
        if (calls.length && calls[calls.length - 1]?.id === id) continue;
        calls.push({ id, arr: s.arr, dep: s.dep });
      }
      const routeId = tripRoute.get(tripId) ?? "";
      const category = routeLabel.get(routeId) ?? "";
      const trainNo = tripNumber.get(tripId) ?? tripId;
      for (let i = 0; i < calls.length; i++) {
        for (let j = i + 1; j < calls.length; j++) {
          const from = calls[i];
          const to = calls[j];
          if (!from || !to || from.id === to.id) continue;
          const departMin = from.dep;
          const arriveMin = to.arr;
          const dur = arriveMin - departMin;
          if (dur <= 0 || dur > MAX_LEG_MIN) continue;
          trains.push({
            origin: from.id,
            destination: to.id,
            departMin,
            arriveMin,
            trainNo,
            ...(category ? { category } : {}),
          });
        }
      }
    }
    if (trains.length === 0) continue;
    pairTotal += trains.length;
    const shard = encodeShard(date, trains, {
      source: net.id,
      operator: net.operator,
      // No foreign network has a MAX seat, so every one of these trains is paid.
      free: false,
    });
    const json = JSON.stringify(shard);
    fs.writeFileSync(path.join(outDir, `${date}.json`), json, "utf-8");
    bytes += json.length;
    days.push({ date, count: trains.length });
  }

  // The network's interchanges, published with the data rather than hardcoded in the
  // app: the connection search only ever changes trains at a hub, so a foreign network
  // with no hubs would yield direct trains and nothing else. Ranking by how many trips
  // call there picks out exactly the interchange stations, and keeps doing so as the
  // feed changes.
  const hubs = ranked
    .filter(([id]) => allow.has(id))
    .slice(0, HUBS_PER_NETWORK)
    .map(([id]) => id);

  fs.writeFileSync(
    path.join(outDir, "index.json"),
    JSON.stringify({
      v: 1,
      source: net.id,
      operator: net.operator,
      country: net.country,
      attribution: net.source,
      updatedAt: new Date().toISOString(),
      hubs,
      days,
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(outDir, "stations.json"), JSON.stringify([...stationOut.values()]), "utf-8");

  return { trips: tripStops.size, stations: allow.size, pairs: pairTotal, days: days.length, bytes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const selected = only.length ? NETWORKS.filter((n) => only.includes(n.id)) : NETWORKS;
  if (selected.length === 0) {
    console.error(`[fetch-networks] no such network. Known: ${NETWORKS.map((n) => n.id).join(", ")}`);
    process.exit(1);
  }

  const cw = loadCrosswalk();
  const today = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  let failures = 0;
  for (const net of selected) {
    console.log(`\n[fetch-networks] ${net.id} (${net.operator}, ${net.country})`);
    try {
      const url = net.url ?? (await (net.resolveUrl as () => Promise<string>)());
      const zipPath = path.join(CACHE_DIR, `${net.id}.zip`);
      // Reuse a zip fetched in the last few hours, so iterating on the converter
      // doesn't re-download 200 MB each run.
      const fresh =
        fs.existsSync(zipPath) && Date.now() - fs.statSync(zipPath).mtimeMs < 6 * 3_600_000;
      if (fresh) console.log(`  using cached ${path.basename(zipPath)}`);
      else await download(url, zipPath);

      const stats = await convert(net, zipPath, cw, today);
      console.log(
        `  → ${stats.days} days, ${stats.stations} stations, ${stats.pairs} legs, ` +
          `${(stats.bytes / 1_048_576).toFixed(1)} MB (${(stats.bytes / Math.max(stats.days, 1) / 1024).toFixed(0)} KB/day)`,
      );
    } catch (err) {
      // One broken feed must not cost the others: the app treats a missing network as
      // simply unavailable, so keep going and report at the end.
      failures++;
      console.error(`  FAILED: ${String(err)}`);
    }
  }

  if (failures === selected.length) {
    console.error("[fetch-networks] every network failed.");
    process.exit(1);
  }
  console.log(`\n[fetch-networks] done (${selected.length - failures}/${selected.length} networks).`);
}

// Only run when invoked directly, so the tests can import the helpers above.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err: unknown) => {
    console.error("[fetch-networks] unexpected error:", err);
    process.exit(1);
  });
}
