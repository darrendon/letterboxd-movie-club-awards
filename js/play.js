// The phone page.
//
// Phones see the question the TV shows (never the answer), pick a team once, and lock in one
// answer per question. The host's laptop checks and scores it; the result shows up here once
// the answer is revealed on the TV. Faster right answers are worth more.

import { Relay, brokerFor, cleanCode, TOPIC_ROOT } from "./relay.js?v=__V__";
import { speedPoints, MAX_POINTS, MIN_POINTS, DEFAULT_TIME, ORDER_SEP } from "./audience.js?v=__V__";

const STORE_KEY = "mcawards.play.v1";

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pts = (n) => Number(n || 0).toLocaleString("en-US");

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch {
    return null;
  }
}

function store() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(me));
  } catch {
    /* private window: fine */
  }
}

const me = Object.assign({ id: "p" + Math.random().toString(36).slice(2, 12), name: "", code: "", team: "", joined: false, last: {} }, load() || {});
const params = new URLSearchParams(location.search);
const linkCode = cleanCode(params.get("code"));
if (linkCode && linkCode !== me.code) {
  me.code = linkCode;
  me.joined = false;
  me.team = "";
}
store();

let relay = null;
let topic = "";
let status = "idle"; // idle | connecting | live | down
let view = null; // the latest message from the host
let pending = null; // { qid, text } sent but not confirmed yet
let picked = null; // the option tapped but not locked in yet
let ordered = null; // { qid, list: [items placed so far] } for ordering questions
let joinError = "";
let lastJoinSent = 0;
let resendTimer = null;
let formKey = "";
const firstSeen = {}; // qid -> when this phone first saw the question open
const timeFor = {}; // qid -> seconds

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function connect() {
  const broker = brokerFor(me.code);
  if (!broker) return;
  relay?.close();
  view = null;
  topic = TOPIC_ROOT + me.code;
  relay = new Relay(broker.url, {
    onMessage: (t, m) => {
      if (t !== topic + "/s") return;
      view = m;
      const mine = m.players?.[me.id];
      if (!m.closed && (!mine || mine.t !== me.team)) sendJoin();
      if (m.q?.open && !firstSeen[m.q.qid]) {
        // The host tells us how long is left, so a late joiner's clock is right too.
        firstSeen[m.q.qid] = Date.now() - (m.q.time * 1000 - (m.q.left ?? m.q.time * 1000));
        timeFor[m.q.qid] = m.q.time;
      }
      if (pending && (pending.qid !== m.q?.qid || mine?.g)) pending = null;
      if (picked && picked.qid !== m.q?.qid) picked = null;
      if (ordered && ordered.qid !== m.q?.qid) ordered = null;
      // If the host dropped the team we picked, pick again.
      if (me.team && m.teamList && !m.teamList.includes(me.team)) {
        me.team = "";
        store();
      }
      render();
    },
    onStatus: (s) => {
      status = s;
      if (s === "live") sendJoin(true);
      render();
    },
  });
  relay.subscribe(topic + "/s");
  relay.start();
  status = "connecting";
}

function sendJoin(force = false) {
  if (!relay) return;
  if (!force && Date.now() - lastJoinSent < 3000) return;
  lastJoinSent = Date.now();
  relay.publish(topic + "/h", { t: "join", id: me.id, name: me.name, team: me.team });
}

setInterval(() => sendJoin(true), 25000);

function sendAnswer(text) {
  const q = view?.q;
  if (!q?.open) return;
  pending = { qid: q.qid, text };
  const keep = Object.entries(me.last || {}).slice(-5);
  me.last = Object.fromEntries([...keep, [q.qid, text]]);
  store();
  const msg = { t: "answer", id: me.id, qid: q.qid, text };
  relay.publish(topic + "/h", msg);
  clearInterval(resendTimer);
  let tries = 0;
  resendTimer = setInterval(() => {
    if (!pending || pending.qid !== msg.qid || ++tries > 6) return clearInterval(resendTimer);
    relay.publish(topic + "/h", msg);
  }, 2500);
  render();
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const app = document.getElementById("app");

function render() {
  if (!me.joined) return renderJoin();
  if (!me.team) return renderTeamPick();
  if (!app.querySelector(".pp")) {
    app.innerHTML = `<main class="pp">
      <header class="pp-top" id="pp-top"></header>
      <section id="pp-view"></section>
      <section id="pp-form"></section>
      <section id="pp-lb"></section>
      <footer class="pp-foot"><button class="link" id="pp-team">Change team</button> · <button class="link" id="pp-leave">Change name or room</button></footer>
    </main>`;
    document.getElementById("pp-leave").onclick = () => {
      me.joined = false;
      store();
      relay?.close();
      relay = null;
      app.innerHTML = "";
      render();
    };
    document.getElementById("pp-team").onclick = () => {
      me.team = "";
      store();
      app.innerHTML = "";
      render();
    };
  }
  const mine = view?.players?.[me.id];
  const dot = status === "live" ? "live" : status === "down" ? "down" : "connecting";
  const myTeam = view?.teams?.find((t) => t[0] === me.team);
  document.getElementById("pp-top").innerHTML = `
    <div class="pp-me"><span class="aud-dot ${dot}"></span><strong>${esc(me.name)}</strong><span class="pp-subj">${esc(me.team)}</span></div>
    <div class="pp-score">${
      mine
        ? `${myTeam ? `Team: ${pts(myTeam[1])} · #${myTeam[2]}` : ""}<br><span class="small">You: ${pts(mine.p)}${view.count > 1 ? ` · #${mine.r} of ${view.count}` : ""}</span>`
        : status === "live"
          ? "Joining…"
          : "Connecting…"
    }</div>`;
  const viewHtml = questionHtml(mine);
  const viewEl = document.getElementById("pp-view");
  if (viewEl.innerHTML !== viewHtml) viewEl.innerHTML = viewHtml;
  renderForm(mine);
  document.getElementById("pp-lb").innerHTML = lbHtml(mine);
}

function questionHtml(mine) {
  if (!view) return `<div class="pp-wait"><div class="pp-spinner"></div><p>${status === "down" ? "Reconnecting…" : "Connecting to the game…"}</p></div>`;
  if (view.closed) return `<div class="pp-wait"><p>The host has turned off play-along for now.</p></div>`;
  const q = view.q;
  if (!q) {
    const sc = view.screen || {};
    let line = "Questions show up here as soon as they're on the TV. Keep this page open.";
    if (sc.screen === "round") line = `Round ${sc.roundNo}: ${sc.roundTitle}. Get ready…`;
    if (sc.screen === "standings") line = "Standings are on the TV.";
    if (sc.screen === "final") line = "That's a wrap! Final results are on the TV.";
    return `<div class="pp-wait"><p class="pp-big">${sc.screen === "final" ? "🏆" : "You're in!"}</p><p>${esc(line)}</p>${lastResult(mine)}</div>`;
  }
  return `<div class="pp-q ${q.double ? "million" : ""}">
    <div class="pp-grade">${esc(q.round)}${q.double ? " · Double points" : ""}</div>
    <div class="pp-text">${esc(q.text)}</div>
    ${q.quote ? `<blockquote class="pp-quote">“${esc(q.quote)}”</blockquote>` : ""}
    ${q.top4 ? `<ol class="pp-top4">${q.top4.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>` : ""}
    ${q.hint ? `<p class="small">${esc(q.hint)}</p>` : ""}
    ${q.revealed ? revealHtml(mine) : ""}
  </div>`;
}

function revealHtml(mine) {
  const g = mine?.g;
  const st = view.stats;
  let line = `<p class="pp-res none">You didn't answer this one.</p>`;
  if (Array.isArray(g)) {
    line = g[0] ? `<p class="pp-res ok">✓ You got it! <strong>+${pts(g[1])}</strong></p>` : `<p class="pp-res no">✗ You said “${esc(g[2])}”</p>`;
  }
  const team = st?.teams?.find((t) => t.team === me.team);
  const ans =
    view.q.type === "order"
      ? `<ol class="pp-order-answer">${String(view.answer).split(ORDER_SEP).map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`
      : esc(view.answer);
  if (Array.isArray(g) && !g[0] && g[1] > 0) line = `<p class="pp-res ok">Partly right: <strong>+${pts(g[1])}</strong></p>`;
  return `<div class="pp-reveal">
    <div class="pp-answer"><span>${view.q.type === "order" ? (view.q.ends ? esc(view.q.ends[0]) + " → " + esc(view.q.ends[1]) : "Right order") : "Answer"}</span>${ans}</div>
    ${line}
    ${team ? `<p class="small">${esc(me.team)}: ${team.right}/${team.size} right, <b>+${pts(team.pts)}</b> team points</p>` : ""}
    ${st ? `<p class="small">${st.right} of ${st.answered} got it${st.fastest ? ` · fastest: ${esc(st.fastest.name)} in ${st.fastest.secs}s` : ""}</p>` : ""}
  </div>`;
}

function lastResult(mine) {
  if (!mine?.l) return "";
  return mine.l[0] ? `<p class="pp-res ok">Last question: ✓ +${pts(mine.l[1])}</p>` : `<p class="pp-res no">Last question: ✗</p>`;
}

function worthNow() {
  const q = view?.q;
  if (!q) return 0;
  const w = speedPoints(Date.now() - (firstSeen[q.qid] || Date.now()), timeFor[q.qid] || DEFAULT_TIME);
  return q.double ? w * 2 : w;
}
function secondsLeft() {
  const q = view?.q;
  if (!q) return 0;
  const t = (timeFor[q.qid] || DEFAULT_TIME) * 1000;
  return Math.max(0, Math.ceil((t - (Date.now() - (firstSeen[q.qid] || Date.now()))) / 1000));
}

// The answer form is only rebuilt when it has to be.
function renderForm(mine) {
  const el = document.getElementById("pp-form");
  const q = view?.q;
  let key = "none";
  if (view && !view.closed && q?.open) {
    if (mine?.g) key = "locked:" + q.qid;
    else if (pending?.qid === q.qid) key = "sending:" + q.qid;
    else if (q.type === "order") key = "order:" + q.qid + ":" + (ordered?.qid === q.qid ? ordered.list.join("|") : "");
    else if (q.type === "text") key = "text:" + q.qid;
    else key = "choices:" + q.qid + ":" + (picked?.qid === q.qid ? picked.text : "");
  } else if (q && !q.open && !q.revealed) key = "closed:" + q.qid;
  if (key === formKey) return updateWorth();
  formKey = key;
  if (key.startsWith("choices")) {
    const sel = picked?.qid === q.qid ? picked.text : null;
    el.innerHTML = `<div class="pp-form">
      <label>Pick one <span class="pp-worth">worth <b id="pp-worth"></b> · <span id="pp-left"></span>s</span></label>
      <div class="pp-choices">${q.choices
        .map((c, i) => `<button class="pp-choice ${sel === c ? "on" : ""}" data-i="${i}"><span>${String.fromCharCode(65 + i)}</span>${esc(c)}</button>`)
        .join("")}</div>
      <button class="btn primary big" id="pp-lock" ${sel ? "" : "disabled"}>${sel ? `Lock in “${esc(sel)}”` : "Tap an answer"}</button>
    </div>`;
    for (const b of el.querySelectorAll(".pp-choice")) {
      b.onclick = () => {
        picked = { qid: q.qid, text: q.choices[Number(b.dataset.i)] };
        render();
      };
    }
    document.getElementById("pp-lock").onclick = () => sel && sendAnswer(sel);
  } else if (key.startsWith("order")) {
    const list = ordered?.qid === q.qid ? ordered.list : [];
    const items = q.items || [];
    const done = list.length === items.length;
    el.innerHTML = `<div class="pp-form">
      <label>Tap in order${q.ends ? `: <b>${esc(q.ends[0])}</b> first` : ""} <span class="pp-worth">worth <b id="pp-worth"></b> · <span id="pp-left"></span>s</span></label>
      <div class="pp-choices">${items
        .map((c) => {
          const n = list.indexOf(c);
          return `<button class="pp-choice ${n >= 0 ? "on" : ""}" data-item="${esc(c)}"><span>${n >= 0 ? n + 1 : ""}</span>${esc(c)}</button>`;
        })
        .join("")}</div>
      <div class="row"><button class="btn primary big" id="pp-lock" ${done ? "" : "disabled"}>${done ? "Lock it in" : `${list.length} of ${items.length} placed`}</button></div>
      ${list.length ? `<p class="small"><button class="link" id="pp-clear">Start over</button></p>` : ""}
    </div>`;
    for (const b of el.querySelectorAll(".pp-choice")) {
      b.onclick = () => {
        const cur = ordered?.qid === q.qid ? [...ordered.list] : [];
        const i = cur.indexOf(b.dataset.item);
        if (i >= 0) cur.splice(i, 1);
        else cur.push(b.dataset.item);
        ordered = { qid: q.qid, list: cur };
        render();
      };
    }
    document.getElementById("pp-clear")?.addEventListener("click", () => {
      ordered = { qid: q.qid, list: [] };
      render();
    });
    document.getElementById("pp-lock").onclick = () => done && sendAnswer(list.join(ORDER_SEP));
  } else if (key.startsWith("text")) {
    el.innerHTML = `<form class="pp-form" id="pp-ans" autocomplete="off">
      <label for="pp-text">Your answer <span class="pp-worth">worth <b id="pp-worth"></b> · <span id="pp-left"></span>s</span></label>
      <input id="pp-text" maxlength="80" autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="Type your answer">
      <button class="btn primary big" type="submit">Lock it in</button>
      <p class="small">Spelling doesn't have to be perfect. Last names are fine for people.</p>
    </form>`;
    document.getElementById("pp-ans").onsubmit = (e) => {
      e.preventDefault();
      const text = document.getElementById("pp-text").value.trim();
      if (!text) return;
      document.getElementById("pp-text").blur();
      sendAnswer(text);
    };
  } else if (key.startsWith("locked") || key.startsWith("sending")) {
    const text = pending?.text || me.last?.[q.qid] || "";
    const shown = q.type === "order" ? `<ol class="pp-order-answer">${text.split(ORDER_SEP).map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : `<strong>${esc(text)}</strong>`;
    el.innerHTML = `<div class="pp-locked">${key.startsWith("sending") ? "Sending…" : "🔒 Locked in"}${text ? shown : ""}<span class="small">You'll find out when the answer is revealed on the TV.</span></div>`;
  } else if (key.startsWith("closed")) {
    el.innerHTML = `<div class="pp-locked">⏱ Time's up<span class="small">Eyes on the TV for the answer.</span></div>`;
  } else {
    el.innerHTML = "";
  }
  updateWorth();
}

function updateWorth() {
  const w = document.getElementById("pp-worth");
  if (w) w.textContent = pts(worthNow());
  const l = document.getElementById("pp-left");
  if (l) l.textContent = secondsLeft();
  if (view?.q?.open && secondsLeft() === 0 && /^(choices|order|text)/.test(formKey)) {
    formKey = "";
    document.getElementById("pp-form").innerHTML = `<div class="pp-locked">⏱ Time's up<span class="small">Eyes on the TV for the answer.</span></div>`;
  }
}
setInterval(updateWorth, 250);

function lbHtml(mine) {
  if (!view?.teams?.length) return "";
  return `<div class="pp-lb"><h3>Teams</h3><ol class="lb">${view.teams
    .map(([n, p, r]) => `<li class="${n === me.team ? "me" : ""}"><span class="lb-rank">${r}</span><span class="lb-name">${esc(n)}</span><b>${pts(p)}</b></li>`)
    .join("")}</ol>${
    view.top?.length
      ? `<h3>MVP race</h3><ol class="lb">${view.top
          .map(([n, p, r, t]) => `<li class="${n === me.name && t === me.team ? "me" : ""}"><span class="lb-rank">${r}</span><span class="lb-name">${esc(n)} <em>${esc(t)}</em></span><b>${pts(p)}</b></li>`)
          .join("")}${mine && !view.top.some(([n, , , t]) => n === me.name && t === me.team) ? `<li class="me gap"><span class="lb-rank">${mine.r}</span><span class="lb-name">${esc(me.name)}</span><b>${pts(mine.p)}</b></li>` : ""}</ol>`
      : ""
  }</div>`;
}

function renderTeamPick() {
  formKey = "";
  const teams = view?.teamList || [];
  app.innerHTML = `<main class="pp pp-join">
    <div class="pp-logo"><span class="logo-kicker">Letterboxd Movie Club</span><span class="logo-title">Awards Trivia</span></div>
    <section class="card">
      <h2>Hi ${esc(me.name)}! Pick your team</h2>
      ${
        teams.length
          ? `<div class="pp-choices">${teams.map((t, i) => `<button class="pp-choice" data-team="${esc(t)}"><span>${i + 1}</span>${esc(t)}</button>`).join("")}</div>`
          : `<div class="pp-wait"><div class="pp-spinner"></div><p>${status === "live" ? "Waiting for the host…" : "Connecting to the game…"}</p></div>`
      }
      <p class="small"><button class="link" id="pp-leave">Change name or room</button></p>
    </section>
  </main>`;
  for (const b of app.querySelectorAll("[data-team]")) {
    b.onclick = () => {
      me.team = b.dataset.team;
      store();
      sendJoin(true);
      app.innerHTML = "";
      render();
    };
  }
  document.getElementById("pp-leave").onclick = () => {
    me.joined = false;
    store();
    relay?.close();
    relay = null;
    render();
  };
}

function renderJoin() {
  formKey = "";
  app.innerHTML = `<main class="pp pp-join">
    <div class="pp-logo"><span class="logo-kicker">Letterboxd Movie Club</span><span class="logo-title">Awards Trivia</span></div>
    <section class="card">
      <h2>Join the game</h2>
      <p class="small">Answer every question on your phone. The faster you lock in a right answer, the more points you get: ${pts(MAX_POINTS)} if you're quick, down to ${pts(MIN_POINTS)} as the clock runs out. Your team scores the average of its players.</p>
      <form id="pp-join" class="pp-join-form" autocomplete="off">
        <label>Room code<input id="pp-code" maxlength="5" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="5 letters" value="${esc(me.code)}"></label>
        <label>Your name<input id="pp-name" maxlength="20" autocorrect="off" placeholder="Name for the leaderboard" value="${esc(me.name)}"></label>
        ${joinError ? `<p class="error">${esc(joinError)}</p>` : ""}
        <button class="btn primary big" type="submit">Next: pick a team</button>
      </form>
    </section>
  </main>`;
  document.getElementById("pp-join").onsubmit = (e) => {
    e.preventDefault();
    const code = cleanCode(document.getElementById("pp-code").value);
    const name = document.getElementById("pp-name").value.replace(/\s+/g, " ").trim().slice(0, 20);
    if (code.length !== 5 || !brokerFor(code)) {
      joinError = "That room code doesn't look right. It's the 5 letters on the TV.";
      return renderJoin();
    }
    if (!name) {
      joinError = "Add a name for the leaderboard.";
      return renderJoin();
    }
    joinError = "";
    if (code !== me.code) me.team = "";
    Object.assign(me, { code, name, joined: true });
    store();
    app.innerHTML = "";
    connect();
    render();
  };
  (me.code ? document.getElementById("pp-name") : document.getElementById("pp-code")).focus();
}

if (me.joined && me.code && me.name) connect();
render();

window.playState = () => ({ me, view, status, pending });
