import {
  DATA_URL,
  META_URL,
  PAID_SHARD_DIR,
  NETWORK_DATA_BASE,
  SNCF_API_URL,
  HUB_STATIONS,
  NON_BOOKABLE_PATTERNS,
} from "../config";

/**
 * A data-source PROFILE: everything about reading and judging ONE train dataset.
 *
 * The core (search / connections / calendar / tour) only ever sees the normalized
 * `MaxTrain` shape, so the SNCF-specifics live here at the edge. Adding another
 * operator later (Deutsche Bahn, Renfe, …) means supplying another profile — a
 * different field mapping and a different "is this seat bookable?" rule — without
 * touching the core. SNCF "tgvmax" is the default profile, and the app currently
 * ships only it (branding, the MAX pass, and the UI stay SNCF-specific for now).
 */
export interface DatasetProfile {
  /** Stable identifier, e.g. "sncf-tgvmax". */
  id: string;
  /** Operator label shown on result badges, e.g. "SNCF", "DB", "SNCB". */
  operator: string;
  /** ISO 3166-1 alpha-2 country the network is centred on ("FR", "DE", …). */
  country: string;
  /**
   * Base-relative snapshot + metadata URLs, for a source that publishes one whole
   * committed file. Absent for the shard-only foreign networks, which have no
   * snapshot — everything they offer arrives as day shards.
   */
  dataUrl?: string;
  metaUrl?: string;
  /** Base-relative station registry (id/label/lat/lng), for shard-only sources. */
  stationsUrl?: string;
  /**
   * Base-relative directory of this source's compact per-day shards (see
   * {@link file://./shard.ts}), or undefined when it has none. SNCF publishes its
   * PAID trains here (the free ones live in the committed snapshot); a foreign
   * network publishes all of its trains here, since none are MAX-free.
   */
  shardDir?: string;
  /**
   * Load this source's shards for the WHOLE booking window rather than just the days
   * a search's results span.
   *
   * Only for sources small enough to afford it. SNCF's paid trains are ~10k a day, so
   * the full month costs about 40 MB of heap and keeps every availability calendar
   * complete. A foreign network is ten times that per day — Belgium's month alone
   * would be some 750 MB — so those load day by day, and their calendars say which
   * days they haven't checked.
   */
  fullWindow?: boolean;
  /** Upstream open-data API (optional; used by the data-refresh script). */
  apiUrl?: string;
  /** Pull the core fields out of one raw record — only for sources with a snapshot. */
  read?: (r: RawSourceRecord) => ReadFields;
  /**
   * Does this record have a bookable / highlighted seat for this source's pass?
   * SNCF: a free MAX seat (`od_happy_card === "OUI"`). A source with no pass concept
   * can simply return `true`.
   */
  isReservable?: (r: RawSourceRecord) => boolean;
  /**
   * Interchange hubs used to build connecting journeys in this network. Foreign
   * networks leave this empty and publish their hubs alongside their data instead
   * (see the `hubs` field of a shard index), so the list stays right as feeds change.
   */
  hubs: string[];
  /**
   * Station-name substrings that appear in the feed but are NOT bookable with the
   * pass (SNCF: international stops). Accent-insensitive substring match; empty for
   * sources with no such exclusions.
   */
  nonBookablePatterns: string[];
  /**
   * Where to send a traveller to actually book. SNCF Connect only sells SNCF, so a
   * German or Belgian leg needs its own operator's site.
   */
  bookingUrl?: (origin: string, destination: string, date: string, time?: string) => string;
  /**
   * True when this source is the free-MAX core of the app rather than an extra.
   * The SNCF profile is always on; every other network is opt-in.
   */
  core?: boolean;
}

/** One raw record before normalization — shape varies per source, so it's untyped. */
export type RawSourceRecord = Record<string, unknown>;

/** The fields the core needs, lifted out of a source's own record shape. */
export interface ReadFields {
  origin?: string;
  destination?: string;
  date?: string;
  depart?: string;
  arrive?: string;
  trainNo?: string;
  /** Line / route family / train-type marker (SNCF: the "axe"). */
  category?: string;
}

/** Trim any raw value to a non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s || undefined;
}

/**
 * SNCF "tgvmax" — the default (and, for now, only) profile. Encodes today's exact
 * behaviour: French field names, and a free MAX seat means `od_happy_card === "OUI"`.
 */
export const SNCF_PROFILE: DatasetProfile = {
  id: "sncf-tgvmax",
  operator: "SNCF",
  country: "FR",
  dataUrl: DATA_URL,
  metaUrl: META_URL,
  shardDir: PAID_SHARD_DIR,
  fullWindow: true,
  apiUrl: SNCF_API_URL,
  read: (r) => ({
    origin: str(r.origine),
    destination: str(r.destination),
    date: str(r.date),
    depart: str(r.heure_depart),
    arrive: str(r.heure_arrivee),
    trainNo: str(r.train_no),
    category: str(r.axe),
  }),
  isReservable: (r) => str(r.od_happy_card)?.toUpperCase() === "OUI",
  hubs: HUB_STATIONS,
  nonBookablePatterns: NON_BOOKABLE_PATTERNS,
  core: true,
};

/**
 * The foreign networks, built from public GTFS feeds by scripts/fetch-networks.ts.
 *
 * They are shard-only: there is no committed snapshot and no raw record shape, because
 * the converter has already normalized them into the shared shard format. None of them
 * has a MAX-style free seat, so every one of their trains is a paid one — which is why
 * enabling a network is enough on its own, without also turning on paid SNCF trains.
 *
 * Booking links go to each operator's own site: SNCF Connect does not sell a Dutch
 * domestic ticket, and pretending otherwise would send travellers to a dead end.
 */
export const NETWORK_PROFILES: DatasetProfile[] = [
  {
    id: "db-fernverkehr",
    operator: "DB",
    country: "DE",
    shardDir: `${NETWORK_DATA_BASE}db-fernverkehr/`,
    stationsUrl: `${NETWORK_DATA_BASE}db-fernverkehr/stations.json`,
    hubs: [],
    nonBookablePatterns: [],
    bookingUrl: (o, d, date, time) =>
      `https://www.bahn.de/buchung/fahrplan/suche#sts=true&so=${encodeURIComponent(o)}&zo=${encodeURIComponent(d)}&hd=${date}T${(time ?? "08:00").padStart(5, "0")}:00`,
  },
  {
    id: "sncb",
    operator: "SNCB",
    country: "BE",
    shardDir: `${NETWORK_DATA_BASE}sncb/`,
    stationsUrl: `${NETWORK_DATA_BASE}sncb/stations.json`,
    hubs: [],
    nonBookablePatterns: [],
    bookingUrl: (o, d, date) =>
      `https://www.belgiantrain.be/en/tickets-and-railcards/community/search?from=${encodeURIComponent(o)}&to=${encodeURIComponent(d)}&date=${date}`,
  },
  {
    id: "cfl",
    operator: "CFL",
    country: "LU",
    shardDir: `${NETWORK_DATA_BASE}cfl/`,
    stationsUrl: `${NETWORK_DATA_BASE}cfl/stations.json`,
    hubs: [],
    nonBookablePatterns: [],
    // Public transport within Luxembourg is free of charge, so there is nothing to buy.
    bookingUrl: () => "https://www.mobiliteit.lu/",
  },
  {
    id: "renfe",
    operator: "Renfe",
    country: "ES",
    shardDir: `${NETWORK_DATA_BASE}renfe/`,
    stationsUrl: `${NETWORK_DATA_BASE}renfe/stations.json`,
    hubs: [],
    nonBookablePatterns: [],
    bookingUrl: (o, d, date) =>
      `https://www.renfe.com/es/es/viajar/informacion-util/horarios?origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&date=${date}`,
  },
  {
    id: "ns",
    operator: "NS",
    country: "NL",
    shardDir: `${NETWORK_DATA_BASE}ns/`,
    stationsUrl: `${NETWORK_DATA_BASE}ns/stations.json`,
    hubs: [],
    nonBookablePatterns: [],
    bookingUrl: (o, d) =>
      `https://www.ns.nl/en/journeyplanner/#/?vertrek=${encodeURIComponent(o)}&aankomst=${encodeURIComponent(d)}`,
  },
];

/** Every profile the app knows, SNCF first. */
export const ALL_PROFILES: DatasetProfile[] = [SNCF_PROFILE, ...NETWORK_PROFILES];

/** Look a profile up by id — used to badge a train with its operator. */
export function profileById(id: string | undefined): DatasetProfile | undefined {
  return id ? ALL_PROFILES.find((p) => p.id === id) : undefined;
}
