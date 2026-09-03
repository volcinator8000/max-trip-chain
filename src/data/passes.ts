/**
 * Subscriptions and what they actually cover.
 *
 * The app used to know one thing: whether a train had a free MAX seat. With four
 * more networks in the search that is no longer the question — "is this train free
 * *for me*" depends on which passes the traveller holds, and passes disagree with
 * each other in specific, checkable ways.
 *
 * ## Three states, not two
 *
 * A pass can leave you with something still to pay. An NS subscription covers
 * "Intercity direct" only if you buy the high-speed supplement; a MAX SENIOR is
 * weekday-only. Collapsing that into free/paid would mean telling someone a train
 * costs nothing when they would be charged at the barrier, so there is a third
 * state: `reserve` — your pass covers the travel, a seat or supplement costs extra.
 *
 * ## What this module can and cannot know
 *
 * Only SNCF publishes a per-train entitlement (`od_happy_card`). Every other feed is
 * a plain timetable with no fare data at all, so coverage there is a RULE the holder
 * declares ("I have a BahnCard 100"), applied to the train's operator and line class.
 * Rules are therefore written down here in the open, and shown to the user, rather
 * than inferred — if one is wrong it is one line to fix, and visibly so.
 */

import type { MaxTrain } from "../types";

/** What a train costs the holder: nothing, a supplement, or full price. */
export type Coverage = "free" | "reserve" | "paid";

/** A pass's effect on a train it covers. "discount" never makes a train free. */
export type PassEffect = "free" | "reserve" | "discount";

/** Two stations a route-bound season ticket is valid between. */
export interface RouteBinding {
  from: string;
  to: string;
}

export interface PassDefinition {
  id: string;
  /** Profile ids this pass applies to. */
  sources: string[];
  /** Operator shown beside the pass in settings. */
  operator: string;
  /** What holding it gets you on a train it covers. */
  effect: PassEffect;
  /**
   * Line classes it covers; empty means every class on the source. Matched against
   * the shard's `category` by longest rule, so "Intercity direct" can be treated
   * differently from "Intercity".
   */
  categories?: string[];
  /** Classes it explicitly does NOT cover. */
  excludeCategories?: string[];
  /** Classes covered only with a supplement — these resolve to `reserve`. */
  reserveCategories?: string[];
  /** Monday-to-Friday travel only. */
  weekdaysOnly?: boolean;
  /** Needs the source's own per-train entitlement flag (SNCF's free MAX seat). */
  requiresFreeSeat?: boolean;
  /** A season ticket valid only between two stations the holder names. */
  routeBound?: boolean;
  /**
   * Only outside the weekday rush. Some products are a reduction you get precisely
   * for travelling when the trains are empty, so applying them to a 08:00 departure
   * would overstate what the holder actually gets.
   */
  offPeakOnly?: boolean;
  /**
   * Percentage off, when the rate is known. Display only — never changes coverage.
   * A discount pass may omit it, and is then shown as a reduction without a figure
   * rather than inventing one.
   */
  discountPercent?: number;
  /**
   * True for a rule that applies to everyone, not a subscription: travel inside
   * Luxembourg is free of charge for all, so it is not offered as a choice.
   */
  alwaysHeld?: boolean;
}

/**
 * The passes the app knows.
 *
 * Deliberately explicit rather than clever: each entry says exactly which operator,
 * which line classes and which conditions, so a wrong rule is visible and cheap to
 * correct. `labelKey`s live in the i18n dictionaries under `pass_<id>`.
 */
export const PASSES: PassDefinition[] = [
  // ── SNCF ────────────────────────────────────────────────────────────────────
  {
    id: "sncf-max-jeune",
    sources: ["sncf-tgvmax"],
    operator: "SNCF",
    effect: "free",
    // The only per-train entitlement any feed publishes: the seat must actually be
    // open to pass holders on that train.
    requiresFreeSeat: true,
  },
  {
    id: "sncf-max-senior",
    sources: ["sncf-tgvmax"],
    operator: "SNCF",
    effect: "free",
    requiresFreeSeat: true,
    // MAX SENIOR free travel is weekdays only. The app already warned about this;
    // now it actually filters, per leg's own travel date.
    weekdaysOnly: true,
  },

  // ── Germany ────────────────────────────────────────────────────────────────
  {
    id: "db-bahncard-100",
    sources: ["db-fernverkehr"],
    operator: "DB",
    effect: "free",
  },
  {
    id: "db-bahncard-50",
    sources: ["db-fernverkehr"],
    operator: "DB",
    effect: "discount",
    discountPercent: 50,
  },
  {
    id: "db-bahncard-25",
    sources: ["db-fernverkehr"],
    operator: "DB",
    effect: "discount",
    discountPercent: 25,
  },
  {
    id: "db-deutschlandticket",
    sources: ["db-fernverkehr"],
    operator: "DB",
    effect: "free",
    // Valid on regional transport ONLY. Every line in the long-distance feed this
    // app loads is an ICE/IC/EC, so today this pass covers nothing here — which the
    // settings hint says out loud rather than quietly granting nothing.
    excludeCategories: ["ICE", "IC", "EC"],
  },

  // ── Belgium ────────────────────────────────────────────────────────────────
  {
    id: "sncb-go-unlimited",
    sources: ["sncb"],
    operator: "SNCB",
    effect: "free",
    // Domestic classes. EC is the international EuroCity and is not included.
    excludeCategories: ["EC"],
  },
  {
    id: "sncb-train-plus",
    sources: ["sncb"],
    operator: "SNCB",
    // A reduction across the network, not free travel, and earned by travelling
    // outside the weekday rush — so it neither hides peak trains nor claims an
    // off-peak one costs nothing. The rate is not encoded because it is not known
    // here; the chip says "reduction" rather than inventing a figure.
    effect: "discount",
    excludeCategories: ["EC"],
    offPeakOnly: true,
  },

  // ── Netherlands ────────────────────────────────────────────────────────────
  {
    id: "ns-ov-jaarkaart",
    sources: ["ns"],
    operator: "NS",
    effect: "free",
    categories: ["Intercity", "Sprinter", "Stoptrein", "Sneltrein"],
    // The high-speed line carries a supplement even for subscription holders, so it
    // is covered — but not free. This is exactly what the third state is for.
    reserveCategories: ["Intercity direct"],
  },
  {
    id: "ns-traject-vrij",
    sources: ["ns"],
    operator: "NS",
    effect: "free",
    categories: ["Intercity", "Sprinter", "Stoptrein", "Sneltrein"],
    reserveCategories: ["Intercity direct"],
    // Traject Vrij is valid on one named route only.
    routeBound: true,
  },

  // ── Luxembourg (not a subscription) ────────────────────────────────────────
  {
    id: "lu-free-transport",
    sources: ["cfl"],
    operator: "CFL",
    effect: "free",
    // Public transport inside Luxembourg is free of charge for everyone (2nd class),
    // so this is a fact about the network rather than something to opt into. TER is
    // the French cross-border service and is not included.
    categories: ["RE", "RB", "IC"],
    alwaysHeld: true,
  },
];

/** Look up a pass by id. */
export function passById(id: string): PassDefinition | undefined {
  return PASSES.find((p) => p.id === id);
}

/** The passes a user can choose (everything that isn't an everyone-gets-it rule). */
export const SELECTABLE_PASSES = PASSES.filter((p) => !p.alwaysHeld);

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Does a rule match a train's line class?
 *
 * Feeds append a line number ("ICE 42", "S1"), so a rule matches when the category
 * equals it or continues past it at a word/number boundary. "IC" must therefore not
 * match "ICE 42", which is why the boundary check exists at all.
 */
function ruleMatches(category: string, rule: string): boolean {
  const c = category.trim().toLowerCase();
  const r = rule.trim().toLowerCase();
  if (c === r) return true;
  if (!c.startsWith(r)) return false;
  const next = c.charAt(r.length);
  // A digit directly after ("IC55") or a separator both continue the same class;
  // a letter means a different one ("ICE" after "IC").
  return next === " " || next === "-" || (next >= "0" && next <= "9");
}

/** The longest rule in `rules` that matches, or null. Longest wins so that a
 *  specific class ("Intercity direct") beats the general one ("Intercity"). */
function longestMatch(category: string, rules: string[] | undefined): string | null {
  if (!rules?.length) return null;
  let best: string | null = null;
  for (const r of rules) {
    if (ruleMatches(category, r) && (best === null || r.length > best.length)) best = r;
  }
  return best;
}

/**
 * Weekday rush-hour windows, as minutes from midnight. An assumption, not something
 * any feed publishes — the morning and evening peaks operators typically price
 * against. Wrong only in its edges, and one place to correct.
 */
const PEAK_WINDOWS: [number, number][] = [
  [6 * 60, 9 * 60],
  [16 * 60, 19 * 60],
];

/** Saturday or Sunday, from a "YYYY-MM-DD" date (UTC, so it can't drift by timezone). */
export function isWeekendDate(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

/** Does this train leave outside the weekday rush? Weekends count as off-peak. */
export function isOffPeak(train: MaxTrain): boolean {
  if (isWeekendDate(train.date)) return true;
  const dep = ((train.departMin % 1440) + 1440) % 1440;
  return !PEAK_WINDOWS.some(([from, to]) => dep >= from && dep < to);
}

/** Is a route-bound pass valid for this leg? Season tickets work in both directions. */
function bindingCovers(binding: RouteBinding | undefined, train: MaxTrain): boolean {
  if (!binding?.from || !binding.to) return false;
  return (
    (train.origin === binding.from && train.destination === binding.to) ||
    (train.origin === binding.to && train.destination === binding.from)
  );
}

/**
 * What one pass gets you on one train: "free", "reserve", or null when it does not
 * apply at all. A discount card always returns null — it never makes a train free.
 */
export function passCoverage(
  pass: PassDefinition,
  train: MaxTrain,
  binding?: RouteBinding,
): "free" | "reserve" | null {
  if (!pass.sources.includes(train.source ?? "")) return null;
  if (pass.effect === "discount") return null;
  if (pass.requiresFreeSeat && !train.free) return null;
  if (pass.weekdaysOnly && isWeekendDate(train.date)) return null;
  if (pass.routeBound && !bindingCovers(binding, train)) return null;
  if (pass.offPeakOnly && !isOffPeak(train)) return null;

  const category = train.axe ?? "";
  // An exclusion wins outright, but only if it is at least as specific as any
  // inclusion — otherwise excluding "IC" would also drop a listed "IC direct".
  const excluded = longestMatch(category, pass.excludeCategories);
  const reserved = longestMatch(category, pass.reserveCategories);
  const included = longestMatch(category, pass.categories);

  if (excluded && excluded.length >= Math.max(reserved?.length ?? 0, included?.length ?? 0)) return null;
  if (reserved && reserved.length >= (included?.length ?? 0)) return "reserve";
  // An empty `categories` list means "every class on this source".
  if (!pass.categories?.length || included) return pass.effect === "reserve" ? "reserve" : "free";
  return null;
}

/**
 * What a train costs the holder of `held`, best outcome winning: a pass that makes it
 * free beats one that only covers it with a supplement, which beats paying.
 */
export function coverageFor(
  train: MaxTrain,
  held: PassDefinition[],
  bindings: Record<string, RouteBinding> = {},
): Coverage {
  let best: Coverage = "paid";
  for (const pass of held) {
    const got = passCoverage(pass, train, bindings[pass.id]);
    if (got === "free") return "free"; // nothing beats free
    if (got === "reserve") best = "reserve";
  }
  return best;
}

/**
 * The best discount card that applies to a train, or null. Used only to label a fare
 * the holder is still paying — it never changes whether the train is shown.
 *
 * Returns the pass rather than a number so a product whose rate isn't encoded can
 * still be reported honestly, as a reduction without a figure.
 */
export function discountFor(train: MaxTrain, held: PassDefinition[]): PassDefinition | null {
  let best: PassDefinition | null = null;
  for (const pass of held) {
    if (pass.effect !== "discount") continue;
    if (!pass.sources.includes(train.source ?? "")) continue;
    if (pass.offPeakOnly && !isOffPeak(train)) continue;
    if (pass.routeBound) continue; // a route-bound discount would need its binding
    const category = train.axe ?? "";
    if (longestMatch(category, pass.excludeCategories)) continue;
    if (pass.categories?.length && !longestMatch(category, pass.categories)) continue;
    if (!best || (pass.discountPercent ?? 0) > (best.discountPercent ?? 0)) best = pass;
  }
  return best;
}

/**
 * The passes in force: those the user holds, plus the rules that apply to everyone
 * (Luxembourg's free public transport), which are never presented as a choice.
 */
export function heldPasses(ids: string[]): PassDefinition[] {
  const held = PASSES.filter((p) => p.alwaysHeld);
  for (const id of ids) {
    const p = passById(id);
    if (p && !p.alwaysHeld) held.push(p);
  }
  return held;
}
