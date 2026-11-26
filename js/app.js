// Letterboxd Movie Club Awards: trivia night.
//
// Host screen (index.html): every control, and the answer to each question before the reveal.
// Board (index.html?view=board): just what the room should see, for the TV. The two talk over
// a BroadcastChannel, so open both in the same browser on the same computer.
// Phones join with a room code (see audience.js and play.js).

import qrcode from "./vendor/qrcode.mjs";
import { playSound, stopSound, toggleMute, isMuted } from "./sounds.js?v=__V__";
import {
  aud,
  loadAudience,
  setOnChange,
  startAudience,
  stopAudience,
  newRoom,
  resetScores,
  removePlayer,
  setTeams,
  setDoubleLookup,
  syncQuestion,
  syncScreen,
  joinUrl,
  shortUrl,
  standings,
  teamStandings,
  teamPointsOn,
  questionStats,
  choiceCounts,
  playerCount,
  activeCount,
  unteamed,
  openedAt,
  qType,
  shownOrder,
  answerText,
  answerGroups,
  flipAnswers,
  ORDER_SEP,
  DEFAULT_TIME,
  MAX_POINTS,
  MIN_POINTS,
} from "./audience.js?v=__V__";

const STORE_KEY = "mcawards.game.v1";
const IS_BOARD = new URLSearchParams(location.search).get("view") === "board";
const channel = "BroadcastChannel" in window ? new BroadcastChannel("mcawards") : null;
const send = (msg) => channel?.postMessage(msg);

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pts = (n) => Number(n || 0).toLocaleString("en-US");
const app = document.getElementById("app");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let game = null; // the loaded game file
let state = null; // { screen, r, q, open, revealed, timeUp, lb }
let clockTimer = null;

// Screens: start | lobby | round | question | standings | final
function fresh() {
  return { screen: "lobby", r: 0, q: 0, open: false, revealed: false, timeUp: false, lb: false };
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ gameId: game?.id || null, game, state }));
  } catch {
    /* storage unavailable */
  }
}

function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (s?.game && s?.state) {
      game = s.game;
      state = s.state;
      return true;
    }
  } catch {
    /* fresh start */
  }
  return false;
}

const qid = (r = state.r, q = state.q) => `r${r}q${q}`;
const round = () => game.rounds[state.r];
const question = () => round().questions[state.q];
const roundTime = (r = round()) => Number(r.time) || Number(game.time) || DEFAULT_TIME;
const totalQuestions = () => game.rounds.reduce((n, r) => n + r.questions.length, 0);
const questionNo = () => game.rounds.slice(0, state.r).reduce((n, r) => n + r.questions.length, 0) + state.q + 1;

setDoubleLookup((id) => {
  if (!game || !id) return false;
  const m = /^r(\d+)q(\d+)$/.exec(id);
  return !!(m && game.rounds[+m[1]]?.double);
});

// ---------------------------------------------------------------------------
// Loading a game
// ---------------------------------------------------------------------------

async function loadGame(id) {
  const res = await fetch(`games/${id}.json`);
  if (!res.ok) throw new Error(`Couldn't load games/${id}.json`);
  const g = await res.json();
  g.id = id;
  return g;
}

async function startGame(id) {
  try {
    game = await loadGame(id);
  } catch (e) {
    alert(e.message);
    return;
  }
  state = fresh();
  save();
  render();
}

// ---------------------------------------------------------------------------
// Moving through the game
// ---------------------------------------------------------------------------

function advance() {
  if (!state || state.screen === "start") return;
  if (state.lb) {
    state.lb = false;
    return render();
  }
  switch (state.screen) {
    case "lobby":
      state.screen = "round";
      playSoundEverywhere("round");
      break;
    case "round":
      state.screen = "question";
      state.open = true;
      state.revealed = false;
      state.timeUp = false;
      playSoundEverywhere("question");
      break;
    case "question":
      if (!state.revealed) {
        state.open = false;
        state.revealed = true;
        playSoundEverywhere("reveal");
      } else if (state.q + 1 < round().questions.length) {
        state.q += 1;
        state.open = true;
        state.revealed = false;
        state.timeUp = false;
        playSoundEverywhere("question");
      } else {
        state.screen = "standings";
        playSoundEverywhere("standings");
      }
      break;
    case "standings":
      if (state.r + 1 < game.rounds.length) {
        state.r += 1;
        state.q = 0;
        state.screen = "round";
        playSoundEverywhere("round");
      } else {
        state.screen = "final";
        playSoundEverywhere("winner");
      }
      break;
    case "final":
      break;
  }
  save();
  render();
}

function back() {
  if (!state) return;
  if (state.screen === "question" && !state.revealed) {
    // Un-open the question: back to the round card (or previous reveal).
    if (state.q === 0) state.screen = "round";
    else {
      state.q -= 1;
      state.revealed = true;
    }
    state.open = false;
  } else if (state.screen === "standings") {
    state.screen = "question";
    state.q = round().questions.length - 1;
    state.revealed = true;
    state.open = false;
  } else if (state.screen === "round" && state.r > 0) {
    state.r -= 1;
    state.screen = "standings";
  } else if (state.screen === "final") {
    state.screen = "standings";
  }
  save();
  render();
}

function closeAnswers() {
  if (state.screen === "question" && state.open) {
    state.open = false;
    state.timeUp = true;
    playSoundEverywhere("timesup");
    save();
    render();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  if (IS_BOARD) return renderBoard();
  clearInterval(clockTimer);
  if (!game || !state) {
    syncQuestion(null);
    syncScreen({ screen: "start" });
    renderStart();
  } else {
    const onQ = state.screen === "question";
    syncQuestion(
      onQ
        ? { qid: qid(), open: state.open, revealed: state.revealed, q: question(), time: roundTime(), double: !!round().double, round: round().title }
        : null
    );
    syncScreen({ screen: state.screen, roundTitle: round()?.title || "", roundNo: state.r + 1, roundCount: game.rounds.length, title: game.title });
    const fn = { lobby: renderLobby, round: renderRound, question: renderQuestion, standings: renderStandings, final: renderFinal }[state.screen];
    fn();
    if (onQ && state.open) clockTimer = setInterval(tickClock, 200);
  }
  broadcast();
}

function tickClock() {
  const t0 = openedAt(qid());
  if (!t0) return;
  const left = Math.max(0, roundTime() * 1000 - (Date.now() - t0));
  for (const el of document.querySelectorAll(".clock-fill")) el.style.width = `${(left / (roundTime() * 1000)) * 100}%`;
  for (const el of document.querySelectorAll(".clock-num")) el.textContent = Math.ceil(left / 1000);
  const st = questionStats(qid());
  const c = document.getElementById("live-count");
  if (c) c.textContent = `${st.answered} of ${playerCount()} locked in`;
  if (left <= 0 && state.open) closeAnswers();
}

function topbar(extra = "") {
  const status = aud.on
    ? `<span class="aud-dot ${aud.status}"></span> Room <b>${esc(aud.code || "…")}</b> · ${activeCount()}/${playerCount()} phones${unteamed() ? ` · <span class="warn">${unteamed()} picking a team</span>` : ""}`
    : `<span class="aud-dot off"></span> Play-along off`;
  return `<header class="topbar">
    <div class="topbar-left">${status}</div>
    <div class="topbar-right">${extra}
      <button class="btn small ghost" id="btn-board" title="Open the TV board (B)">${boardOpen ? "📺 Board on" : "📺 Open board"}</button>
      <button class="btn small ghost" id="btn-lb" title="Leaderboard (0)">🏆</button>
      <button class="btn small ghost" id="btn-mute" title="Mute (M)">${isMuted() ? "🔇" : "🔊"}</button>
      <button class="btn small ghost" id="btn-home" title="Back to setup">⚙︎</button>
    </div>
  </header>`;
}

function wireTopbar() {
  document.getElementById("btn-board")?.addEventListener("click", openBoard);
  document.getElementById("btn-lb")?.addEventListener("click", () => {
    state.lb = !state.lb;
    render();
  });
  document.getElementById("btn-mute")?.addEventListener("click", () => {
    toggleMute();
    render();
  });
  document.getElementById("btn-home")?.addEventListener("click", () => {
    if (confirm("Back to setup? The game is saved; you can resume it from there.")) {
      const g = game;
      const s = state;
      game = null;
      state = null;
      stash = { game: g, state: s };
      render();
    }
  });
}

let stash = null;

function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  return `<svg class="qr" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges" aria-label="QR code"><rect width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const joinBlock = (big = false) =>
  aud.on && aud.code && aud.status !== "connecting"
    ? `<div class="join ${big ? "big" : ""}">${qrSvg(joinUrl())}<div class="join-text"><div class="join-url">${esc(shortUrl())}</div><div class="join-code">${esc(aud.code)}</div></div></div>`
    : "";

// --- Start / setup ---------------------------------------------------------

async function renderStart() {
  let list = [];
  try {
    list = await (await fetch("games/index.json")).json();
  } catch {
    list = [];
  }
  const saved = stash || (() => {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      return s?.game && s?.state ? s : null;
    } catch {
      return null;
    }
  })();
  app.innerHTML = `<main class="screen start">
    <div class="marquee">
      <div class="marquee-kicker">Letterboxd Movie Club</div>
      <h1 class="marquee-title">Awards <em>Trivia</em></h1>
    </div>
    <div class="start-grid">
      <section class="card">
        <h2>1. Play-along</h2>
        <p class="small">Everyone joins on their phone with a room code and picks a team. Right answers are worth ${pts(MAX_POINTS)} points if they're quick, dropping to ${pts(MIN_POINTS)} as the clock runs down. A team scores the average of its players, so small teams aren't at a disadvantage.</p>
        ${
          aud.on
            ? `<div class="aud-status"><span class="aud-dot ${aud.status}"></span> ${aud.status === "live" ? "Live" : aud.status === "error" ? esc(aud.error) : "Connecting…"}</div>
               ${joinBlock()}
               <p class="small">${playerCount()} joined${unteamed() ? `, ${unteamed()} still picking a team` : ""}.</p>
               <div class="row"><button class="btn small ghost" id="aud-new">New room code</button><button class="btn small ghost" id="aud-reset">Reset scores</button><button class="btn small ghost" id="aud-off">Turn off</button></div>`
            : `<button class="btn primary" id="aud-on">Turn on play-along</button>`
        }
        <h3>Teams</h3>
        <p class="small">One per line. Players pick one when they join.</p>
        <textarea id="teams" rows="4">${esc(aud.teams.join("\n"))}</textarea>
        <button class="btn small" id="teams-save">Save teams</button>
        ${playersHtml()}
      </section>
      <section class="card">
        <h2>2. Pick a game</h2>
        ${saved ? `<button class="btn primary" id="resume">▶ Resume “${esc(saved.game.title)}”</button><p class="small">Round ${saved.state.r + 1}, question ${saved.state.q + 1}.</p>` : ""}
        <ul class="games">${list
          .map((g) => `<li><button class="btn wide" data-game="${esc(g.id)}"><b>${esc(g.title)}</b><span>${esc(g.description || "")}</span></button></li>`)
          .join("")}</ul>
        <h3>Host shortcuts</h3>
        <ul class="small keys">
          <li><b>Space / Enter</b> next (open question → reveal → next)</li>
          <li><b>Backspace</b> go back a step</li>
          <li><b>X</b> close answers early</li>
          <li><b>0</b> leaderboard · <b>M</b> mute · <b>B</b> open board</li>
        </ul>
        <p class="small">Open the <b>board</b> on the TV: it only ever shows what the room should see. Keep this host screen on your laptop.</p>
      </section>
    </div>
  </main>`;
  document.getElementById("aud-on")?.addEventListener("click", startAudience);
  document.getElementById("aud-off")?.addEventListener("click", stopAudience);
  document.getElementById("aud-new")?.addEventListener("click", () => confirm("New room code? Everyone will have to join again.") && newRoom());
  document.getElementById("aud-reset")?.addEventListener("click", () => confirm("Reset all scores?") && resetScores());
  document.getElementById("teams-save").addEventListener("click", () => setTeams(document.getElementById("teams").value.split("\n")));
  document.getElementById("resume")?.addEventListener("click", () => {
    game = saved.game;
    state = saved.state;
    stash = null;
    save();
    render();
  });
  for (const b of app.querySelectorAll("[data-game]")) b.addEventListener("click", () => startGame(b.dataset.game));
  for (const b of app.querySelectorAll("[data-kick]")) b.addEventListener("click", () => removePlayer(b.dataset.kick));
}

function playersHtml() {
  const rows = standings();
  if (!rows.length) return "";
  return `<details class="players" open><summary>${rows.length} joined</summary><ul>${rows
    .map((p) => `<li><span>${esc(p.name)}</span><em>${esc(p.team || "no team yet")}</em><button class="x" data-kick="${esc(p.id)}" title="Remove">×</button></li>`)
    .join("")}</ul></details>`;
}

// --- Lobby ------------------------------------------------------------------

function renderLobby() {
  const teams = teamStandings();
  app.innerHTML = `${topbar()}<main class="screen lobby">
    <div class="marquee">
      <div class="marquee-kicker">${esc(game.subtitle || "Trivia night")}</div>
      <h1 class="marquee-title">${esc(game.title)}</h1>
    </div>
    <div class="lobby-grid">
      ${joinBlock(true)}
      <div class="teams-grid">${teams
        .map(
          (t) => `<div class="team-card"><h3>${esc(t.team)}</h3><ul>${Object.values(aud.players)
            .filter((p) => p.team === t.team)
            .map((p) => `<li>${esc(p.name)}</li>`)
            .join("")}</ul></div>`
        )
        .join("")}</div>
    </div>
    <p class="host-hint">${game.rounds.length} rounds · ${totalQuestions()} questions · press <b>Space</b> to start</p>
  </main>${lbOverlay()}`;
  wireTopbar();
}

// --- Round card ---------------------------------------------------------------

function renderRound() {
  const r = round();
  app.innerHTML = `${topbar()}<main class="screen roundcard">
    <div class="round-no">Round ${state.r + 1} of ${game.rounds.length}${r.double ? " · <span class='double'>Double points</span>" : ""}</div>
    <h1 class="round-title">${esc(r.title)}</h1>
    <p class="round-blurb">${esc(r.blurb || "")}</p>
    <p class="round-meta">${r.questions.length} questions · ${roundTime(r)} seconds each</p>
    <p class="host-hint">Space to open the first question</p>
  </main>${lbOverlay()}`;
  wireTopbar();
}

// --- Question -----------------------------------------------------------------

function questionBody(q, { showAnswer, counts, items, groups }) {
  const letters = "ABCD";
  const type = qType(q);
  const extras = `
    ${q.quote ? `<blockquote class="quote">“${esc(q.quote)}”</blockquote>` : ""}
    ${q.top4 ? `<ol class="top4">${q.top4.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>` : ""}
    ${q.hint ? `<p class="hint">${esc(q.hint)}</p>` : ""}`;
  if (type === "order") {
    const list = showAnswer ? q.items : items;
    return `${extras}
      ${q.ends ? `<div class="order-ends"><span>${esc(q.ends[0])}</span><span>${esc(q.ends[1])}</span></div>` : ""}
      <div class="order-list">${list
        .map((x, i) => `<div class="order-item ${showAnswer ? "right" : ""}"><span class="letter">${showAnswer ? i + 1 : letters[i] || i + 1}</span><span>${esc(x)}</span>${showAnswer && q.meta?.[x] ? `<span class="meta">${esc(q.meta[x])}</span>` : ""}</div>`)
        .join("")}</div>`;
  }
  if (type === "text") {
    return `${extras}
      ${showAnswer ? `<div class="text-answer">${esc(q.answer)}</div>` : `<div class="text-blank">Type your answer on your phone</div>`}
      ${showAnswer && groups?.length ? `<div class="guesses">${groups.slice(0, 12).map((g) => `<span class="guess ${g.ok ? "ok" : ""}">${esc(g.text)}<b>×${g.count}</b></span>`).join("")}</div>` : ""}`;
  }
  return `${extras}
    <div class="choices ${q.choices.length === 2 ? "two" : ""}">${q.choices
      .map((c, i) => {
        const right = showAnswer && c === q.answer;
        const n = counts ? counts[i] : null;
        const total = counts ? counts.reduce((a, b) => a + b, 0) || 1 : 1;
        return `<div class="choice ${right ? "right" : ""} ${showAnswer && !right ? "dim" : ""}">
          <span class="letter">${letters[i]}</span><span class="choice-text">${esc(c)}</span>
          ${n != null ? `<span class="bar" style="width:${(n / total) * 100}%"></span><span class="count">${n}</span>` : ""}
        </div>`;
      })
      .join("")}</div>`;
}

function clockHtml() {
  return `<div class="clock"><div class="clock-fill"></div><span class="clock-num">${roundTime()}</span></div>`;
}

function revealPanel() {
  const q = question();
  const st = questionStats(qid());
  return `<div class="reveal">
    ${q.note ? `<p class="note">${esc(q.note)}</p>` : ""}
    <div class="reveal-stats">
      <span>${st.right} of ${st.answered} got it${st.partial ? `, ${st.partial} partly` : ""}</span>
      ${st.fastest ? `<span>⚡ Fastest: <b>${esc(st.fastest.name)}</b>${st.fastest.team ? ` (${esc(st.fastest.team)})` : ""} in ${st.fastest.secs}s, +${pts(st.fastest.pts)}</span>` : ""}
    </div>
    ${
      qType(q) === "text" && answerGroups(qid()).length
        ? `<div class="review-panel"><b>Only you can see this:</b> tap an answer to flip it between right and wrong. <div class="guesses">${answerGroups(qid())
            .map((g) => `<button class="guess ${g.ok ? "ok" : ""}" data-flip="${esc(g.key)}">${g.ok ? "✓" : "✗"} ${esc(g.text)}<b>×${g.count}</b></button>`)
            .join("")}</div></div>`
        : ""
    }
    <div class="team-results">${st.teams
      .map((t) => `<div class="team-result"><span class="team-name">${esc(t.team)}</span><span class="team-right">${t.right}/${t.size}</span><b>+${pts(t.pts)}</b></div>`)
      .join("")}</div>
  </div>`;
}

function renderQuestion() {
  const q = question();
  const r = round();
  const counts = state.revealed && qType(q) === "choice" ? choiceCounts(qid(), q.choices) : null;
  const items = qType(q) === "order" ? shownOrder(q, qid()) : null;
  app.innerHTML = `${topbar(
    state.open
      ? `<span class="live" id="live-count">0 of ${playerCount()} locked in</span><button class="btn small" id="btn-close">Close answers (X)</button>`
      : state.revealed
        ? ""
        : `<span class="live">Time's up</span>`
  )}<main class="screen qscreen ${state.revealed ? "revealed" : ""}">
    <div class="q-head"><span>Round ${state.r + 1}: ${esc(r.title)}</span><span>Question ${questionNo()} of ${totalQuestions()}${r.double ? " · <b class='double'>2×</b>" : ""}</span></div>
    ${state.open ? clockHtml() : ""}
    <h1 class="prompt">${esc(q.prompt)}</h1>
    ${questionBody(q, { showAnswer: state.revealed, counts, items, groups: answerGroups(qid()) })}
    ${state.revealed ? revealPanel() : `<div class="host-only">Only you can see this: <b>${esc(answerText(q))}</b>${q.note ? ` <span class="small">· ${esc(q.note)}</span>` : ""}</div>`}
    <p class="host-hint">${state.open ? "Space to reveal (closes answers)" : state.revealed ? (state.q + 1 < r.questions.length ? "Space for the next question" : "Space for round standings") : "Space to reveal"}</p>
  </main>${lbOverlay()}`;
  wireTopbar();
  document.getElementById("btn-close")?.addEventListener("click", closeAnswers);
  for (const b of app.querySelectorAll("[data-flip]")) b.addEventListener("click", () => flipAnswers(b.dataset.flip));
  tickClock();
}

// --- Standings -----------------------------------------------------------------

function standingsHtml(title, { showRound = true } = {}) {
  const rows = teamStandings();
  const max = Math.max(1, ...rows.map((t) => t.pts));
  const roundQids = round().questions.map((_, i) => qid(state.r, i));
  return `<h1 class="standings-title">${esc(title)}</h1>
    <div class="standings">${rows
      .map((t) => {
        const thisRound = showRound ? roundQids.reduce((n, id) => n + (aud.revealed.includes(id) ? teamPointsOn(id, t.team).pts : 0), 0) : null;
        return `<div class="standing rank-${t.rank}">
          <span class="rank">${t.rank}</span>
          <span class="s-name">${esc(t.team)}<em>${t.size} player${t.size === 1 ? "" : "s"}</em></span>
          <span class="s-bar"><span style="width:${(t.pts / max) * 100}%"></span></span>
          <span class="s-pts">${pts(t.pts)}${thisRound != null ? `<em>+${pts(thisRound)} this round</em>` : ""}</span>
        </div>`;
      })
      .join("")}</div>`;
}

function mvpHtml(n = 5) {
  const rows = standings().slice(0, n);
  if (!rows.length) return "";
  return `<div class="mvp"><h3>MVP race</h3><ol>${rows
    .map((p) => `<li><span class="rank">${p.rank}</span><span>${esc(p.name)}<em>${esc(p.team)}</em></span><b>${pts(p.pts)}</b></li>`)
    .join("")}</ol></div>`;
}

function renderStandings() {
  const last = state.r + 1 >= game.rounds.length;
  app.innerHTML = `${topbar()}<main class="screen standings-screen">
    <div class="round-no">After round ${state.r + 1}: ${esc(round().title)}</div>
    ${standingsHtml("Standings")}
    ${mvpHtml()}
    <p class="host-hint">${last ? "Space for the final results" : "Space for the next round"}</p>
  </main>${lbOverlay()}`;
  wireTopbar();
}

function renderFinal() {
  const rows = teamStandings();
  const win = rows.filter((t) => t.rank === 1);
  app.innerHTML = `${topbar()}<main class="screen final">
    <div class="marquee">
      <div class="marquee-kicker">And the award goes to…</div>
      <h1 class="marquee-title">${win.map((t) => esc(t.team)).join(" & ")}</h1>
    </div>
    ${standingsHtml("Final standings", { showRound: false })}
    ${mvpHtml(10)}
    <p class="host-hint">That's a wrap. ⚙︎ to go back to setup.</p>
  </main>${lbOverlay()}`;
  wireTopbar();
}

function lbOverlay() {
  if (!state?.lb) return "";
  return `<div class="overlay">${standingsHtml("Leaderboard", { showRound: state.screen === "question" || state.screen === "standings" })}${mvpHtml()}${joinBlock()}<p class="host-hint">0 or Space to close</p></div>`;
}

// ---------------------------------------------------------------------------
// Board (TV)
// ---------------------------------------------------------------------------

let boardOpen = false;
let boardView = null; // the latest snapshot from the host

function openBoard() {
  window.open(`${location.pathname}?view=board`, "mcawards-board");
}

function broadcast() {
  if (IS_BOARD || !channel) return;
  const q = state?.screen === "question" ? question() : null;
  send({
    t: "view",
    game: game ? { title: game.title, subtitle: game.subtitle, rounds: game.rounds.length, total: totalQuestions() } : null,
    state,
    round: game && state ? { title: round().title, blurb: round().blurb, n: round().questions.length, time: roundTime(), double: !!round().double } : null,
    questionNo: game && state?.screen === "question" ? questionNo() : null,
    q: q
      ? {
          prompt: q.prompt,
          type: qType(q),
          quote: q.quote || null,
          top4: q.top4 || null,
          hint: q.hint || null,
          ends: q.ends || null,
          choices: qType(q) === "choice" ? q.choices : null,
          shown: qType(q) === "order" ? shownOrder(q, qid()) : null,
          items: state.revealed && qType(q) === "order" ? q.items : null,
          meta: state.revealed ? q.meta || null : null,
          answer: state.revealed ? q.answer : null,
          note: state.revealed ? q.note : null,
        }
      : null,
    counts: q && state.revealed && qType(q) === "choice" ? choiceCounts(qid(), q.choices) : null,
    groups: q && state.revealed && qType(q) === "text" ? answerGroups(qid()) : null,
    stats: q && state.revealed ? questionStats(qid()) : null,
    teams: game && state ? teamStandings() : [],
    roundPts: game && state ? Object.fromEntries(aud.teams.map((t) => [t, round().questions.reduce((n, _, i) => n + (aud.revealed.includes(qid(state.r, i)) ? teamPointsOn(qid(state.r, i), t).pts : 0), 0)])) : {},
    mvp: standings().slice(0, 10),
    players: Object.values(aud.players).map((p) => ({ name: p.name, team: p.team })),
    aud: { on: aud.on, code: aud.code, status: aud.status, join: aud.on ? joinUrl() : "", short: aud.on ? shortUrl() : "", n: playerCount(), answered: q ? questionStats(qid()).answered : 0 },
    opened: q ? openedAt(qid()) : null,
    muted: isMuted(),
    sound: pendingSound,
  });
  pendingSound = null;
}

let pendingSound = null;
// The board plays the sounds when it's open, so they come out of the TV.
const hostPlay = playSound;
function playSoundEverywhere(name) {
  pendingSound = name;
  if (!boardOpen) hostPlay(name);
}

function renderBoard() {
  const v = boardView;
  document.body.classList.add("is-board");
  if (!v || !v.game || !v.state) {
    app.innerHTML = `<main class="screen board-wait"><div class="marquee"><div class="marquee-kicker">Letterboxd Movie Club</div><h1 class="marquee-title">Awards <em>Trivia</em></h1></div><p class="host-hint">Waiting for the host…</p></main>`;
    return;
  }
  const s = v.state;
  const join = v.aud.on && v.aud.code && v.aud.status !== "connecting" ? `<div class="join big">${qrSvg(v.aud.join)}<div class="join-text"><div class="join-url">${esc(v.aud.short)}</div><div class="join-code">${esc(v.aud.code)}</div></div></div>` : "";
  const corner = v.aud.on && v.aud.code ? `<div class="corner">Join: <b>${esc(v.aud.short)}</b> · code <b>${esc(v.aud.code)}</b></div>` : "";
  const standingsB = (title, showRound) => {
    const max = Math.max(1, ...v.teams.map((t) => t.pts));
    return `<h1 class="standings-title">${esc(title)}</h1><div class="standings">${v.teams
      .map(
        (t) => `<div class="standing rank-${t.rank}"><span class="rank">${t.rank}</span><span class="s-name">${esc(t.team)}<em>${t.size} player${t.size === 1 ? "" : "s"}</em></span><span class="s-bar"><span style="width:${(t.pts / max) * 100}%"></span></span><span class="s-pts">${pts(t.pts)}${showRound ? `<em>+${pts(v.roundPts[t.team] || 0)} this round</em>` : ""}</span></div>`
      )
      .join("")}</div>`;
  };
  const mvpB = (n) =>
    v.mvp.length
      ? `<div class="mvp"><h3>MVP race</h3><ol>${v.mvp
          .slice(0, n)
          .map((p) => `<li><span class="rank">${p.rank}</span><span>${esc(p.name)}<em>${esc(p.team)}</em></span><b>${pts(p.pts)}</b></li>`)
          .join("")}</ol></div>`
      : "";
  let html = "";
  if (s.screen === "lobby") {
    html = `<main class="screen lobby"><div class="marquee"><div class="marquee-kicker">${esc(v.game.subtitle || "")}</div><h1 class="marquee-title">${esc(v.game.title)}</h1></div>
      <div class="lobby-grid">${join}<div class="teams-grid">${v.teams
        .map((t) => `<div class="team-card"><h3>${esc(t.team)}</h3><ul>${v.players.filter((p) => p.team === t.team).map((p) => `<li>${esc(p.name)}</li>`).join("")}</ul></div>`)
        .join("")}</div></div></main>`;
  } else if (s.screen === "round") {
    html = `<main class="screen roundcard"><div class="round-no">Round ${s.r + 1} of ${v.game.rounds}${v.round.double ? " · <span class='double'>Double points</span>" : ""}</div><h1 class="round-title">${esc(v.round.title)}</h1><p class="round-blurb">${esc(v.round.blurb || "")}</p><p class="round-meta">${v.round.n} questions · ${v.round.time} seconds each</p></main>${corner}`;
  } else if (s.screen === "question") {
    const q = v.q;
    html = `<main class="screen qscreen ${s.revealed ? "revealed" : ""}">
      <div class="q-head"><span>Round ${s.r + 1}: ${esc(v.round.title)}</span><span>Question ${v.questionNo} of ${v.game.total}${v.round.double ? " · <b class='double'>2×</b>" : ""}</span></div>
      ${s.open ? `<div class="clock"><div class="clock-fill"></div><span class="clock-num">${v.round.time}</span></div>` : s.revealed ? "" : `<div class="timesup">Time's up</div>`}
      <h1 class="prompt">${esc(q.prompt)}</h1>
      ${questionBody(q, { showAnswer: s.revealed, counts: v.counts, items: q.shown, groups: v.groups })}
      ${
        s.revealed
          ? `<div class="reveal">${q.note ? `<p class="note">${esc(q.note)}</p>` : ""}<div class="reveal-stats"><span>${v.stats.right} of ${v.stats.answered} got it${v.stats.partial ? `, ${v.stats.partial} partly` : ""}</span>${
              v.stats.fastest ? `<span>⚡ Fastest: <b>${esc(v.stats.fastest.name)}</b>${v.stats.fastest.team ? ` (${esc(v.stats.fastest.team)})` : ""} in ${v.stats.fastest.secs}s, +${pts(v.stats.fastest.pts)}</span>` : ""
            }</div><div class="team-results">${v.stats.teams.map((t) => `<div class="team-result"><span class="team-name">${esc(t.team)}</span><span class="team-right">${t.right}/${t.size}</span><b>+${pts(t.pts)}</b></div>`).join("")}</div></div>`
          : `<div class="live-big">${v.aud.answered} of ${v.aud.n} locked in</div>`
      }
    </main>${corner}`;
  } else if (s.screen === "standings") {
    html = `<main class="screen standings-screen"><div class="round-no">After round ${s.r + 1}: ${esc(v.round.title)}</div>${standingsB("Standings", true)}${mvpB(5)}</main>${corner}`;
  } else if (s.screen === "final") {
    const win = v.teams.filter((t) => t.rank === 1);
    html = `<main class="screen final"><div class="marquee"><div class="marquee-kicker">And the award goes to…</div><h1 class="marquee-title">${win.map((t) => esc(t.team)).join(" & ")}</h1></div>${standingsB("Final standings", false)}${mvpB(10)}</main>`;
  }
  if (s.lb) html += `<div class="overlay">${standingsB("Leaderboard", s.screen === "question" || s.screen === "standings")}${mvpB(5)}${join}</div>`;
  if (!boardClicked) html += `<div class="click-once">Click here once so the board can play sound · F for full screen</div>`;
  app.innerHTML = html;
  clearInterval(clockTimer);
  if (s.screen === "question" && s.open && v.opened) {
    const tick = () => {
      const left = Math.max(0, v.round.time * 1000 - (Date.now() - v.opened));
      for (const el of document.querySelectorAll(".clock-fill")) el.style.width = `${(left / (v.round.time * 1000)) * 100}%`;
      for (const el of document.querySelectorAll(".clock-num")) el.textContent = Math.ceil(left / 1000);
    };
    tick();
    clockTimer = setInterval(tick, 200);
  }
}

let boardClicked = false;

if (IS_BOARD) {
  channel?.addEventListener("message", (e) => {
    const m = e.data;
    if (m?.t === "view") {
      boardView = m;
      if (m.sound && boardClicked && !m.muted) playSound(m.sound);
      renderBoard();
      send({ t: "board-here" });
    } else if (m?.t === "ping") send({ t: "board-here" });
  });
  send({ t: "board-hello" });
  document.addEventListener("click", () => {
    boardClicked = true;
    renderBoard();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
    }
  });
  renderBoard();
} else {
  let boardSeen = 0;
  channel?.addEventListener("message", (e) => {
    const m = e.data;
    if (m?.t === "board-hello") {
      boardOpen = true;
      boardSeen = Date.now();
      render();
    } else if (m?.t === "board-here") {
      boardOpen = true;
      boardSeen = Date.now();
    }
  });
  setInterval(() => {
    send({ t: "ping" });
    if (boardOpen && Date.now() - boardSeen > 6000) {
      boardOpen = false;
      render();
    }
  }, 3000);
}

// ---------------------------------------------------------------------------
// Keys and startup
// ---------------------------------------------------------------------------

if (!IS_BOARD) {
  document.addEventListener("keydown", (e) => {
    if (!state || state.screen === "start") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      advance();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      back();
    } else if (e.key === "x" || e.key === "X") closeAnswers();
    else if (e.key === "0") {
      state.lb = !state.lb;
      render();
    } else if (e.key === "m" || e.key === "M") {
      toggleMute();
      render();
    } else if (e.key === "b" || e.key === "B") openBoard();
  });

  setOnChange(() => {
    // Phones joining or answering: redraw cheap bits without rebuilding the whole screen.
    if (!state || state.screen === "start") return render();
    if (state.screen === "question" && state.open) {
      tickClock();
      broadcast();
      return;
    }
    render();
  });

  loadAudience();
  restore();
  if (aud.on) startAudience();
  render();
}

// For checking things from the browser console.
window.gameState = () => ({ game, state, aud });
window.gameAdvance = advance;
