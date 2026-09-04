/** SNCF Open Data — Explore API v2.1 records endpoint for the `tgvmax` dataset. */
export const SNCF_API_URL =
  "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax/records";

/** Major interchange stations used to build single-connection journeys. */
export const HUB_STATIONS: string[] = [
  "PARIS (intramuros)",
  "LYON (intramuros)",
  // The feed only ever emits "LILLE (intramuros)"; the bare "LILLE" written here
  // matched nothing, so Lille has never actually worked as an interchange.
  "LILLE (intramuros)",
  "MARSEILLE ST CHARLES",
  "BORDEAUX ST JEAN",
  "RENNES",
  "STRASBOURG",
  "NANTES",
  "MONTPELLIER SAINT ROCH",
  "TOULOUSE MATABIAU",
];

/** Allowed layover window (minutes) for a connection. */
export const MIN_CONNECTION_MIN = 15;

/**
 * Minimum minutes to change trains at a station that is really a WHOLE CITY.
 *
 * The SNCF feed publishes city aggregates: `PARIS (intramuros)` is Nord, Est, Lyon,
 * Montparnasse, Austerlitz, Bercy and Saint-Lazare at once. Treating that as one
 * station let the search offer a 15-minute change between termini that are a metro
 * ride apart — an audit of the live feed found 21,611 such connections, 12.5% of
 * every Paris change it was willing to propose (arrive Austerlitz 07:03, depart Gare
 * de Lyon 07:26). A traveller acting on one misses their train.
 *
 * These are therefore CROSS-CITY floors, not platform-change times: the pessimistic
 * reading, because the data cannot say which terminus a leg actually uses. That does
 * cost some genuine same-station changes; offering an impossible trip is worse.
 */
/**
 * Which terminus inside a city aggregate a train actually uses, by its line.
 *
 * The SNCF feed never names the gare, but the `axe` implies it: every Atlantique
 * service leaves Montparnasse, every Sud-Est one Gare de Lyon. That is enough to tell
 * a real platform change (Nord → Nord, 15 minutes is fine) from crossing the city
 * (Austerlitz → Gare de Lyon, which is not a connection at 23 minutes).
 *
 * `IC ARO` and `INTERNATIONAL` are deliberately absent — they are not tied to one
 * gare, so they resolve to undefined and are treated as a city crossing. Pessimistic
 * on purpose: an unknown terminus might be the far side of Paris.
 */
export const PARIS_GARE_BY_AXE: Record<string, string> = {
  "SUD EST": "Paris Gare de Lyon",
  ATLANTIQUE: "Paris Montparnasse",
  NORD: "Paris Nord",
  EST: "Paris Est",
  // Every Intercités de Nuit out of Paris leaves Austerlitz.
  "IC NUIT": "Paris Austerlitz",
};

/**
 * The specific terminus a leg uses inside a city aggregate, or undefined when it
 * cannot be told. Only Paris can be resolved today; other aggregates always read as
 * unknown, which simply means they keep their full city floor.
 */
export function terminusOf(station: string, axe: string | undefined): string | undefined {
  if (station !== "PARIS (intramuros)") return undefined;
  return PARIS_GARE_BY_AXE[(axe ?? "").toUpperCase().trim()];
}

export const CITY_TRANSFER_MIN: Record<string, number> = {
  "PARIS (intramuros)": 60,
  "LYON (intramuros)": 30,
  "LILLE (intramuros)": 25,
};
export const MAX_CONNECTION_MIN = 240;
/** Layover ceiling when overnight stopovers are allowed (sleep at the hub). */
export const OVERNIGHT_MAX_CONNECTION_MIN = 15 * 60;

/**
 * Minimum time on site (minutes) for a SAME-DAY round trip to count as a real day
 * out. Below this, a "trip" is just stepping off the platform and boarding the
 * return — so both the discovery list and the exact round-trip page require at
 * least this gap between arriving and the return leaving. It also drops outbound
 * departures so late that no return can leave this many minutes later and still get
 * you home by midnight (you'd be stranded).
 */
export const SAME_DAY_MIN_ON_SITE_MIN = 4 * 60;

/**
 * Destinations that appear in the open data but are NOT bookable with a MAX pass
 * (MAX JEUNE / SENIOR cover domestic France; these international stops show
 * od_happy_card="OUI" in the feed but can't actually be reserved with the pass).
 * Matched as accent-insensitive substrings of the station label — extend freely.
 */
export const NON_BOOKABLE_PATTERNS: string[] = [
  "geneve", // Genève / Geneva (CH)
  "lausanne", // (CH)
  "zurich", // (CH)
  "bruxelles", // Brussels (BE)
  "brussel",
];

const BASE = (import.meta.env?.BASE_URL ?? "/") as string;

/** Base-relative data URLs (work under the GitHub Pages sub-path). */
export const DATA_URL = `${BASE}data/tgvmax.json`;
export const META_URL = `${BASE}data/meta.json`;

/**
 * Compact per-day shards of SNCF trains that RUN but have no free MAX seat, used by
 * the "show paid trains" toggle. They are built during the Pages deploy and served
 * as static files, never committed: at ~322k trains a month they would add hundreds
 * of megabytes to git history, while the free snapshot (the constitution's offline
 * fallback) stays small and committed. A missing shard simply means no paid trains
 * for that day. See scripts/fetch-data.ts and src/data/sources.ts.
 */
export const PAID_SHARD_DIR = `${BASE}data/paid/`;

/** Root under which each foreign network publishes its shards, index and stations. */
export const NETWORK_DATA_BASE = `${BASE}data/`;

export const SNCF_CONNECT_URL = "https://www.sncf-connect.com/";

export const SITE_URL = "https://volcinator8000.github.io/max-trip-chain/";

/** Project repository (used for the header star link and the feedback button). */
export const GITHUB_URL = "https://github.com/volcinator8000/max-trip-chain";
export const GITHUB_ISSUES_URL = `${GITHUB_URL}/issues/new`;

/** Official SNCF pages describing the MAX JEUNE / MAX SENIOR subscriptions. */
export const MAX_JEUNE_URL = "https://www.sncf-connect.com/catalogue/description/max-jeune";
export const MAX_SENIOR_URL = "https://www.sncf-connect.com/catalogue/description/max-senior";

/** App version + build date, injected from package.json at build time (see vite.config).
 *  Falls back to "dev" when the defines aren't present (e.g. a raw ts-node run). */
declare const __APP_VERSION__: string;
declare const __APP_BUILD__: string;
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
export const APP_BUILD = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "";
