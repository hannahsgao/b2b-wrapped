const STORAGE_KEY = 'b2b_stanford_you_v1';
const GITHUB_REPO = 'hannahgao/b2b-wrapped';

const state = {
  summary: null,
  results: null,
  curated: null,
  loaded: false,
  filter: 'all',
};

const $ = (id) => document.getElementById(id);
const EVENT_MILES = { '12K': 7.45, '15K Breakers Bonus': 9.32 };

function parseTime(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((x) => Number.isNaN(x) || x < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function formatTime(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const s0 = Math.round(seconds);
  const h = Math.floor(s0 / 3600);
  const m = Math.floor((s0 % 3600) / 60);
  const s = s0 % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatPace(seconds, miles) {
  if (!seconds || !miles) return '—';
  return `${formatTime(seconds / miles)}/mi`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[c]));
}

function readYou() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeYou(entry) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {}
}

function clearYou() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function lowerBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(arr, target) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function fieldStats(event, seconds) {
  if (!state.summary || !seconds) return null;
  const group = state.summary.groups[`event=${event}`];
  if (!group || !group.times || !group.times.length) return null;
  const equalOrFaster = upperBound(group.times, seconds);
  const slower = group.times.length - equalOrFaster;
  const beatPct = (slower / group.times.length) * 100;
  return {
    count: group.times.length,
    slower,
    beatPct,
    median: group.p50_seconds,
    medianText: group.p50,
  };
}

function entryKey(e) {
  return `${e.source}|${e.bib ?? ''}|${e.name}|${e.event}|${e.chip_seconds}`;
}

function buildEntries() {
  const out = [];
  const seen = new Set();
  const push = (e) => {
    if (!e || !Number.isFinite(e.chip_seconds)) return;
    const k = entryKey(e);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };

  const bibIndex = new Map();
  if (state.results && Array.isArray(state.results.rows)) {
    for (const r of state.results.rows) {
      if (r.bib != null) bibIndex.set(`${r.event}|${r.bib}`, r);
    }
  }

  const curated = state.curated || {};
  for (const ref of curated.registered_bibs || []) {
    const event = ref.event || '12K';
    const row = bibIndex.get(`${event}|${ref.bib}`);
    if (!row) continue;
    push({
      source: 'official',
      name: ref.display_name || row.name || `Bib ${row.bib}`,
      affiliation: ref.affiliation || '',
      event,
      bib: row.bib,
      gender: row.gender || null,
      chip_seconds: row.chip_seconds,
      chip_time: row.chip_time || formatTime(row.chip_seconds),
      distance_miles: row.distance_miles || EVENT_MILES[event] || null,
    });
  }

  for (const e of curated.unregistered || []) {
    const event = e.event || '12K';
    const miles = EVENT_MILES[event] || null;
    let seconds = parseTime(e.chip_time) ?? (Number.isFinite(e.chip_seconds) ? e.chip_seconds : null);
    let source = e.source === 'strava' ? 'strava' : 'self';
    if (e.strava_time && Number(e.strava_distance) > 0 && miles) {
      const st = parseTime(e.strava_time);
      if (st) {
        seconds = Math.round(st * (miles / Number(e.strava_distance)));
        source = 'strava';
      }
    }
    if (!Number.isFinite(seconds)) continue;
    push({
      source,
      name: e.name || 'Anonymous',
      affiliation: e.affiliation || '',
      event,
      bib: null,
      gender: e.gender || null,
      chip_seconds: seconds,
      chip_time: formatTime(seconds),
      distance_miles: miles,
    });
  }

  const you = readYou();
  if (you && Number.isFinite(you.chip_seconds)) {
    push({ ...you, isYou: true });
  }

  out.sort((a, b) => a.chip_seconds - b.chip_seconds || a.name.localeCompare(b.name));
  out.forEach((e, i) => { e.cardinal_rank = i + 1; });
  return out;
}

function filteredEntries(entries) {
  if (state.filter === 'all') return entries;
  return entries.filter((e) => e.event === state.filter);
}

function updateStatus(entries) {
  const el = $('dataStatus');
  if (!el) return;
  const counts = entries.reduce((acc, e) => {
    acc.total += 1;
    acc[e.event] = (acc[e.event] || 0) + 1;
    return acc;
  }, { total: 0 });
  const parts = [];
  if (counts['12K']) parts.push(`12K: ${counts['12K']}`);
  if (counts['15K Breakers Bonus']) parts.push(`15K: ${counts['15K Breakers Bonus']}`);
  el.textContent = counts.total
    ? `${counts.total} Cardinal ${counts.total === 1 ? 'entry' : 'entries'} on the board${parts.length ? ' · ' + parts.join(' · ') : ''}`
    : `Cardinal board is empty — add yourself to start it.`;
}

function renderBoard() {
  const wrap = $('boardWrap');
  const meta = $('boardMeta');
  if (!wrap) return;
  const all = buildEntries();
  const showing = filteredEntries(all);
  // Re-rank within the active filter so #1 in 12K is #1 in the 12K view.
  showing.forEach((e, i) => { e.view_rank = i + 1; });

  updateStatus(all);

  if (!showing.length) {
    wrap.innerHTML = `<div class="leaderboard-empty">No entries yet for this view. Be the first to add yourself above.</div>`;
    meta.textContent = `${all.length} total Cardinal entries`;
    return;
  }

  const rows = showing.map((e) => {
    const pace = formatPace(e.chip_seconds, e.distance_miles);
    const pill = `<span class="src-pill ${e.source}">${e.source}</span>`;
    const aff = e.affiliation ? escapeHtml(e.affiliation) : '—';
    const youClass = e.isYou ? ' class="you"' : '';
    return `
      <tr${youClass}>
        <td class="rank">${e.view_rank}</td>
        <td>${escapeHtml(e.name)}</td>
        <td class="event">${escapeHtml(e.event === '15K Breakers Bonus' ? '15K' : e.event)}</td>
        <td class="time">${formatTime(e.chip_seconds)}</td>
        <td class="pace">${pace}</td>
        <td class="aff">${aff}</td>
        <td class="src">${pill}</td>
      </tr>
    `;
  }).join('');

  wrap.innerHTML = `
    <table>
      <thead><tr>
        <th>#</th><th>Name</th><th>Event</th><th>Time</th><th>Pace</th><th>Affiliation</th><th>Source</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  meta.textContent = `${showing.length} ${state.filter === 'all' ? 'entries' : 'in ' + (state.filter === '15K Breakers Bonus' ? '15K' : state.filter)} · ${all.length} total`;
}

function descriptor(pct) {
  if (pct >= 95) return 'fastest Cardinal on the course';
  if (pct >= 80) return 'front-of-the-Farm finisher';
  if (pct >= 60) return 'solidly upper-Quad pace';
  if (pct >= 40) return 'middle-of-the-Marguerite cruiser';
  if (pct >= 20) return 'casual-Tresidder pace';
  return 'showed-up-and-that-counts vibe';
}

function card(kicker, value, copy) {
  const t = $('cardTemplate');
  const node = t.content.firstElementChild.cloneNode(true);
  node.querySelector('.stat-kicker').textContent = kicker;
  node.querySelector('.stat-value').textContent = value;
  node.querySelector('.stat-copy').textContent = copy;
  return node;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function renderComparison(you, all) {
  const event = you.event;
  const inEvent = all.filter((e) => e.event === event);
  inEvent.sort((a, b) => a.chip_seconds - b.chip_seconds);
  const myRank = inEvent.findIndex((e) => e.isYou) + 1;
  const n = inEvent.length;
  const beatN = Math.max(0, n - myRank);
  const beatPct = n > 1 ? (beatN / (n - 1)) * 100 : 100;
  const seconds = you.chip_seconds;

  $('results').hidden = false;
  $('runnerTitle').textContent = `${formatTime(seconds)} — ${descriptor(beatPct)}`;
  const srcLabel = you.source === 'strava'
    ? 'Strava-normalized'
    : you.source === 'official' ? 'official chip time' : 'self-reported';
  $('runnerSubtitle').textContent = `${event} · ${srcLabel} · ${formatPace(seconds, you.distance_miles)}`;

  const cards = $('cards');
  cards.innerHTML = '';

  cards.appendChild(card(
    'Cardinal rank',
    n > 1 ? `${ordinal(myRank)}` : '1st',
    n > 1
      ? `Out of ${n} Cardinal ${event} entries on the board. You beat ${beatN}.`
      : `Sole Cardinal ${event} entry so far — flex the bib.`
  ));

  cards.appendChild(card(
    'Cardinal %',
    `${beatPct.toFixed(0)}%`,
    n > 1
      ? `Ahead of ${beatPct.toFixed(0)}% of Stanford folks in ${event}.`
      : `Add some friends to the board to fill this in.`
  ));

  const fs = fieldStats(event, seconds);
  if (fs) {
    cards.appendChild(card(
      'Full field %',
      `${fs.beatPct.toFixed(1)}%`,
      `Ahead of ${fs.slower.toLocaleString()} of ${fs.count.toLocaleString()} total ${event} finishers (Laurel Timing).`
    ));
    const delta = seconds - fs.median;
    const deltaText = delta === 0
      ? 'exactly the median'
      : delta < 0
        ? `${formatTime(-delta)} faster than median`
        : `${formatTime(delta)} slower than median`;
    cards.appendChild(card(
      'Vs field median',
      deltaText,
      `Median ${event} finish was ${fs.medianText}.`
    ));
  }

  cards.appendChild(card(
    'Pace',
    formatPace(seconds, you.distance_miles),
    `Official distance used here: ${you.distance_miles} mi. GPS routes can read longer or shorter.`
  ));

  if (inEvent.length > 1) {
    const median = inEvent[Math.floor(inEvent.length / 2)];
    cards.appendChild(card(
      'Cardinal median',
      formatTime(median.chip_seconds),
      `Median Cardinal ${event} time across ${inEvent.length} entries.`
    ));
  }
}

function buildPublicSubmissionURL(entry) {
  const title = `Stanford leaderboard: add ${entry.name} (${entry.event})`;
  const body = [
    'Add this entry to `site/data/stanford.json` → `unregistered`:',
    '',
    '```json',
    JSON.stringify(
      {
        name: entry.name,
        event: entry.event,
        gender: entry.gender || undefined,
        affiliation: entry.affiliation || undefined,
        chip_time: formatTime(entry.chip_seconds),
        source: entry.source,
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
  const params = new URLSearchParams({
    title,
    body,
    labels: 'stanford-leaderboard',
  });
  return `https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`;
}

function refreshSubmissionLink(entry) {
  const link = $('submitPublic');
  if (!link) return;
  if (!entry) {
    link.setAttribute('href', `https://github.com/${GITHUB_REPO}/issues/new?labels=stanford-leaderboard`);
    return;
  }
  link.setAttribute('href', buildPublicSubmissionURL(entry));
}

function compareFromForm() {
  if (!state.loaded) {
    alert('Data is still loading.');
    return;
  }
  const name = $('name').value.trim();
  const event = $('event').value;
  const affiliation = $('affiliation').value.trim();
  const gender = $('gender').value || null;
  const miles = EVENT_MILES[event];

  let seconds = parseTime($('time').value);
  let source = 'self';
  const stravaTime = parseTime($('stravaTime').value);
  const stravaDistance = Number($('stravaDistance').value);
  if (stravaTime && Number.isFinite(stravaDistance) && stravaDistance > 0 && miles) {
    seconds = Math.round(stravaTime * (miles / stravaDistance));
    source = 'strava';
  }

  if (!name) {
    alert('Add a display name so you show up on the board.');
    return;
  }
  if (!seconds) {
    alert('Enter a valid finish time, like 1:02:34 or 58:12.');
    return;
  }

  const you = {
    source,
    name,
    affiliation,
    event,
    bib: null,
    gender,
    chip_seconds: seconds,
    chip_time: formatTime(seconds),
    distance_miles: miles,
    isYou: true,
    saved_at: new Date().toISOString(),
  };
  writeYou(you);
  $('clearLocal').hidden = false;
  refreshSubmissionLink(you);

  const all = buildEntries();
  renderBoard();
  renderComparison(you, all);
  window.scrollTo({ top: $('results').offsetTop - 20, behavior: 'smooth' });
}

function hydrateFormFromYou() {
  const you = readYou();
  if (!you) {
    $('clearLocal').hidden = true;
    return;
  }
  $('name').value = you.name || '';
  $('event').value = you.event || '12K';
  $('affiliation').value = you.affiliation || '';
  $('gender').value = you.gender || '';
  if (you.source === 'strava') {
    $('stravaTime').value = formatTime(you.chip_seconds);
    $('stravaDistance').value = you.distance_miles || '';
    document.querySelector('.strava')?.setAttribute('open', '');
  } else {
    $('time').value = formatTime(you.chip_seconds);
  }
  $('clearLocal').hidden = false;
  refreshSubmissionLink(you);
  const all = buildEntries();
  renderComparison(you, all);
}

function setFilter(filter, btn) {
  state.filter = filter;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-pressed', t === btn ? 'true' : 'false'));
  renderBoard();
}

async function loadData() {
  try {
    const [summary, results, curated] = await Promise.all([
      fetch('../data/summary.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('../data/results.min.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('../data/stanford.json').then((r) => {
        if (!r.ok) throw new Error('stanford.json missing');
        return r.json();
      }),
    ]);
    state.summary = summary;
    state.results = results;
    state.curated = curated;
    state.loaded = true;
    renderBoard();
    hydrateFormFromYou();
  } catch (err) {
    console.error(err);
    $('dataStatus').innerHTML = `Couldn't load <code>../data/stanford.json</code>. The page still works for local entries.`;
    state.loaded = true;
    state.curated = { registered_bibs: [], unregistered: [] };
    renderBoard();
    hydrateFormFromYou();
  }
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => setFilter(btn.dataset.filter, btn));
});
$('compare').addEventListener('click', compareFromForm);
$('clearLocal').addEventListener('click', () => {
  clearYou();
  ['name', 'affiliation', 'time', 'gender', 'stravaTime', 'stravaDistance'].forEach((id) => {
    if ($(id)) $(id).value = '';
  });
  $('clearLocal').hidden = true;
  $('results').hidden = true;
  refreshSubmissionLink(null);
  renderBoard();
});
refreshSubmissionLink(null);
loadData();
