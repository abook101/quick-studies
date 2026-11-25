'use strict';
/* Quick Studies: offline study app. All progress lives in this phone's localStorage. */

const DAY = 86400000;
const SEC_PER_CARD = 40;          // rough estimate used to size a session
const LOG_MAX = 3000;             // keep the answer log bounded
const KEY = { prog: 'qs.progress.v1', log: 'qs.log.v1', settings: 'qs.settings.v1' };

/* ---------- storage ---------- */
function load(k, fallback) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function save(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Could not save on this phone (storage full?)'); }
}
const state = {
  courses: [],                    // [{slug, name, cards:[...]}]
  byId: new Map(),
  prog: load(KEY.prog, {}),       // id -> {reps, lapses, ease, ivl, due, last}
  log: load(KEY.log, []),
  settings: Object.assign({ minutes: 15, newPerSession: 8, otherShare: 0.15, speechLang: 'en-US' }, load(KEY.settings, {})),
  session: null,
};
const saveProg = () => save(KEY.prog, state.prog);
const saveLog = () => { if (state.log.length > LOG_MAX) state.log = state.log.slice(-LOG_MAX); save(KEY.log, state.log); };
const saveSettings = () => save(KEY.settings, state.settings);

/* ---------- loading cards ---------- */
async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}
async function loadCards() {
  let files = [];
  try { files = (await fetchJSON('cards/index.json')).files || []; } catch (e) { /* none */ }
  const courses = [];
  for (const f of files) {
    try {
      const data = await fetchJSON('cards/' + f);
      const slug = f.replace(/\.json$/, '');
      const cards = (data.cards || []).filter(c => c && c.id && c.question);
      cards.forEach(c => { c.course = slug; c.topic = c.topic || 'General'; c.keywords = c.keywords || []; c.synonyms = c.synonyms || {}; });
      if (cards.length) courses.push({ slug, name: data.course || slug, cards });
    } catch (e) { console.warn('skip', f, e); }
  }
  const real = courses.filter(c => c.slug !== 'sample');
  state.courses = real.length ? real : courses;
  state.byId = new Map();
  state.courses.forEach(c => c.cards.forEach(card => state.byId.set(card.id, card)));
}

/* ---------- spaced repetition (SM-2 style) ---------- */
function progOf(id) { return state.prog[id]; }
function isDue(id, now = Date.now()) { const p = progOf(id); return p && p.due <= endOfToday(now); }
function endOfToday(now = Date.now()) { const d = new Date(now); d.setHours(23, 59, 59, 999); return d.getTime(); }
function schedule(id, rating) {          // rating: 1 Again, 2 Hard, 3 Good, 4 Easy
  const now = Date.now();
  const p = state.prog[id] || { reps: 0, lapses: 0, ease: 2.5, ivl: 0, due: now, last: 0 };
  const fuzz = d => d < 3 ? d : Math.round(d * (0.95 + Math.random() * 0.1));
  if (rating === 1) {
    if (p.reps > 0) p.lapses++;
    p.ease = Math.max(1.3, p.ease - 0.2);
    p.ivl = 0; p.due = now + 10 * 60000;    // back today
  } else if (p.ivl === 0) {                  // new or just relearned
    p.ivl = rating === 2 ? 1 : rating === 3 ? 1 : 3;
    if (rating === 2) p.ease = Math.max(1.3, p.ease - 0.15);
    if (rating === 4) p.ease += 0.15;
  } else {
    if (rating === 2) { p.ivl = Math.max(1, Math.round(p.ivl * 1.2)); p.ease = Math.max(1.3, p.ease - 0.15); }
    if (rating === 3) p.ivl = fuzz(Math.max(p.ivl + 1, Math.round(p.ivl * p.ease)));
    if (rating === 4) { p.ivl = fuzz(Math.max(p.ivl + 2, Math.round(p.ivl * p.ease * 1.3))); p.ease += 0.15; }
  }
  if (rating > 1) { const d = new Date(now + p.ivl * DAY); d.setHours(4, 0, 0, 0); p.due = d.getTime(); }
  p.reps++; p.last = now;
  state.prog[id] = p; saveProg();
}
const strength = id => { const p = progOf(id); return p ? Math.min(1, p.ivl / 21) : 0; };

/* ---------- weakness model ---------- */
function recentFailRate(filter, n = 40) {
  let tot = 0, bad = 0;
  for (let i = state.log.length - 1; i >= 0 && tot < n; i--) {
    const e = state.log[i];
    if (!filter(e)) continue;
    tot++; if (e.rating <= 2) bad++;
  }
  return tot ? { rate: bad / tot, n: tot } : { rate: null, n: 0 };
}
function topicStats(course) {
  const topics = new Map();
  for (const c of course.cards) {
    if (!topics.has(c.topic)) topics.set(c.topic, { topic: c.topic, cards: [], seen: 0, due: 0, mastery: 0 });
    const t = topics.get(c.topic);
    t.cards.push(c); if (progOf(c.id)) t.seen++; if (isDue(c.id)) t.due++;
    t.mastery += strength(c.id);
  }
  for (const t of topics.values()) {
    t.mastery /= t.cards.length;
    const f = recentFailRate(e => e.course === course.slug && e.topic === t.topic, 30);
    t.failRate = f.rate;
    // weakness: unseen topics sit in the middle; seen topics rank by how often they are failed and how unstable they are
    t.weak = t.seen === 0 ? 0.55 : 0.6 * (f.rate ?? 0.3) + 0.4 * (1 - t.mastery);
  }
  return [...topics.values()];
}
function courseStats(course) {
  const topics = topicStats(course);
  const due = course.cards.filter(c => isDue(c.id)).length;
  const seen = course.cards.filter(c => progOf(c.id)).length;
  const mastered = course.cards.filter(c => strength(c.id) >= 1).length;
  const avgWeak = topics.reduce((s, t) => s + t.weak * t.cards.length, 0) / course.cards.length;
  const f = recentFailRate(e => e.course === course.slug, 60);
  return { course, topics, due, seen, mastered, total: course.cards.length, failRate: f.rate,
    weak: avgWeak + 0.25 * Math.min(1, due / 25) };
}

/* ---------- building a session ---------- */
function weightedPick(items, weightFn) {
  const w = items.map(i => Math.max(0.01, weightFn(i)));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { r -= w[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function buildSession(minutes, forcedSlug) {
  const target = Math.max(5, Math.round(minutes * 60 / SEC_PER_CARD));
  const stats = state.courses.map(courseStats);
  if (!stats.length) return null;
  let chosen;
  if (forcedSlug) chosen = stats.filter(s => s.course.slug === forcedSlug);
  else {
    const first = weightedPick(stats, s => s.weak ** 2);
    chosen = [first];
    const rest = stats.filter(s => s !== first);
    if (rest.length && Math.random() < 0.65) chosen.push(weightedPick(rest, s => s.weak ** 2));
  }
  const chosenSlugs = new Set(chosen.map(s => s.course.slug));
  const nOther = forcedSlug ? 0 : Math.round(target * state.settings.otherShare);
  const nMain = target - nOther;
  const picked = new Set(), main = [];
  const take = c => { if (!picked.has(c.id)) { picked.add(c.id); main.push(c); return true; } return false; };

  for (const s of chosen) {
    const weakOf = new Map(s.topics.map(t => [t.topic, t.weak]));
    s._due = s.course.cards.filter(c => isDue(c.id))
      .sort((a, b) => (weakOf.get(b.topic) - weakOf.get(a.topic)) || (progOf(a.id).due - progOf(b.id).due));
    // new cards: weakest/unstarted topics first, keeping lecture order inside a topic
    const order = [...s.topics].sort((a, b) => b.weak - a.weak).map(t => t.topic);
    s._new = s.course.cards.filter(c => !progOf(c.id)).sort((a, b) => order.indexOf(a.topic) - order.indexOf(b.topic));
  }
  // due cards from chosen courses, alternating between courses
  const perCourse = Math.ceil(nMain / chosen.length);
  for (const s of chosen) s._due.slice(0, perCourse).forEach(take);
  // new cards, capped
  let newLeft = state.settings.newPerSession;
  const newLists = chosen.map(s => [...s._new]);              // alternate between the chosen courses
  while (main.length < nMain && newLeft > 0 && newLists.some(l => l.length))
    for (const l of newLists) { if (!l.length || main.length >= nMain || newLeft <= 0) continue; if (take(l.shift())) newLeft--; }
  // still room: weakest seen-but-not-due cards in chosen courses (extra practice on hard topics)
  if (main.length < nMain) {
    const extra = chosen.flatMap(s => s.course.cards).filter(c => progOf(c.id) && !picked.has(c.id))
      .sort((a, b) => strength(a.id) - strength(b.id));
    for (const c of extra) { if (main.length >= nMain) break; take(c); }
  }
  // early in the semester there is little to review: fill the rest of the time with more new cards
  while (main.length < nMain && newLists.some(l => l.length))
    for (const l of newLists) { if (l.length && main.length < nMain) take(l.shift()); }
  // review from other courses: due ones first, otherwise the weakest seen ones
  const others = state.courses.filter(c => !chosenSlugs.has(c.slug)).flatMap(c => c.cards);
  const otherDue = shuffle(others.filter(c => isDue(c.id)));
  const otherWeak = others.filter(c => progOf(c.id) && !isDue(c.id)).sort((a, b) => strength(a.id) - strength(b.id)).slice(0, 30);
  let otherAdded = 0;
  for (const c of [...otherDue, ...shuffle(otherWeak)]) { if (otherAdded >= nOther) break; if (take(c)) otherAdded++; }
  // if everything else is empty, fall back to new cards from anywhere
  if (!main.length) state.courses.flatMap(c => c.cards).filter(c => !progOf(c.id)).slice(0, target).forEach(take);
  if (!main.length) return null;

  // interleave: mix courses so the same course does not run for too long
  const groups = new Map();
  for (const c of main) { if (!groups.has(c.course)) groups.set(c.course, []); groups.get(c.course).push(c); }
  const queue = [];
  const lists = [...groups.values()];
  while (lists.some(l => l.length)) for (const l of shuffle(lists)) if (l.length) queue.push(l.shift());

  return { queue, idx: 0, start: Date.now(), minutes, courses: chosen.map(s => s.course.name),
    done: 0, results: { 1: 0, 2: 0, 3: 0, 4: 0 }, relearn: {} };
}

/* ---------- answer checking ---------- */
function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.+\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function stem(w) {
  w = w.replace(/^[.\-+]+|[.\-+]+$/g, '');
  if (w.length <= 3) return w;
  w = w.replace(/is(e|ed|es|ing|ation|ations)$/, 'iz$1').replace(/our$/, 'or');   // British vs American spelling
  return w.replace(/(ational|ization|isation)$/, 'ate').replace(/(ies)$/, 'y')
    .replace(/(ing|edly|ed|ly|es|s)$/, '').replace(/(ity|ness|ment)$/, '').replace(/e$/, '');
}
const tokens = s => norm(s).split(' ').filter(Boolean).map(stem);
function phraseIn(phrase, tset, text) {
  const pt = tokens(phrase);
  if (!pt.length) return false;
  if (pt.every(t => tset.has(t))) return true;
  return norm(text).includes(norm(phrase));            // catches symbols / digits like "u = r * i"
}
function checkAnswer(card, text) {
  const tset = new Set(tokens(text));
  const hits = [], missed = [];
  for (const kw of card.keywords) {
    const alts = [kw, ...((card.synonyms && card.synonyms[kw]) || [])];
    (alts.some(a => phraseIn(a, tset, text)) ? hits : missed).push(kw);
  }
  const total = card.keywords.length;
  const score = total ? hits.length / total : null;
  let suggested = null;
  if (!text.trim()) suggested = 1;
  else if (score !== null) suggested = score >= 0.9 ? 4 : score >= 0.6 ? 3 : score >= 0.3 ? 2 : 1;
  return { hits, missed, score, suggested };
}

/* ---------- speech ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function startListening(onText, onEnd) {
  if (!SR) return false;
  rec = new SR();
  rec.lang = state.settings.speechLang; rec.continuous = true; rec.interimResults = true;
  let finalText = '';
  rec.onresult = ev => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript + ' '; else interim += r[0].transcript;
    }
    onText((finalText + interim).trim());
  };
  rec.onerror = ev => { if (ev.error === 'not-allowed') toast('Microphone blocked. Allow it in the browser settings, or use the keyboard mic.'); };
  rec.onend = () => { rec = null; onEnd(); };
  try { rec.start(); } catch (e) { rec = null; return false; }
  return true;
}
function stopListening() { if (rec) try { rec.stop(); } catch (e) {} }

/* ---------- UI helpers ---------- */
const $view = document.getElementById('view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = x => Math.round(x * 100) + '%';
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 3200);
}
function fmtDays(d) { return d < 1 ? 'today' : d === 1 ? '1 day' : d < 30 ? d + ' days' : Math.round(d / 30) + ' mo'; }
function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-go]'); if (!b) return;
  stopListening();
  if (state.session && b.dataset.go !== 'session' && !confirmLeave()) return;
  route(b.dataset.go);
});
function confirmLeave() { if (state.session && state.session.done > 0) { finishSession(); return false; } state.session = null; return true; }
function route(name) { window.scrollTo(0, 0); ({ home: renderHome, stats: renderStats, settings: renderSettings, session: renderCard })[name](); }

/* ---------- home ---------- */
function renderHome() {
  const stats = state.courses.map(courseStats);
  const due = stats.reduce((s, x) => s + x.due, 0);
  const fresh = stats.reduce((s, x) => s + (x.total - x.seen), 0);
  const isSample = state.courses.length === 1 && state.courses[0].slug === 'sample';
  $view.innerHTML = `
    <h1>Ready to study</h1>
    <div class="box">
      <div class="row">
        <div><div class="big-num">${due}</div><div class="muted small">cards due today</div></div>
        <div><div class="big-num">${fresh}</div><div class="muted small">new cards left</div></div>
      </div>
      <button class="btn" id="start">Start ${state.settings.minutes}-minute session</button>
      <div class="muted small">Picks 1 or 2 courses for you, focused on what you find hardest, plus a few review cards from other courses.</div>
    </div>
    ${isSample ? '<div class="box small">These are sample cards. Your real course cards will appear here once they are added.</div>' : ''}
    <h2>Courses</h2>
    <div class="box">
      ${stats.map(s => `
        <div class="course-line">
          <div style="flex:1">
            <div><strong>${esc(s.course.name)}</strong></div>
            <div class="muted small">${s.due} due · ${s.total - s.seen} new · ${s.mastered}/${s.total} mastered</div>
            <div class="bar"><i style="width:${pct(s.mastered / s.total)}"></i></div>
          </div>
          <button class="btn ghost" style="width:auto;padding:8px 12px" data-course="${esc(s.course.slug)}">Study</button>
        </div>`).join('') || '<div class="muted">No cards found yet.</div>'}
    </div>`;
  document.getElementById('start').onclick = () => startSession();
  $view.querySelectorAll('[data-course]').forEach(b => b.onclick = () => startSession(b.dataset.course));
}
function startSession(slug) {
  state.session = buildSession(state.settings.minutes, slug);
  if (!state.session) { toast('Nothing to study yet.'); return; }
  route('session');
}

/* ---------- session card ---------- */
function renderCard() {
  const s = state.session;
  if (!s) return renderHome();
  const elapsed = (Date.now() - s.start) / 60000;
  if (s.idx >= s.queue.length || (elapsed >= s.minutes && !s.extended)) return finishSession();
  const card = s.queue[s.idx];
  const course = state.courses.find(c => c.slug === card.course);
  const p = progOf(card.id);
  const tag = !p ? 'New' : isDue(card.id) ? 'Review' : 'Practice';
  $view.innerHTML = `
    <div class="progress-top"><span>Card ${s.done + 1} · ${Math.floor(elapsed)} of ${s.minutes} min</span><span>${esc(s.courses.join(' + '))}</span></div>
    <div class="bar"><i style="width:${pct(Math.min(1, elapsed / s.minutes))}"></i></div>
    <div class="box">
      <div><span class="pill">${esc(course ? course.name : card.course)}</span><span class="pill">${esc(card.topic)}</span><span class="pill">${tag}</span></div>
      <div class="question">${esc(card.question)}</div>
      ${card.type === 'summary' ? '<div class="muted small">Explain this in your own words, then check.</div>' : ''}
    </div>
    <div id="answerArea">
      <button class="mic" id="mic" ${SR ? '' : 'style="display:none"'}>🎤 <span>Tap and speak your answer</span></button>
      <textarea id="txt" placeholder="${SR ? 'Your spoken answer appears here. You can also type or edit it.' : 'Speak with the keyboard microphone, or type your answer.'}"></textarea>
      <div class="row">
        <button class="btn secondary" id="dunno">I don't know</button>
        <button class="btn" id="check">Check answer</button>
      </div>
    </div>
    <div id="result"></div>
    <button class="btn ghost" id="end">End session</button>`;
  const txt = document.getElementById('txt'), mic = document.getElementById('mic');
  let listening = false;
  mic.onclick = () => {
    if (listening) { stopListening(); return; }
    const base = txt.value ? txt.value.trim() + ' ' : '';
    listening = startListening(t => { txt.value = base + t; }, () => { listening = false; mic.classList.remove('on'); mic.lastElementChild.textContent = 'Tap and speak your answer'; });
    if (listening) { mic.classList.add('on'); mic.lastElementChild.textContent = 'Listening… tap to stop'; }
    else toast('Voice input is not available here. Use the keyboard mic instead.');
  };
  document.getElementById('check').onclick = () => { stopListening(); showResult(card, txt.value); };
  document.getElementById('dunno').onclick = () => { stopListening(); showResult(card, ''); };
  document.getElementById('end').onclick = () => { stopListening(); finishSession(); };
}
function showResult(card, text) {
  const r = checkAnswer(card, text);
  document.getElementById('answerArea').style.display = 'none';
  const labels = ['', 'Again', 'Hard', 'Good', 'Easy'];
  const p = progOf(card.id) || { ivl: 0, ease: 2.5 };
  const preview = rt => rt === 1 ? '<10 min' : p.ivl === 0 ? fmtDays(rt === 4 ? 3 : 1) : fmtDays(rt === 2 ? Math.max(1, Math.round(p.ivl * 1.2)) : rt === 3 ? Math.max(p.ivl + 1, Math.round(p.ivl * p.ease)) : Math.max(p.ivl + 2, Math.round(p.ivl * p.ease * 1.3)));
  document.getElementById('result').innerHTML = `
    <div class="box">
      ${text.trim() ? `<div class="muted small">You said</div><div class="answer">${esc(text)}</div>` : '<div class="muted small">No answer given.</div>'}
      ${card.keywords.length ? `
        <div class="muted small" style="margin-top:10px">Key terms (${r.hits.length}/${card.keywords.length})</div>
        <div>${r.hits.map(k => `<span class="kw hit">✓ ${esc(k)}</span>`).join('')}${r.missed.map(k => `<span class="kw miss">${esc(k)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="box">
      <div class="muted small">Model answer</div>
      <div class="answer">${esc(card.answer)}</div>
      ${card.source ? `<div class="muted small" style="margin-top:8px">Source: ${esc(card.source)}</div>` : ''}
    </div>
    <div class="muted small">${r.suggested ? `Suggested: <strong>${labels[r.suggested]}</strong>. Tap a different one if you disagree.` : 'How well did you know it?'}</div>
    <div class="rates">
      ${[1, 2, 3, 4].map(i => `<button class="r${i} ${r.suggested === i ? 'suggested' : ''}" data-rate="${i}">${labels[i]}<small>${preview(i)}</small></button>`).join('')}
    </div>`;
  document.querySelectorAll('[data-rate]').forEach(b => b.onclick = () => rate(card, +b.dataset.rate, text, r));
  document.getElementById('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function rate(card, rating, text, r) {
  const s = state.session;
  schedule(card.id, rating);
  state.log.push({ t: new Date().toISOString(), id: card.id, course: card.course, topic: card.topic, question: card.question,
    answer: text, hits: r.hits, missed: r.missed, suggested: r.suggested, rating });
  saveLog();
  s.done++; s.results[rating]++;
  if (rating === 1 && (s.relearn[card.id] || 0) < 2) {      // see it again later in this session
    s.relearn[card.id] = (s.relearn[card.id] || 0) + 1;
    s.queue.splice(Math.min(s.queue.length, s.idx + 4), 0, card);
  }
  s.idx++;
  renderCard();
}
function finishSession() {
  const s = state.session; state.session = null;
  if (!s || !s.done) return renderHome();
  const mins = Math.max(1, Math.round((Date.now() - s.start) / 60000));
  const correct = s.results[3] + s.results[4];
  $view.innerHTML = `
    <h1>Session done</h1>
    <div class="box">
      <div class="row">
        <div><div class="big-num">${s.done}</div><div class="muted small">cards in ${mins} min</div></div>
        <div><div class="big-num">${pct(correct / s.done)}</div><div class="muted small">Good or Easy</div></div>
      </div>
      <div class="muted small" style="margin-top:10px">Again ${s.results[1]} · Hard ${s.results[2]} · Good ${s.results[3]} · Easy ${s.results[4]}</div>
    </div>
    <button class="btn" id="more">Keep going (+5 min)</button>
    <button class="btn secondary" data-go="home">Back to home</button>`;
  document.getElementById('more').onclick = () => {
    const next = buildSession(5);
    if (!next) return toast('Nothing left to study right now.');
    state.session = next; route('session');
  };
}

/* ---------- stats ---------- */
function renderStats() {
  const stats = state.courses.map(courseStats);
  const now = Date.now();
  const week = [0, 1, 2, 3, 4, 5, 6].map(d => {
    const end = endOfToday(now + d * DAY);
    return state.courses.flatMap(c => c.cards).filter(c => { const p = progOf(c.id); return p && p.due <= end && (d === 0 || p.due > endOfToday(now + (d - 1) * DAY)); }).length;
  });
  const last7 = state.log.filter(e => now - Date.parse(e.t) < 7 * DAY);
  $view.innerHTML = `
    <h1>Progress</h1>
    <div class="box">
      <div class="row">
        <div><div class="big-num">${last7.length}</div><div class="muted small">answers this week</div></div>
        <div><div class="big-num">${last7.length ? pct(last7.filter(e => e.rating >= 3).length / last7.length) : '–'}</div><div class="muted small">Good or Easy this week</div></div>
      </div>
      <div class="muted small" style="margin-top:10px">Due in the next 7 days: ${week.join(' · ')}</div>
    </div>
    <h2>By course (weakest first)</h2>
    ${stats.sort((a, b) => b.weak - a.weak).map(s => `
      <div class="box">
        <strong>${esc(s.course.name)}</strong>
        <div class="muted small">${s.seen}/${s.total} started · ${s.mastered} mastered · ${s.due} due${s.failRate !== null ? ` · ${pct(1 - s.failRate)} recent success` : ''}</div>
        <div class="bar"><i style="width:${pct(s.mastered / s.total)}"></i></div>
        <details><summary class="small">Topics</summary>
          ${s.topics.sort((a, b) => b.weak - a.weak).map(t => `
            <div class="course-line small">
              <div style="flex:1">${esc(t.topic)}<div class="bar"><i style="width:${pct(t.mastery)}"></i></div></div>
              <div class="muted" style="text-align:right">${t.seen}/${t.cards.length}${t.failRate !== null ? `<br>${pct(1 - t.failRate)} ok` : ''}</div>
            </div>`).join('')}
        </details>
      </div>`).join('')}
    <div class="muted small">“Mastered” means the next review is 3 weeks or more away.</div>`;
}

/* ---------- settings ---------- */
function renderSettings() {
  const st = state.settings;
  const opt = (vals, cur, fmt) => vals.map(v => `<option value="${v}" ${v == cur ? 'selected' : ''}>${fmt(v)}</option>`).join('');
  $view.innerHTML = `
    <h1>Settings</h1>
    <div class="box">
      <label class="field">Session length</label>
      <select id="minutes">${opt([10, 15, 20, 25, 30, 45, 60], st.minutes, v => v + ' minutes')}</select>
      <label class="field">New cards per session (max)</label>
      <select id="newPer">${opt([0, 4, 8, 12, 16, 24], st.newPerSession, v => v)}</select>
      <label class="field">Review cards from other courses</label>
      <select id="other">${opt([0, 0.1, 0.15, 0.25], st.otherShare, v => Math.round(v * 100) + '%')}</select>
      <label class="field">Voice recognition accent</label>
      <select id="lang">${opt(['en-US', 'en-GB', 'en-IN', 'en-AU'], st.speechLang, v => v)}</select>
    </div>
    <h2>Answer log</h2>
    <div class="box">
      <div class="muted small">${state.log.length} answers saved. Export them and give the file to Claude for a review of what you're missing.</div>
      <button class="btn secondary" id="expLog">Export answer log</button>
    </div>
    <h2>Backup</h2>
    <div class="box">
      <div class="muted small">Your progress only lives on this phone. Save a backup now and then.</div>
      <button class="btn secondary" id="expAll">Save backup</button>
      <button class="btn ghost" id="impAll">Restore backup</button>
      <input type="file" id="file" accept="application/json,.json" hidden>
      <button class="btn ghost" id="reset" style="color:var(--again)">Reset all progress</button>
    </div>
    <div class="muted small">Cards loaded: ${state.byId.size} from ${state.courses.length} course(s).</div>`;
  const bind = (id, key, conv) => document.getElementById(id).onchange = e => { st[key] = conv(e.target.value); saveSettings(); toast('Saved'); };
  bind('minutes', 'minutes', Number); bind('newPer', 'newPerSession', Number); bind('other', 'otherShare', Number); bind('lang', 'speechLang', String);
  const stamp = new Date().toISOString().slice(0, 10);
  document.getElementById('expLog').onclick = () => download(`study-log-${stamp}.json`, { exported: new Date().toISOString(), entries: state.log });
  document.getElementById('expAll').onclick = () => download(`study-backup-${stamp}.json`, { version: 1, exported: new Date().toISOString(), progress: state.prog, log: state.log, settings: st });
  const file = document.getElementById('file');
  document.getElementById('impAll').onclick = () => file.click();
  file.onchange = async () => {
    try {
      const data = JSON.parse(await file.files[0].text());
      if (!data.progress) throw new Error('not a backup');
      if (!confirm('Replace the progress on this phone with this backup?')) return;
      state.prog = data.progress; state.log = data.log || []; Object.assign(st, data.settings || {});
      saveProg(); saveLog(); saveSettings(); toast('Backup restored'); renderSettings();
    } catch (e) { toast('That file is not a Quick Studies backup.'); }
  };
  document.getElementById('reset').onclick = () => {
    if (!confirm('Delete all progress and the answer log on this phone?')) return;
    state.prog = {}; state.log = []; saveProg(); saveLog(); toast('Progress reset'); renderSettings();
  };
}

/* ---------- boot ---------- */
(async function boot() {
  $view.innerHTML = '<div class="muted">Loading cards…</div>';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await loadCards();
  renderHome();
})();
