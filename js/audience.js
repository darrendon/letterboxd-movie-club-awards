// Play-along, host side.
//
// Phones and the host tab talk through a free public relay (see relay.js), and the host tab
// is the referee. Each phone sees the question (never the answer), picks a team once, and
// locks in one answer per question. The host checks and scores it on the spot: the faster a
// right answer comes in, the more it's worth. A team's score for a question is the average of
// its players' points, so a team of three isn't at a disadvantage against a team of six.

import { Relay, connectAny, brokerFor, makeCode, TOPIC_ROOT } from "./relay.js?v=__V__";

const STORE_KEY = "mcawards.audience.v1";
export const MAX_POINTS = 1000;
export const MIN_POINTS = 100;
export const DEFAULT_TIME = 30; // seconds a right answer takes to drop from MAX to MIN; answers close then
const ACTIVE_MS = 70000; // a phone counts as here if it checked in this recently

export const DEFAULT_TEAMS = ["Best Picture", "Best Director", "Best Score", "Best Costumes"];

export const aud = {
  on: false,
  status: "off", // off | connecting | live | down | error
  error: "",
  code: null,
  teams: [...DEFAULT_TEAMS],
  players: {}, // id -> { name, team, seen }
  books: {}, // qid -> { id -> { text, sp, ok, at } }
  opened: {}, // qid -> when the question opened (host clock)
  revealed: [], // qids whose answers have been revealed
};

let relay = null;
let topic = "";
let current = null; // { qid, open, revealed, q, time, double, round }
let onChange = () => {};
let lastSent = "";
let sendTimer = null;

export function setOnChange(fn) {
  onChange = fn;
}

function save() {
  try {
    const { on, code, teams, players, books, opened, revealed } = aud;
    localStorage.setItem(STORE_KEY, JSON.stringify({ on, code, teams, players, books, opened, revealed }));
  } catch {
    /* storage unavailable */
  }
}

export function loadAudience() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (s)
      Object.assign(aud, {
        on: !!s.on,
        code: s.code || null,
        teams: Array.isArray(s.teams) && s.teams.length ? s.teams : [...DEFAULT_TEAMS],
        players: s.players || {},
        books: s.books || {},
        opened: s.opened || {},
        revealed: s.revealed || [],
      });
  } catch {
    /* fresh start */
  }
  return aud.on;
}

export function setTeams(list) {
  const clean = [...new Set(list.map((t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 24)).filter(Boolean))].slice(0, 8);
  aud.teams = clean.length ? clean : [...DEFAULT_TEAMS];
  // Anyone on a team that no longer exists has to pick again.
  for (const p of Object.values(aud.players)) if (p.team && !aud.teams.includes(p.team)) p.team = "";
  save();
  lastSent = "";
  publishSoon();
  onChange();
}

export function joinUrl() {
  const base = location.href.split(/[?#]/)[0].replace(/index\.html$/, "").replace(/\/?$/, "/");
  const extra = new URLSearchParams(location.search).get("broker");
  return `${base}play/?code=${aud.code}${extra ? `&broker=${encodeURIComponent(extra)}` : ""}`;
}

export function shortUrl() {
  return joinUrl()
    .replace(/^https?:\/\//, "")
    .replace(/\?.*$/, "")
    .replace(/\/$/, "");
}

// Points for a right answer that came in this long after the question appeared.
export function speedPoints(ms, seconds = DEFAULT_TIME) {
  const share = Math.min(1, Math.max(0, ms) / (seconds * 1000));
  return Math.max(MIN_POINTS, Math.round((MAX_POINTS - (MAX_POINTS - MIN_POINTS) * share) / 10) * 10);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function startAudience() {
  if (relay) return;
  aud.on = true;
  aud.status = "connecting";
  aud.error = "";
  save();
  onChange();
  const handlers = {
    onMessage: (t, m) => handle(m),
    onStatus: (s) => {
      if (!aud.on) return;
      aud.status = s === "live" ? "live" : s === "down" ? "down" : "connecting";
      if (s === "live") lastSent = "";
      onChange();
      if (s === "live") publishSoon();
    },
  };
  try {
    const existing = aud.code && brokerFor(aud.code);
    if (existing) {
      relay = new Relay(existing.url, handlers);
      await relay.connect(10000).catch(async () => {
        relay = null;
        const r = await connectAny(handlers);
        relay = r.relay;
        aud.code = makeCode(r.broker.key);
      });
    } else {
      const r = await connectAny(handlers);
      relay = r.relay;
      aud.code = makeCode(r.broker.key);
    }
    topic = TOPIC_ROOT + aud.code;
    relay.subscribe(topic + "/h");
    aud.status = "live";
    save();
    lastSent = "";
    publishSoon();
  } catch {
    relay = null;
    aud.status = "error";
    aud.error = "Couldn't reach any of the free relays. Check the internet connection and try again.";
  }
  onChange();
}

export function stopAudience() {
  aud.on = false;
  aud.status = "off";
  if (relay) {
    relay.publish(topic + "/s", { v: 1, closed: true }, true);
    const r = relay;
    setTimeout(() => r.close(), 400);
  }
  relay = null;
  save();
  onChange();
}

// A brand new room code (phones have to join again). Scores are kept.
export function newRoom() {
  const wasOn = aud.on;
  stopAudience();
  aud.code = null;
  save();
  if (wasOn) startAudience();
}

export function resetScores() {
  aud.books = {};
  aud.opened = {};
  aud.revealed = [];
  save();
  lastSent = "";
  publishSoon();
  onChange();
}

export function removePlayer(id) {
  delete aud.players[id];
  save();
  lastSent = "";
  publishSoon();
  onChange();
}

// ---------------------------------------------------------------------------
// Messages from phones
// ---------------------------------------------------------------------------

function handle(m) {
  if (!m || typeof m.id !== "string" || m.id.length > 40) return;
  const now = Date.now();
  if (m.t === "join") {
    const name = String(m.name || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20);
    if (!name) return;
    const known = aud.players[m.id];
    const team = aud.teams.includes(m.team) ? m.team : "";
    aud.players[m.id] = { name, team, seen: now };
    if (!known || known.name !== name || known.team !== team) {
      save();
      onChange();
    }
    publishSoon();
  } else if (m.t === "answer") {
    const p = aud.players[m.id];
    if (!p) return;
    p.seen = now;
    const c = current;
    if (!c || !c.open || m.qid !== c.qid) return publishSoon();
    const book = (aud.books[c.qid] ||= {});
    if (book[m.id]) return publishSoon(); // one answer each
    const opened = aud.opened[c.qid] || now;
    if (now - opened > c.time * 1000 + 1500) return publishSoon(); // time's up
    const text = String(m.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!text) return;
    const ok = text === c.q.answer;
    book[m.id] = { text, sp: speedPoints(now - opened, c.time), ok, at: now - opened, team: p.team };
    save();
    onChange();
    publishSoon();
  }
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

export const pointsFor = (g, double = false) => (g.ok ? g.sp * (double ? 2 : 1) : 0);

let doubleFor = () => false;
// app.js tells us which questions are worth double.
export function setDoubleLookup(fn) {
  doubleFor = fn;
}

// Individual totals.
export function scores() {
  const total = {};
  for (const id of Object.keys(aud.players)) total[id] = 0;
  for (const qid of aud.revealed) {
    const d = doubleFor(qid);
    for (const [id, g] of Object.entries(aud.books[qid] || {})) total[id] = (total[id] || 0) + pointsFor(g, d);
  }
  return total;
}

// A team's points on one question: the average over its current members (no answer = 0).
export function teamPointsOn(qid, team) {
  const members = Object.entries(aud.players).filter(([, p]) => p.team === team);
  if (!members.length) return { pts: 0, right: 0, size: 0, answered: 0 };
  const book = aud.books[qid] || {};
  const d = doubleFor(qid);
  let sum = 0;
  let right = 0;
  let answered = 0;
  for (const [id] of members) {
    const g = book[id];
    if (!g) continue;
    answered++;
    if (g.ok) right++;
    sum += pointsFor(g, d);
  }
  return { pts: Math.round(sum / members.length), right, size: members.length, answered };
}

export function teamStandings() {
  const rows = aud.teams.map((team) => {
    let pts = 0;
    let right = 0;
    for (const qid of aud.revealed) {
      const r = teamPointsOn(qid, team);
      pts += r.pts;
      right += r.right;
    }
    const size = Object.values(aud.players).filter((p) => p.team === team).length;
    return { team, pts, right, size };
  });
  rows.sort((a, b) => b.pts - a.pts || a.team.localeCompare(b.team));
  let rank = 0;
  let prev = null;
  rows.forEach((r, i) => {
    if (r.pts !== prev) rank = i + 1;
    prev = r.pts;
    r.rank = rank;
  });
  return rows;
}

// Players sorted by score (the MVP race).
export function standings() {
  const total = scores();
  const rows = Object.entries(aud.players)
    .map(([id, p]) => ({ id, name: p.name, team: p.team, pts: total[id] || 0 }))
    .sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name));
  let rank = 0;
  let prev = null;
  rows.forEach((r, i) => {
    if (r.pts !== prev) rank = i + 1;
    prev = r.pts;
    r.rank = rank;
  });
  return rows;
}

export const playerCount = () => Object.keys(aud.players).length;
export const activeCount = () => Object.values(aud.players).filter((p) => Date.now() - p.seen < ACTIVE_MS).length;
export const unteamed = () => Object.values(aud.players).filter((p) => !p.team).length;

// How a question went: how many answered, how many right, the fastest right answer.
export function questionStats(qid = current?.qid) {
  const list = Object.entries(aud.books[qid] || {});
  const right = list.filter(([, g]) => g.ok).sort((a, b) => a[1].at - b[1].at);
  const best = right[0];
  const d = doubleFor(qid);
  return {
    answered: list.length,
    right: right.length,
    fastest: best ? { name: aud.players[best[0]]?.name || "?", team: aud.players[best[0]]?.team || "", pts: pointsFor(best[1], d), secs: Math.round(best[1].at / 100) / 10 } : null,
    teams: aud.teams.map((t) => ({ team: t, ...teamPointsOn(qid, t) })).sort((a, b) => b.pts - a.pts),
  };
}

// How many picked each choice (for the reveal bar chart).
export function choiceCounts(qid, choices) {
  const counts = choices.map(() => 0);
  for (const g of Object.values(aud.books[qid] || {})) {
    const i = choices.indexOf(g.text);
    if (i >= 0) counts[i]++;
  }
  return counts;
}

export const currentQid = () => current?.qid || null;
export const isRevealed = (qid) => aud.revealed.includes(qid);
export const openedAt = (qid) => aud.opened[qid] || null;

// ---------------------------------------------------------------------------
// Keeping up with the game
// ---------------------------------------------------------------------------

// Called on every redraw with the question on screen (or null).
export function syncQuestion(info) {
  current = info;
  if (info) {
    if (info.open && !aud.opened[info.qid]) {
      aud.opened[info.qid] = Date.now();
      save();
    }
    if (info.revealed && !aud.revealed.includes(info.qid)) {
      aud.revealed.push(info.qid);
      save();
    }
  }
  publishSoon();
}

let screenInfo = null; // { screen, roundTitle, roundNo, roundCount } for phones between questions
export function syncScreen(info) {
  screenInfo = info;
  publishSoon();
}

function publishSoon() {
  if (!relay || !aud.on) return;
  if (sendTimer) return;
  sendTimer = setTimeout(() => {
    sendTimer = null;
    publishNow();
  }, 120);
}

function publishNow() {
  if (!relay || !aud.on) return;
  const c = current;
  const rows = standings();
  const teams = teamStandings();
  const revealed = c ? aud.revealed.includes(c.qid) : false;
  const book = c ? aud.books[c.qid] || {} : {};
  const lastQid = [...aud.revealed].reverse().find((x) => x !== c?.qid || revealed);
  const lastBook = aud.books[lastQid] || {};
  const lastDouble = doubleFor(lastQid);
  const players = {};
  for (const r of rows) {
    const mine = book[r.id];
    const last = lastBook[r.id];
    players[r.id] = {
      n: r.name,
      t: r.team,
      p: r.pts,
      r: r.rank,
      g: mine ? (revealed ? [mine.ok ? 1 : 0, pointsFor(mine, c.double), mine.text] : 1) : 0,
      l: last ? [last.ok ? 1 : 0, pointsFor(last, lastDouble)] : null,
    };
  }
  const q = c?.q;
  const msg = {
    v: 1,
    room: aud.code,
    teamList: aud.teams,
    count: rows.length,
    teams: teams.map((t) => [t.team, t.pts, t.rank, t.size]),
    top: rows.slice(0, 5).map((r) => [r.name, r.pts, r.rank, r.team]),
    players,
    screen: screenInfo,
    q: c
      ? {
          qid: c.qid,
          open: !!c.open,
          revealed,
          double: !!c.double,
          time: c.time,
          left: c.open ? Math.max(0, c.time * 1000 - (Date.now() - (aud.opened[c.qid] || Date.now()))) : 0,
          round: c.round || "",
          text: q.prompt,
          quote: q.quote || null,
          top4: q.top4 || null,
          choices: q.choices,
        }
      : null,
    answer: c && revealed ? q.answer : null,
    stats: c && revealed ? questionStats(c.qid) : null,
  };
  const json = JSON.stringify(msg);
  if (json === lastSent) return;
  lastSent = json;
  relay.publish(topic + "/s", msg, true);
}
