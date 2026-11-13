// Bracket Tool server
// One tool for showing a tournament bracket in OBS. The bracket can come from:
//   - Manual:  teams and scores entered in the dock (2 to 32 teams; single elimination, with or
//              without a 3rd place match, or double elimination)
//   - A link:  a start.gg or Challonge bracket, checked every 10 seconds. Any match can be
//              overridden by hand in the dock.
//
//   Dock (OBS custom browser dock):  http://127.0.0.1:8094/
//   Overlay data:                    http://127.0.0.1:8094/api/bracket
//
// No npm install and no API keys needed - only uses built-in Node modules.

const http = require("http");
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const PORT = 8094; // own port: Bracket Controller 8090, Controller 8091, StartGG Bracket 8092, Bracket Tool 8093
const HOST = "127.0.0.1"; // only reachable from this PC
const BASE_URL = `http://${HOST}:${PORT}`;
const REFRESH_MS = 10 * 1000; // how often start.gg / Challonge is checked
const STARTGG_API = "https://api.start.gg";

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "bracket-tool.json");
const LOGO_DIR = path.join(ROOT, "logos");
const FONT_DIR = path.join(ROOT, "overlay", "fonts", "Rajdhani");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(LOGO_DIR, { recursive: true });

const SOURCES = ["manual", "site"];
const MAX_SLOTS = 12; // linked brackets that can be loaded at the same time
const VIEWS = ["auto", "4", "8", "16", "32", "all"];
const SIDES = ["both", "winners", "losers"];
const BRACKET_TYPES = { 1: "single elimination", 2: "double elimination" };

// =====================================================================================
// MANUAL BRACKET
// =====================================================================================
// Each match says where its two teams come from:
//   seed(i)       seed i + 1 from the Teams tab (0-based)
//   W(id) / L(id) the winner / loser of an earlier match
//   slot(id, n)   team n (1 or 2) of an earlier match (used for the grand final reset)
// "onlyIf" makes a match happen only when an earlier match is won by a given side.
// Matches must be listed after the matches they depend on.
// "side" is where the round sits on the overlay: w = top row, l = bottom row, f = finals column.

const MIN_TEAMS = 2;
const MAX_TEAMS = 32;
const seed = i => ({ seed: i });
const W = id => ({ winner: id });
const L = id => ({ loser: id });
const slot = (id, n) => ({ slot: id, n });
const M = (id, label, a, b, extra) => ({ id, label, a, b, ...extra });

const TYPES = {
  se: "Single elimination",
  se3: "Single elimination + 3rd place",
  de: "Double elimination"
};
const DEFAULT_TEAMS = 8;
const DEFAULT_TYPE = "se3";

// Match length ("best of") is set per stage of the bracket.
const BO_LABELS = {
  early: "Early rounds", semi: "Semifinals", final: "Grand Final", third: "3rd Place",
  ub: "Upper Bracket", ubf: "Upper Final", lb: "Lower Bracket", lbf: "Lower Final", gf: "Grand Final"
};
const BO_DEFAULTS = { early: 3, semi: 3, final: 5, third: 3, ub: 3, ubf: 3, lb: 3, lbf: 3, gf: 5 };

// Seeds in first-round order, so the best seeds can only meet late:
// 8 teams -> 1 v 8, 4 v 5, 2 v 7, 3 v 6.
function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap(s => [s, n + 1 - s]);
  }
  return order;
}

// Double elimination: the order in which the losers of each upper round drop into the lower
// bracket. Mixing the order up keeps teams from meeting the same opponent again straight away.
// One entry per upper round, for each bracket size.
const DROP_ORDER = {
  2: ["natural"],
  4: ["natural", "natural"],
  8: ["natural", "reverse", "natural"],
  16: ["natural", "reverse_half_shift", "reverse", "natural"],
  32: ["natural", "reverse", "half_shift", "natural", "natural"]
};
const reorder = {
  natural: list => [...list],
  reverse: list => [...list].reverse(),
  half_shift: list => [...list.slice(list.length / 2), ...list.slice(0, list.length / 2)],
  reverse_half_shift: list => [...list.slice(0, list.length / 2).reverse(), ...list.slice(list.length / 2).reverse()]
};

const BYE = { bye: true };

// Builds the bracket for a number of teams and a type: the rounds, the matches in them and
// where each match gets its two teams from.
// When the team count isn't 2, 4, 8, 16 or 32 the best seeds get a bye: the first-round match
// they would have played doesn't exist and they start one round later.
function makeFormat(teamCount, type) {
  const size = 2 ** Math.ceil(Math.log2(teamCount)); // bracket size: 2, 4, 8, 16 or 32
  const k = Math.log2(size); // number of (upper) rounds
  const de = type === "de";
  const all = []; // every match of the full-size bracket, in an order where sources come first

  // ---- upper bracket (the whole bracket for single elimination) ----
  const order = seedOrder(size);
  const upper = []; // upper[r - 1] = match ids of round r
  for (let r = 1; r <= k; r++) {
    const ids = [];
    for (let i = 0; i < size / 2 ** r; i++) {
      const id = `w${r}m${i + 1}`;
      const a = r === 1 ? seed(order[2 * i] - 1) : W(upper[r - 2][2 * i]);
      const b = r === 1 ? seed(order[2 * i + 1] - 1) : W(upper[r - 2][2 * i + 1]);
      all.push({ id, a, b, part: "w", round: r });
      ids.push(id);
    }
    upper.push(ids);
  }
  const upperFinal = upper[k - 1][0];

  // ---- lower bracket ----
  let lowerRounds = 0;
  let prev = []; // match ids of the lower round just built
  if (de && k >= 2) {
    const drop = DROP_ORDER[size];
    const addRound = pairs => {
      lowerRounds++;
      prev = pairs.map(([a, b], i) => {
        const id = `l${lowerRounds}m${i + 1}`;
        all.push({ id, a, b, part: "l", round: lowerRounds });
        return id;
      });
    };
    const inPairs = list => list.filter((_, i) => i % 2 === 0).map((x, i) => [x, list[2 * i + 1]]);

    // Lower round 1: the first-round losers play each other.
    addRound(inPairs(reorder[drop[0]](upper[0])).map(([x, y]) => [L(x), L(y)]));
    for (let r = 2; r <= k; r++) {
      // The losers of upper round r drop in against the teams still alive down here...
      const dropping = reorder[drop[r - 1]](upper[r - 1]);
      addRound(prev.map((id, i) => [W(id), L(dropping[i])]));
      // ...then those winners play each other (except before the lower final).
      if (r < k) addRound(inPairs(prev).map(([x, y]) => [W(x), W(y)]));
    }
  }

  // ---- finals ----
  if (de) {
    all.push({ id: "gf1", a: W(upperFinal), b: lowerRounds ? W(prev[0]) : L(upperFinal), part: "gf" });
  } else if (type === "se3" && k >= 2) {
    all.push({ id: "b3", a: L(upper[k - 2][0]), b: L(upper[k - 2][1]), part: "b3" });
  }

  // ---- take out the matches that aren't played because of byes ----
  const passed = {}; // unplayed match id -> who goes straight through it
  const real = [];
  const resolve = src => {
    if (src.seed !== undefined) return src.seed < teamCount ? src : BYE;
    if (src.winner && src.winner in passed) return passed[src.winner];
    if (src.loser && src.loser in passed) return BYE; // nobody lost a match that wasn't played
    return src;
  };
  for (const m of all) {
    const a = resolve(m.a), b = resolve(m.b);
    if (!a.bye && !b.bye) real.push({ ...m, a, b });
    else if (m.part !== "b3") passed[m.id] = a.bye ? b : a; // (3rd place needs both semifinals played)
  }

  // ---- sort into named rounds ----
  const rounds = [];
  const addNamed = (title, solo, numbered, bo, side, matches) => {
    if (!matches.length) return;
    rounds.push({
      title, bo, side,
      matches: matches.map((m, i) => M(m.id, matches.length > 1 ? `${numbered} ${i + 1}` : solo, m.a, m.b))
    });
  };
  const inRound = (part, round) => real.filter(m => m.part === part && m.round === round);

  for (let r = 1; r <= k; r++) {
    const left = k - r; // rounds after this one
    if (de) {
      const [title, one] = left === 0 ? ["Upper Final", "Upper Final"]
        : left === 1 ? ["Upper Semifinals", "Upper Semifinal"]
        : left === 2 ? ["Upper Quarterfinals", "Upper Quarterfinal"]
        : [`Upper Round ${r}`, `Upper Round ${r} - Match`];
      addNamed(title, left > 2 ? title : one, one, left === 0 ? "ubf" : "ub", "w", inRound("w", r));
    } else {
      const [title, one] = left === 0 ? ["Grand Final", "Grand Final"]
        : left === 1 ? ["Semifinals", "Semifinal"]
        : left === 2 ? ["Quarterfinals", "Quarterfinal"]
        : [`Round of ${size / 2 ** (r - 1)}`, `Round of ${size / 2 ** (r - 1)} - Match`];
      addNamed(title, left > 2 ? title : one, one, left === 0 ? "final" : left === 1 ? "semi" : "early", left === 0 ? "f" : "w", inRound("w", r));
    }
  }

  let shown = 0; // lower rounds are numbered by what is actually played
  for (let r = 1; r <= lowerRounds; r++) {
    const matches = inRound("l", r);
    if (!matches.length) continue;
    shown++;
    const last = r === lowerRounds;
    const title = last ? "Lower Final" : `Lower Round ${shown}`;
    addNamed(title, title, `${title} - Match`, last ? "lbf" : "lb", "l", matches);
  }

  if (de) {
    const gf = real.find(m => m.id === "gf1");
    rounds.push({ title: "Grand Final", bo: "gf", side: "f", matches: [
      M("gf1", "Grand Final", gf.a, gf.b),
      // Lower bracket team won the first grand final: both teams have one loss, play again.
      M("gf2", "Grand Final Reset", slot("gf1", 1), slot("gf1", 2), { onlyIf: { match: "gf1", winner: 2 } })
    ] });
  }
  addNamed("3rd Place", "3rd Place", "3rd Place", "third", "f", real.filter(m => m.part === "b3"));

  const stages = [...new Set(rounds.map(r => r.bo))];
  return {
    id: `${type}-${teamCount}`,
    name: `${teamCount} teams - ${TYPES[type]}`,
    teams: teamCount,
    type,
    bestOf: stages.map(key => [key, BO_LABELS[key]]),
    rounds
  };
}

const formatCache = new Map();
function getFormat(teamCount, type) {
  const key = `${type}-${teamCount}`;
  if (!formatCache.has(key)) formatCache.set(key, makeFormat(teamCount, type));
  return formatCache.get(key);
}
const formatOf = s => getFormat(s.teamCount, s.type);

const matchList = fmt => fmt.rounds.flatMap(r => r.matches.map(m => ({ ...m, bo: r.bo })));

function defaultManual(teamCount = DEFAULT_TEAMS, type = DEFAULT_TYPE) {
  const teams = [];
  for (let i = 0; i < MAX_TEAMS; i++) teams.push({ name: "", logo: "" });
  const scores = {};
  matchList(getFormat(teamCount, type)).forEach(m => (scores[m.id] = [0, 0]));
  return {
    title: "Playoffs",
    teamCount,
    type,
    teams, // always 32 stored, in seed order; the bracket uses the first "teamCount"
    scores, // only the matches of the current bracket
    bestOf: { ...BO_DEFAULTS }
  };
}

function cleanManual(input) {
  if (!input || typeof input !== "object") return defaultManual();

  let teamCount = parseInt(input.teamCount, 10);
  let type = input.type;
  // Saves from before any team count was possible stored a format name such as "de8".
  const old = { se4: [4, "se3"], se8: [8, "se3"], de4: [4, "de"], de8: [8, "de"] }[input.format];
  if (old && !(teamCount > 0)) [teamCount, type] = old;
  if (!(teamCount >= MIN_TEAMS && teamCount <= MAX_TEAMS)) teamCount = DEFAULT_TEAMS;
  if (!TYPES[type]) type = DEFAULT_TYPE;

  const base = defaultManual(teamCount, type);
  if (typeof input.title === "string") base.title = input.title.slice(0, 60);
  if (Array.isArray(input.teams)) {
    for (let i = 0; i < MAX_TEAMS; i++) {
      const t = input.teams[i] || {};
      base.teams[i] = {
        name: String(t.name || "").slice(0, 60),
        logo: String(t.logo || "").slice(0, 500)
      };
    }
  }
  if (input.scores && typeof input.scores === "object") {
    Object.keys(base.scores).forEach(id => {
      const s = input.scores[id];
      if (Array.isArray(s)) {
        base.scores[id] = [0, 1].map(i => Math.max(0, Math.min(99, parseInt(s[i], 10) || 0)));
      }
    });
  }
  if (input.bestOf && typeof input.bestOf === "object") {
    Object.keys(BO_DEFAULTS).forEach(k => {
      const v = parseInt(input.bestOf[k], 10);
      if ([1, 3, 5, 7].includes(v)) base.bestOf[k] = v;
    });
  }
  return base;
}

// Works out who is in every match from the seeds and the results so far.
function buildBracket(s) {
  const fmt = formatOf(s);
  const out = {};
  const empty = { name: "", logo: "", seed: -1 };
  const strip = t => ({ name: t.name, logo: t.logo, seed: t.seed });
  const T = s.teams.map((t, i) => ({ name: t.name, logo: t.logo, seed: t.name && i < fmt.teams ? i : -1 }));

  function pick(src) {
    if (src.seed !== undefined) return T[src.seed] || empty;
    if (src.winner) {
      const m = out[src.winner];
      return m.winner ? strip(m["team" + m.winner]) : empty;
    }
    if (src.loser) {
      const m = out[src.loser];
      return m.winner ? strip(m["team" + (3 - m.winner)]) : empty;
    }
    if (src.slot) return strip(out[src.slot]["team" + src.n]);
    return empty;
  }

  for (const md of matchList(fmt)) {
    let t1 = pick(md.a);
    let t2 = pick(md.b);
    let notNeeded = false;
    if (md.onlyIf) {
      const r = out[md.onlyIf.match];
      if (r.winner !== md.onlyIf.winner) {
        notNeeded = !!r.winner; // decided the other way: this match won't be played
        t1 = t2 = empty;
      }
    }
    const bo = s.bestOf[md.bo];
    const need = Math.floor(bo / 2) + 1;
    const [s1, s2] = s.scores[md.id];
    const ready = !!(t1.name && t2.name);
    let winner = 0;
    if (ready && s1 >= need && s1 > s2) winner = 1;
    else if (ready && s2 >= need && s2 > s1) winner = 2;
    out[md.id] = {
      label: md.label,
      team1: { ...strip(t1), score: s1 },
      team2: { ...strip(t2), score: s2 },
      bestOf: bo,
      winsNeeded: need,
      winner,
      notNeeded
    };
  }
  return out;
}

// When a result earlier in the bracket changes, later matches may get different teams.
// Any later match whose teams changed has its score reset to 0-0 (repeats until stable).
// Renaming a team keeps its seed, so fixing a typo never resets scores.
function resetChangedMatches(oldState, newState) {
  const pairing = b => {
    const p = {};
    for (const [id, m] of Object.entries(b)) p[id] = `${m.team1.seed}|${m.team2.seed}`;
    return p;
  };
  const dependent = matchList(formatOf(newState))
    .filter(m => m.a.seed === undefined || m.b.seed === undefined)
    .map(m => m.id);
  const before = pairing(buildBracket(oldState));
  for (let pass = 0; pass <= dependent.length; pass++) {
    const now = pairing(buildBracket(newState));
    let changed = false;
    for (const id of dependent) {
      const sc = newState.scores[id];
      if (now[id] !== before[id] && (sc[0] || sc[1])) {
        newState.scores[id] = [0, 0];
        changed = true;
      }
    }
    if (!changed) break;
  }
  return newState;
}

// Logos are stored as "/logos/file.png"; the overlay needs a full URL.
const fullLogoUrl = logo => (logo && logo.startsWith("/logos/") ? BASE_URL + logo : logo || "");

// The manual bracket in the shape the overlay draws (columns of matches).
function manualView() {
  const s = store.manual;
  const fmt = formatOf(s);
  const b = buildBracket(s);
  const toMatch = md => {
    const m = b[md.id];
    const blank = !m.team1.score && !m.team2.score; // 0-0: scores stay hidden
    const team = n => {
      const t = m["team" + n];
      return { name: t.name, logo: fullLogoUrl(t.logo), score: blank ? "" : String(t.score), winner: m.winner === n };
    };
    return {
      id: md.id, label: md.label, notNeeded: m.notNeeded,
      // a score on the board but no winner yet = being played right now
      state: m.winner ? "done" : !blank && m.team1.name && m.team2.name ? "live" : "pending",
      // For drawing the bracket, per team row (top, bottom):
      //   from  = the match whose winner comes in on that row, if any
      //   entry = how that row is filled: "match" (a winner), "seed" (a team that starts here,
      //           e.g. after a bye) or "drop" (a loser dropping in from the upper bracket)
      from: [md.a.winner || null, md.b.winner || null],
      entry: [md.a, md.b].map(s => (s.winner ? "match" : s.loser ? "drop" : s.seed !== undefined ? "seed" : "")),
      team1: team(1), team2: team(2)
    };
  };
  const columns = side => fmt.rounds.filter(r => r.side === side).map(r => ({ title: r.title, matches: r.matches.map(toMatch) }));
  return { winners: columns("w"), losers: columns("l"), finals: columns("f").flatMap(c => c.matches) };
}

// Everything the manual tabs of the dock need.
function manualPayload() {
  return {
    state: store.manual,
    bracket: buildBracket(store.manual),
    format: formatOf(store.manual),
    types: Object.entries(TYPES).map(([id, name]) => ({ id, name })),
    minTeams: MIN_TEAMS,
    maxTeams: MAX_TEAMS
  };
}

// =====================================================================================
// SAVED DATA
// =====================================================================================

// One slot = one linked bracket (start.gg or Challonge). Several slots can be loaded at once.
function defaultSite() {
  return {
    id: 1, // slot number, also used in the overlay address (?slot=2)
    inRotation: true, // take part when the main overlay rotates through the slots
    tournamentName: "",
    url: "",
    groupId: null, // the bracket being shown: a start.gg "phase group" id, or a Challonge embed address
    title: "", // blank = use the event name from the site
    view: "auto",
    side: "both",
    showPrefix: true,
    // filled in from the site when the link is loaded:
    eventName: "",
    phaseName: "",
    choices: [], // brackets to pick from when the link doesn't point at a single one
    overrides: {} // matches edited by hand: { <match id>: { name1, name2, score1, score2, winner } }
  };
}

function loadStore() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) || {};
  } catch {
    // first run, or the file was deleted: start fresh
  }
  // Older saves had a single linked bracket ("site"); it becomes slot 1.
  let list = Array.isArray(saved.slots) ? saved.slots : saved.site ? [saved.site] : [];
  list = list.filter(s => s && typeof s === "object").slice(0, MAX_SLOTS);
  if (!list.length) list = [{}];
  const used = new Set();
  const slots = list.map(s => {
    const slot = { ...defaultSite(), ...s };
    let id = parseInt(slot.id, 10);
    if (!(id > 0) || used.has(id)) id = Math.max(0, ...used) + 1;
    used.add(id);
    slot.id = id;
    if (!slot.overrides || typeof slot.overrides !== "object") slot.overrides = {};
    if (!Array.isArray(slot.choices)) slot.choices = [];
    return slot;
  });
  const rotate = saved.rotate && typeof saved.rotate === "object" ? saved.rotate : {};
  const seconds = parseInt(rotate.seconds, 10);
  return {
    source: SOURCES.includes(saved.source) ? saved.source : "manual",
    manual: cleanManual(saved.manual),
    slots,
    selected: slots.some(s => s.id === saved.selected) ? saved.selected : slots[0].id,
    rotate: { on: rotate.on === true, seconds: seconds >= 5 && seconds <= 600 ? seconds : 20 }
  };
}

function saveStore() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let store = loadStore();

// =====================================================================================
// START.GG
// =====================================================================================

// Downloads a page as text. "site" is only used to make error messages readable.
function getText(url, site) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "Accept": "application/json, text/html", "Accept-Encoding": "gzip", "User-Agent": "obs-bracket-overlay" },
      timeout: 15000
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        try {
          let body = Buffer.concat(chunks);
          if (res.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body);
          if (res.statusCode === 404) return reject(new Error(`${site} could not find that bracket. Check the link.`));
          if (res.statusCode !== 200) return reject(new Error(`${site} returned error ${res.statusCode}`));
          resolve(body.toString("utf8"));
        } catch (e) {
          reject(new Error(`Could not read the reply from ${site}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${site} took too long to answer`)));
    req.on("error", e => reject(e.code === "ENOTFOUND" || e.code === "EAI_AGAIN" ? new Error(`No internet connection to ${site}`) : e));
  });
}

async function getJson(url) {
  const text = await getText(url, "start.gg");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Could not read the reply from start.gg");
  }
}

const arr = x => (x == null ? [] : Array.isArray(x) ? x : [x]);

// Accepts any start.gg link at or below a tournament:
//   .../tournament/<name>/event/<event>/brackets/<phase id>/<group id>   (a single bracket)
//   .../tournament/<name>/event/<event>                                  (pick from that event)
//   .../tournament/<name>                                                (pick from everything)
function parseLink(link) {
  const m = /(?:start|smash)\.gg\/tournament\/([^\/?#\s]+)(?:\/events?\/([^\/?#\s]+))?(?:\/brackets\/(\d+)(?:\/(\d+))?)?/i.exec(link || "");
  if (!m) return null;
  return {
    tournament: m[1],
    event: m[2] || "",
    phaseId: m[3] ? Number(m[3]) : null,
    groupId: m[4] ? Number(m[4]) : null
  };
}

// Looks up event / bracket names and works out which bracket(s) the link points at.
async function resolveLink(link) {
  const parsed = parseLink(link);
  if (!parsed) throw new Error("That doesn't look like a start.gg or Challonge bracket link.");

  const lookup = `${STARTGG_API}/tournament/${encodeURIComponent(parsed.tournament)}` +
    (parsed.event ? `/event/${encodeURIComponent(parsed.event)}` : "") +
    `?expand[]=event&expand[]=phase&expand[]=groups`;
  const ent = (await getJson(lookup)).entities || {};
  const events = new Map(arr(ent.event).map(e => [e.id, e]));
  const phases = new Map(arr(ent.phase).map(p => [p.id, p]));

  let choices = arr(ent.groups)
    .filter(g => BRACKET_TYPES[g.groupTypeId])
    .filter(g => !parsed.phaseId || g.phaseId === parsed.phaseId)
    .map(g => {
      const phase = phases.get(g.phaseId) || {};
      const event = events.get(phase.eventId) || {};
      const pool = phase.groupCount > 1 ? ` - Pool ${g.displayIdentifier}` : "";
      return {
        id: g.id,
        eventName: event.name || "",
        phaseName: (phase.name || "") + pool,
        label: [event.name, (phase.name || "") + pool].filter(Boolean).join(" - ")
      };
    });

  if (parsed.groupId) {
    const exact = choices.find(c => c.id === parsed.groupId);
    // Still load it if the name lookup didn't list it - the bracket check will say if it's wrong.
    choices = [exact || { id: parsed.groupId, eventName: "", phaseName: "", label: "" }];
  }
  if (!choices.length) {
    throw new Error("No single or double elimination brackets found at that link.");
  }

  // The tournament name tells brackets apart when several events share a name
  // ("Section Playoffs"). An event lookup doesn't include it, so ask for it separately.
  let tournamentName = (arr(ent.tournament)[0] || {}).name || "";
  if (!tournamentName) {
    try {
      const t = (await getJson(`${STARTGG_API}/tournament/${encodeURIComponent(parsed.tournament)}`)).entities || {};
      tournamentName = (arr(t.tournament)[0] || {}).name || "";
    } catch {
      // not essential: the event name is used instead
    }
  }
  return { choices, tournamentName };
}

async function fetchStartgg(groupId) {
  const json = await getJson(`${STARTGG_API}/phase_group/${groupId}?expand[]=sets&expand[]=entrants`);
  const ent = json.entities || {};
  const group = arr(ent.groups)[0] || {};
  if (!BRACKET_TYPES[group.groupTypeId]) {
    throw new Error("That link isn't a single or double elimination bracket (pools, swiss and round robin can't be shown).");
  }

  const names = {};
  for (const e of arr(ent.entrants)) {
    // "full" includes the sponsor/school prefix ("LSW | CupcakeMK"); "short" is just the tag.
    const people = Object.values((e.mutations && e.mutations.participants) || {});
    const short = people.length === 1 && people[0].gamerTag ? people[0].gamerTag : e.name;
    names[e.id] = { full: e.name || "", short: short || e.name || "" };
  }
  return { type: group.groupTypeId, sets: arr(ent.sets), names };
}

// start.gg letters its sets in bracket order: A, B ... Z, AA, AB ...
const bySetOrder = (a, b) => {
  const x = String(a.identifier || ""), y = String(b.identifier || "");
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : a.id - b.id);
};

// =====================================================================================
// CHALLONGE
// =====================================================================================
// Challonge brackets are read from the bracket's public embed page
// (https://challonge.com/<bracket>/module), which carries the bracket data. No API key needed.
// The matches are converted to the same shape as start.gg sets so everything below is shared.

const CHALLONGE_TABS = ["module", "standings", "participants", "settings", "log", "announcements", "discussion", "stations", "predictions", "teams", "groups"];

// Returns the embed page address for a Challonge link, or null if it isn't one.
// Works for challonge.com/<bracket> and community pages like <name>.challonge.com/<bracket>.
function parseChallongeLink(link) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(link) ? link : "https://" + link);
  } catch {
    return null;
  }
  if (!/(^|\.)challonge\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  // skip a language prefix such as /es/<bracket>
  if (parts.length > 1 && /^[a-z]{2}(-[a-z]{2})?$/i.test(parts[0]) && !CHALLONGE_TABS.includes(parts[1].toLowerCase())) parts.shift();
  if (!parts.length || !/^[\w-]+$/.test(parts[0])) return null;
  return `https://${u.hostname.toLowerCase()}/${parts[0]}/module`;
}

const isChallonge = target => typeof target === "string";

async function fetchChallonge(moduleUrl) {
  const html = await getText(moduleUrl, "Challonge");
  const found = /\['TournamentStore'\]\s*=\s*(\{[\s\S]*?\});\s*(?:window\._initialStoreState|\/\/\]\]>|<\/script>)/.exec(html);
  let data;
  try {
    data = JSON.parse(found[1]);
  } catch {
    throw new Error("Could not find a bracket at that Challonge link.");
  }

  const kind = (data.tournament || {}).tournament_type;
  const type = { "single elimination": 1, "double elimination": 2 }[kind];
  if (!type) {
    throw new Error(`That Challonge bracket is ${kind || "an unknown type"}. Only single and double elimination can be shown.`);
  }

  const roundTitles = {};
  for (const r of arr(data.rounds)) roundTitles[r.number] = r.title;

  const names = {};
  const sets = [];
  const matches = Object.values(data.matches_by_round || {}).flat().sort(bySetOrder);
  const idOf = {}; // Challonge's match number -> our id (its place in bracket order)
  matches.forEach((m, i) => (idOf[String(m.identifier)] = i + 1));
  const add = (m, round, label, isGF) => {
    for (const p of [m.player1, m.player2]) {
      if (p && p.id != null) names[p.id] = { full: p.display_name || "", short: p.display_name || "" };
    }
    const done = m.state === "complete";
    let scores = arr(m.scores);
    if (scores.length === 1 && typeof scores[0] === "string") scores = scores[0].split("-");
    scores = scores.slice(0, 2).map(Number);
    if (scores.length !== 2 || !scores.every(Number.isFinite)) scores = [null, null];
    const id = n => (m["player" + n] && m["player" + n].id != null ? m["player" + n].id : null);
    if (done && m.forfeited) scores[id(1) === m.winner_id ? 1 : 0] = -1; // shown as DQ
    const prereq = n => {
      const from = idOf[String(m[`player${n}_prereq_identifier`])];
      return from
        ? { type: "set", id: from, condition: m[`player${n}_is_prereq_match_loser`] ? "loser" : "winner" }
        : { type: "seed" }; // no earlier match: this team starts here
    };
    sets.push({
      id: idOf[String(m.identifier)] || sets.length + 1, // Challonge matches have no id until the bracket starts
      entrant1PrereqType: prereq(1).type, entrant1PrereqId: prereq(1).id, entrant1PrereqCondition: prereq(1).condition,
      entrant2PrereqType: prereq(2).type, entrant2PrereqId: prereq(2).id, entrant2PrereqCondition: prereq(2).condition,
      identifier: String(m.identifier),
      round,
      isGF,
      fullRoundText: label,
      state: done ? 3 : m.underway_at ? 2 : 1,
      entrant1Id: id(1),
      entrant2Id: id(2),
      entrant1Score: scores[0],
      entrant2Score: scores[1],
      winnerId: m.winner_id
    });
  };

  const lastRound = Math.max(0, ...matches.map(m => m.round));
  let finalsSeen = 0;
  for (const m of matches) {
    const title = roundTitles[m.round] || (m.round < 0 ? `Losers Round ${-m.round}` : `Round ${m.round}`);
    // Double elimination: the last round is the grand final, plus the reset match if there is one.
    const isGF = type === 2 && m.round === lastRound;
    add(m, m.round, isGF && finalsSeen++ ? "Grand Final Reset" : title, isGF);
  }
  if (data.third_place_match) {
    idOf[String(data.third_place_match.identifier)] = sets.length + 1;
    add(data.third_place_match, -1, "3rd Place", false);
  }

  const name = /<meta content=(['"])(.*?)\1 property=['"]og:title['"]/.exec(html);
  const title = name
    ? name[2].replace(/\s*-\s*Challonge\s*$/i, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim()
    : "";
  return { type, sets, names, title };
}

// =====================================================================================
// KEEPING THE LINKED BRACKETS UP TO DATE
// =====================================================================================
// Every slot has its own link and is checked on its own, whether or not it is on screen.
// What the site last said about a slot is kept here (it is not saved to disk).

const live = new Map(); // slot id -> { bracket: { type, sets, names }, lastUpdated, lastError, refreshing }

function liveOf(slot) {
  if (!live.has(slot.id)) live.set(slot.id, { bracket: null, lastUpdated: 0, lastError: "", refreshing: false });
  return live.get(slot.id);
}

const slotById = id => store.slots.find(s => s.id === Number(id)) || null;
const selectedSlot = () => slotById(store.selected) || store.slots[0];

function forgetBracket(slot) {
  Object.assign(liveOf(slot), { bracket: null, lastUpdated: 0, lastError: "" });
  slot.overrides = {}; // overrides belong to one bracket
}

function chooseBracket(slot, choice) {
  slot.groupId = choice.id;
  slot.eventName = choice.eventName;
  slot.phaseName = choice.phaseName;
}

async function refresh(slot) {
  const rt = liveOf(slot);
  const groupId = slot.groupId;
  if (rt.refreshing || !groupId) return;
  rt.refreshing = true;
  try {
    const data = isChallonge(groupId) ? await fetchChallonge(groupId) : await fetchStartgg(groupId);
    if (groupId === slot.groupId) { // ignore the answer if the link was changed meanwhile
      rt.bracket = data;
      rt.lastUpdated = Date.now();
      rt.lastError = "";
      if (data.title && data.title !== slot.eventName) { // Challonge: name comes with the bracket
        slot.eventName = data.title;
        saveStore();
      }
    }
  } catch (e) {
    if (groupId === slot.groupId) rt.lastError = String(e.message || e);
  } finally {
    rt.refreshing = false;
  }
}

// Used right after a change in the dock. A background check for the previous link may
// still be running; wait for it to finish so this one isn't skipped.
async function refreshNow(slot) {
  const rt = liveOf(slot);
  for (let i = 0; rt.refreshing && i < 200; i++) await new Promise(r => setTimeout(r, 100));
  await refresh(slot);
}

// The regular check of every slot, one after the other.
let refreshingAll = false;
async function refreshAll() {
  if (refreshingAll) return;
  refreshingAll = true;
  try {
    for (const slot of [...store.slots]) await refresh(slot);
  } finally {
    refreshingAll = false;
  }
}

// =====================================================================================
// LINKED BRACKET -> WHAT THE OVERLAY SHOWS
// =====================================================================================

// For every match of a linked bracket, per team row (top, bottom): the match whose winner
// comes in on that row ("from") and how the row is filled ("entry": "match", "seed" or
// "drop" - see manualView). The overlay uses this to draw the bracket as a tree.
// A match that isn't played because of a bye is skipped over: the line runs from the real
// match before it, or the row counts as a seed if a team simply starts there.
function feedersOf(bracket) {
  if (bracket.feeders) return bracket.feeders;
  const byId = new Map(bracket.sets.map(s => [s.id, s]));
  const isBye = s => s.entrant1PrereqType === "bye" || s.entrant2PrereqType === "bye";
  const row = (s, n, depth) => {
    const type = s[`entrant${n}PrereqType`];
    if (type === "seed") return { entry: "seed" };
    if (type !== "set" || depth > 12) return { entry: "" };
    if (s[`entrant${n}PrereqCondition`] !== "winner") return { entry: "drop" };
    const before = byId.get(s[`entrant${n}PrereqId`]);
    if (!before) return { entry: "" };
    if (!isBye(before)) return { entry: "match", from: String(before.id) };
    // an unplayed bye match: whoever was on its non-bye row comes straight through
    const through = before.entrant1PrereqType === "bye" ? 2 : 1;
    return before[`entrant${through}PrereqType`] === "bye" ? { entry: "" } : row(before, through, depth + 1);
  };
  bracket.feeders = new Map(bracket.sets.map(s => {
    const rows = [row(s, 1, 0), row(s, 2, 0)];
    return [s.id, { from: rows.map(r => r.from || null), entry: rows.map(r => r.entry) }];
  }));
  return bracket.feeders;
}
// One match as the site reports it.
function siteMatch(set, names, slot) {
  const done = set.state === 3;
  const team = n => {
    const id = set[`entrant${n}Id`];
    const score = set[`entrant${n}Score`];
    const otherScore = set[`entrant${3 - n}Score`];
    const won = done && id != null && set.winnerId === id;
    const name = id != null && names[id] ? (slot.showPrefix ? names[id].full : names[id].short) : "";

    let text = "";
    if (score === -1) text = "DQ";
    else if (done && (score == null || otherScore === -1)) text = won ? "W" : "L"; // no game count reported
    else if (score != null) text = String(score);
    else if (otherScore != null) text = "0";
    return { name, logo: "", score: text, winner: won };
  };
  return {
    id: String(set.id),
    label: set.fullRoundText || "",
    state: done ? "done" : set.state === 2 ? "live" : "pending",
    ...(feedersOf(liveOf(slot).bracket).get(set.id) || { from: [], entry: [] }),
    team1: team(1),
    team2: team(2)
  };
}

// The same match with the hand override from the dock applied, if there is one.
function withOverride(match, slot) {
  const o = slot.overrides[match.id];
  if (!o) return match;
  return {
    ...match,
    overridden: true,
    state: o.winner ? "done" : match.state === "done" ? "pending" : match.state,
    team1: { name: o.name1, logo: "", score: o.score1, winner: o.winner === 1 },
    team2: { name: o.name2, logo: "", score: o.score2, winner: o.winner === 2 }
  };
}

// A slot's whole bracket sorted into rounds: winners side, losers side and finals.
function siteRounds(slot) {
  const { sets, type } = liveOf(slot).bracket;

  // A set fed by a bye is not a real match (the player just advances), so it isn't shown.
  const real = sets.filter(s => !s.unreachable && s.entrant1PrereqType !== "bye" && s.entrant2PrereqType !== "bye");

  const toRounds = (list, order) => {
    const byRound = new Map();
    for (const s of list) {
      if (!byRound.has(s.round)) byRound.set(s.round, []);
      byRound.get(s.round).push(s);
    }
    return [...byRound.keys()].sort(order).map(r => byRound.get(r).sort(bySetOrder));
  };

  let finals = real.filter(s => s.isGF).sort((a, b) => a.id - b.id); // grand final, then reset
  let winners = toRounds(real.filter(s => !s.isGF && s.round > 0), (a, b) => a - b);
  let losers = toRounds(real.filter(s => !s.isGF && s.round < 0), (a, b) => b - a);

  if (type !== 2) {
    // Single elimination: the last round is the final; a 3rd place match goes underneath it.
    finals = (winners.pop() || []).concat(losers.flat());
    losers = [];
  }

  // Grand final reset: only played if the losers bracket player wins the first grand final.
  const hidden = new Set();
  if (type === 2 && finals.length > 1) {
    const [gf, reset] = finals;
    const overridden = slot.overrides[String(gf.id)] || slot.overrides[String(reset.id)];
    if (!overridden && gf.state === 3 && !(reset.entrant1Id && reset.entrant2Id)) hidden.add(reset.id);
  }
  return { winners, losers, finals, hidden };
}

function siteView(slot) {
  const { bracket } = liveOf(slot);
  if (!bracket) return null;
  const { winners, losers, finals, hidden } = siteRounds(slot);
  const { names } = bracket;

  // "Top 8" = last 2 winners rounds + last 4 losers rounds + grand final, and so on.
  const cut = top => {
    const depth = Math.max(0, Math.round(Math.log2(top)) - 1);
    return {
      winners: depth ? winners.slice(-depth) : [],
      losers: depth ? losers.slice(-depth * 2) : []
    };
  };
  const hasPlayers = v => [...v.winners, ...v.losers].flat().concat(finals)
    .some(s => s.entrant1Id || s.entrant2Id || slot.overrides[String(s.id)]);

  let shown = { winners, losers };
  let viewName = "all";
  if (slot.view === "auto") {
    // Follow the event: show the top 8, or more of the bracket while the top 8 is still empty.
    for (const top of [8, 16, 32]) {
      const v = cut(top);
      if (hasPlayers(v)) { shown = v; viewName = String(top); break; }
    }
  } else if (slot.view !== "all") {
    shown = cut(Number(slot.view));
    viewName = slot.view;
  }
  if (slot.side === "winners") shown.losers = [];
  if (slot.side === "losers") shown.winners = [];

  const match = s => withOverride(siteMatch(s, names, slot), slot);
  const column = round => ({ title: round[0].fullRoundText || "", matches: round.map(match) });
  return {
    view: viewName,
    winners: shown.winners.map(column),
    losers: shown.losers.map(column),
    finals: finals.map(s => ({ ...match(s), notNeeded: hidden.has(s.id) }))
  };
}

// Name of a slot in the dock, e.g. "MOSEF 2026 Smash Solos: Varsity Class 2 - Section 1".
const slotLabel = slot => [slot.tournamentName || slot.eventName, slot.phaseName].filter(Boolean).join(" - ");

// Title on the overlay: what was typed in the dock, else the tournament name from the site.
const slotTitle = slot => slot.title || slot.tournamentName || slot.eventName || "Playoffs";

// Everything the dock needs about one slot. "withMatches" adds every match (for overrides);
// only the slot open in the dock needs that.
function slotPayload(slot, withMatches) {
  const { bracket, lastUpdated, lastError } = liveOf(slot);
  let rounds = [];
  let total = 0, done = 0;
  if (bracket) {
    const { winners, losers, finals } = siteRounds(slot);
    const entry = s => {
      const m = siteMatch(s, bracket.names, slot);
      total++;
      if (m.state === "done") done++;
      return { ...m, override: slot.overrides[m.id] || null };
    };
    rounds = [...winners, ...losers].map(r => ({ title: r[0].fullRoundText || "", matches: r.map(entry) }));
    if (finals.length) rounds.push({ title: "Finals", matches: finals.map(entry) });
  }
  return {
    id: slot.id,
    label: slotLabel(slot),
    config: slot,
    loaded: !!bracket,
    bracketType: bracket ? BRACKET_TYPES[bracket.type] : "",
    entrants: bracket ? Object.keys(bracket.names).length : 0,
    matchesDone: done,
    matchesTotal: total,
    rounds: withMatches ? rounds : [],
    lastUpdated,
    error: lastError,
    refreshSeconds: REFRESH_MS / 1000
  };
}

// The slot the main overlay shows: the one selected in the dock, or - with rotation on -
// each ticked slot in turn. The turn is worked out from the clock, so every overlay agrees.
function shownSlot() {
  const turn = store.slots.filter(s => s.inRotation && liveOf(s).bracket);
  if (store.rotate.on && turn.length > 1) {
    return turn[Math.floor(Date.now() / (store.rotate.seconds * 1000)) % turn.length];
  }
  return selectedSlot();
}

function slotOverlay(slot) {
  const view = slot ? siteView(slot) : null;
  return {
    ready: !!view,
    source: "site",
    slot: slot ? slot.id : null,
    title: slot ? slotTitle(slot) : "",
    ...(view || { winners: [], losers: [], finals: [] })
  };
}

// What an overlay draws. An overlay opened with ?slot=3 always gets slot 3; the main overlay
// gets whatever the dock is set to.
function overlayPayload(slotId) {
  if (slotId) return slotOverlay(slotById(slotId));
  if (store.source === "manual") {
    return { ready: true, source: "manual", title: store.manual.title || "Playoffs", ...manualView() };
  }
  return slotOverlay(shownSlot());
}

function dockPayload() {
  const selected = selectedSlot().id;
  return {
    source: store.source,
    manual: manualPayload(),
    selected,
    rotate: store.rotate,
    maxSlots: MAX_SLOTS,
    slots: store.slots.map(s => slotPayload(s, s.id === selected))
  };
}

// =====================================================================================
// CHANGES FROM THE DOCK
// =====================================================================================

function applyManual(input) {
  // A team count or type that makes no sense leaves the current bracket alone
  // (instead of falling back to the default and wiping the scores).
  if (input && typeof input === "object") {
    const n = parseInt(input.teamCount, 10);
    if (!(n >= MIN_TEAMS && n <= MAX_TEAMS)) input.teamCount = store.manual.teamCount;
    if (!TYPES[input.type]) input.type = store.manual.type;
  }
  const next = cleanManual(input);
  if (next.teamCount !== store.manual.teamCount || next.type !== store.manual.type) {
    // Different bracket = different matches. Teams stay, every score starts at 0-0.
    for (const id in next.scores) next.scores[id] = [0, 0];
    store.manual = next;
  } else {
    store.manual = resetChangedMatches(store.manual, next);
  }
  saveStore();
}

// Settings for one slot. Everything is optional; only what's sent is changed.
async function applySite(slot, input) {
  if (typeof input.title === "string") slot.title = input.title.trim().slice(0, 60);
  if (VIEWS.includes(input.view)) slot.view = input.view;
  if (SIDES.includes(input.side)) slot.side = input.side;
  if (typeof input.showPrefix === "boolean") slot.showPrefix = input.showPrefix;
  if (typeof input.inRotation === "boolean") slot.inRotation = input.inRotation;

  if (typeof input.url === "string") {
    const link = input.url.trim().slice(0, 500);
    const blank = { groupId: null, tournamentName: "", eventName: "", phaseName: "", choices: [] };
    if (!link) {
      // Cleared: stop showing a bracket.
      Object.assign(slot, blank, { url: "" });
      forgetBracket(slot);
    } else if (parseChallongeLink(link)) {
      Object.assign(slot, blank, { url: link, groupId: parseChallongeLink(link) });
      forgetBracket(slot);
    } else {
      const found = await resolveLink(link); // throws with a readable message if the link is bad
      Object.assign(slot, blank, { url: link, tournamentName: found.tournamentName, choices: found.choices });
      forgetBracket(slot);
      if (found.choices.length === 1) chooseBracket(slot, found.choices[0]);
    }
  }

  if (input.groupId != null) {
    const choice = slot.choices.find(c => c.id === Number(input.groupId));
    if (choice && choice.id !== slot.groupId) {
      chooseBracket(slot, choice);
      forgetBracket(slot);
    }
  }

  saveStore();
  if (slot.groupId && !liveOf(slot).bracket) await refreshNow(slot);
}

// { id, override: { name1, name2, score1, score2, winner } }  set an override
// { id, override: null }                                      remove it
// { clear: true }                                             remove all of them
function applyOverride(slot, input) {
  if (input.clear) {
    slot.overrides = {};
  } else {
    const id = String(input.id == null ? "" : input.id).slice(0, 60);
    if (!id) throw new Error("No match given");
    const o = input.override;
    if (!o) {
      delete slot.overrides[id];
    } else {
      const text = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
      slot.overrides[id] = {
        name1: text(o.name1, 60),
        name2: text(o.name2, 60),
        score1: text(o.score1, 3),
        score2: text(o.score2, 3),
        winner: [1, 2].includes(Number(o.winner)) ? Number(o.winner) : 0
      };
    }
  }
  saveStore();
}

// { add: true }                 add an empty slot and open it
// { remove: <id> }              remove a slot (the last one left is emptied instead)
// { select: <id> }              open a slot in the dock = show it on the main overlay
// { rotate: { on, seconds } }   rotation of the main overlay
function applySlots(input) {
  if (input.add && store.slots.length < MAX_SLOTS) {
    // Slot numbers are never shuffled, so "?slot=3" in OBS keeps pointing at the same slot.
    const id = Math.max(...store.slots.map(s => s.id)) + 1;
    store.slots.push({ ...defaultSite(), id });
    store.selected = id;
  }
  if (input.remove != null) {
    const slot = slotById(input.remove);
    if (slot && store.slots.length > 1) {
      store.slots = store.slots.filter(s => s !== slot);
      live.delete(slot.id);
      if (store.selected === slot.id) store.selected = store.slots[0].id;
    } else if (slot) {
      Object.assign(slot, defaultSite(), { id: slot.id });
      live.delete(slot.id);
    }
  }
  if (input.select != null && slotById(input.select)) store.selected = Number(input.select);
  if (input.rotate && typeof input.rotate === "object") {
    if (typeof input.rotate.on === "boolean") store.rotate.on = input.rotate.on;
    const seconds = parseInt(input.rotate.seconds, 10);
    if (seconds >= 5 && seconds <= 600) store.rotate.seconds = seconds;
  }
  saveStore();
}

// =====================================================================================
// HTTP
// =====================================================================================

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};
const LOGO_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

function send(res, status, body, type = MIME[".json"]) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Filename",
    "Access-Control-Allow-Private-Network": "true"
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const readJson = async req => JSON.parse((await readBody(req, 1024 * 1024)).toString("utf8"));

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { error: "not found" });
    send(res, 200, data, MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const p = decodeURIComponent(url.pathname);
  const get = req.method === "GET", post = req.method === "POST";

  try {
    if (req.method === "OPTIONS") return send(res, 204, "");

    if (get && (p === "/" || p === "/dock.html")) return serveFile(res, path.join(ROOT, "dock.html"));
    // The overlay normally lives in the EsportsDash app folder (so the fallback works when this
    // tool is closed), but it can also be opened straight from here.
    if (get && (p === "/overlay" || p === "/overlay/bracket-tool.html")) {
      return serveFile(res, path.join(ROOT, "overlay", "bracket-tool.html"));
    }
    if (get && p.startsWith("/fonts/")) return serveFile(res, path.join(FONT_DIR, path.basename(p)));
    if (get && p.startsWith("/logos/")) return serveFile(res, path.join(LOGO_DIR, path.basename(p)));

    // "/api/bracket" is the main overlay; "/api/bracket?slot=3" is always slot 3.
    if (get && p === "/api/bracket") return send(res, 200, overlayPayload(url.searchParams.get("slot")));
    if (get && p === "/api/state") return send(res, 200, dockPayload());

    if (post && p === "/api/source") {
      const input = await readJson(req);
      if (SOURCES.includes(input.source) && input.source !== store.source) {
        store.source = input.source;
        saveStore();
      }
      return send(res, 200, dockPayload());
    }

    if (post && p === "/api/manual") {
      applyManual(await readJson(req));
      return send(res, 200, manualPayload());
    }

    // The three below change linked brackets. "slot" in the request says which one
    // (default: the one open in the dock).
    if (post && p === "/api/site") {
      const input = await readJson(req);
      try {
        await applySite(slotById(input.slot) || selectedSlot(), input);
      } catch (e) {
        return send(res, 400, { ...dockPayload(), error: String(e.message || e) });
      }
      return send(res, 200, dockPayload());
    }

    if (post && p === "/api/override") {
      const input = await readJson(req);
      applyOverride(slotById(input.slot) || selectedSlot(), input);
      return send(res, 200, dockPayload());
    }

    if (post && p === "/api/slots") {
      applySlots(await readJson(req));
      return send(res, 200, dockPayload());
    }

    if (get && p === "/api/logos") {
      const files = fs.readdirSync(LOGO_DIR)
        .filter(f => LOGO_EXT.includes(path.extname(f).toLowerCase()))
        .sort((a, b) => a.localeCompare(b));
      return send(res, 200, files.map(f => ({ name: f, url: "/logos/" + encodeURIComponent(f) })));
    }

    if (post && p === "/api/upload") {
      const original = decodeURIComponent(req.headers["x-filename"] || "logo.png");
      const ext = path.extname(original).toLowerCase();
      if (!LOGO_EXT.includes(ext)) return send(res, 400, { error: "Logo must be png, jpg, gif, webp or svg" });
      const safeBase = path.basename(original, path.extname(original)).replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "logo";
      const body = await readBody(req, 10 * 1024 * 1024);
      let name = safeBase + ext;
      for (let i = 2; fs.existsSync(path.join(LOGO_DIR, name)); i++) name = `${safeBase} (${i})${ext}`;
      fs.writeFileSync(path.join(LOGO_DIR, name), body);
      return send(res, 200, { name, url: "/logos/" + encodeURIComponent(name) });
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: String(err.message || err) });
  }
});

server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use. Is Bracket Tool already running in another window?\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

if (require.main === module) server.listen(PORT, HOST, () => {
  console.log("Bracket Tool is running.");
  console.log(`  Dock (add as an OBS Custom Browser Dock): ${BASE_URL}/`);
  console.log(`  Logos folder: ${LOGO_DIR}`);
  console.log(`  Linked brackets (start.gg / Challonge) are checked every ${REFRESH_MS / 1000} seconds.`);
  console.log("Leave this window open while streaming. Close it to stop.");
  refreshAll();
  setInterval(refreshAll, REFRESH_MS);
});

module.exports = { makeFormat, buildBracket, defaultManual, matchList };
