const state = {
  summary: null,
  results: null,
  loaded: false,
};

const $ = (id) => document.getElementById(id);

function parseTime(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  const parts = s.split(':').map((x) => Number(x));
  if (parts.some((x) => Number.isNaN(x) || x < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function formatTime(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatPace(seconds, miles) {
  if (!seconds || !miles) return '—';
  return `${formatTime(seconds / miles)}/mi`;
}

function ageGroup(age) {
  const a = Number(age);
  if (!Number.isFinite(a)) return 'Unknown';
  if (a <= 19) return '19 & Under';
  if (a <= 29) return '20-29';
  if (a <= 39) return '30-39';
  if (a <= 49) return '40-49';
  if (a <= 59) return '50-59';
  if (a <= 69) return '60-69';
  if (a <= 79) return '70-79';
  return '80+';
}

function groupKey(filters) {
  return Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
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

function statsFor(key, seconds) {
  const group = state.summary.groups[key];
  if (!group || !group.times || !group.times.length) return null;
  const faster = lowerBound(group.times, seconds);
  const equalOrFaster = upperBound(group.times, seconds);
  const slower = group.times.length - equalOrFaster;
  const rank = faster + 1;
  const beatPct = (slower / group.times.length) * 100;
  return { group, faster, slower, rank, beatPct, count: group.times.length };
}

function descriptor(beatPct) {
  if (beatPct >= 98) return 'front-of-the-pack chaos goblin';
  if (beatPct >= 90) return 'elite costume dodger';
  if (beatPct >= 75) return 'certified Hayes Hill survivor';
  if (beatPct >= 50) return 'faster than the median party';
  if (beatPct >= 25) return 'vibes-first finisher';
  return 'maximum cardio-chaos enjoyer';
}

function signedDelta(seconds) {
  if (seconds === 0) return 'exactly the median';
  const abs = formatTime(Math.abs(seconds));
  return seconds < 0 ? `${abs} faster than median` : `${abs} slower than median`;
}

function card(kicker, value, copy) {
  const t = $('cardTemplate');
  const node = t.content.firstElementChild.cloneNode(true);
  node.querySelector('.stat-kicker').textContent = kicker;
  node.querySelector('.stat-value').textContent = value;
  node.querySelector('.stat-copy').textContent = copy;
  return node;
}

function nearestRows(event, seconds, limit = 7) {
  const rows = state.results.rows.filter((r) => r.event === event && Number.isFinite(r.chip_seconds));
  return rows
    .map((r) => ({ ...r, delta: Math.abs(r.chip_seconds - seconds) }))
    .sort((a, b) => a.delta - b.delta || a.chip_seconds - b.chip_seconds)
    .slice(0, limit);
}

function renderNearest(event, seconds) {
  const rows = nearestRows(event, seconds);
  if (!rows.length) {
    $('nearest').textContent = 'No nearby finishers found.';
    return;
  }
  const table = document.createElement('table');
  table.innerHTML = `
    <thead><tr><th>Name</th><th>Bib</th><th>Time</th><th>Delta</th><th>Category</th></tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(r.name || '—')}</td>
      <td>${r.bib ?? '—'}</td>
      <td>${formatTime(r.chip_seconds)}</td>
      <td>${r.delta === 0 ? 'same time' : formatTime(r.delta)}</td>
      <td>${escapeHtml([r.gender, r.age_group].filter(Boolean).join(' ') || '—')}</td>
    `;
    tbody.appendChild(tr);
  });
  $('nearest').innerHTML = '';
  $('nearest').appendChild(table);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}

function compare() {
  if (!state.loaded) {
    alert('Data is not loaded yet. Run the scraper + derive scripts first.');
    return;
  }
  const event = $('event').value;
  const gender = $('gender').value;
  const age = $('age').value;
  const ag = ageGroup(age);
  const eventMiles = state.summary.distance_miles[event];

  let seconds = parseTime($('time').value);
  let sourceLabel = 'official chip time';
  const stravaTime = parseTime($('stravaTime').value);
  const stravaDistance = Number($('stravaDistance').value);
  if (stravaTime && Number.isFinite(stravaDistance) && stravaDistance > 0 && eventMiles) {
    seconds = Math.round(stravaTime * (eventMiles / stravaDistance));
    sourceLabel = `Strava-normalized time from ${formatTime(stravaTime)} over ${stravaDistance.toFixed(2)} mi`;
  }

  if (!seconds) {
    alert('Enter a valid finish time, like 1:02:34 or 58:12.');
    return;
  }

  const overall = statsFor(groupKey({ event }), seconds);
  const genderStats = gender ? statsFor(groupKey({ event, gender }), seconds) : null;
  const ageStats = ag !== 'Unknown' ? statsFor(groupKey({ event, age_group: ag }), seconds) : null;
  const comboStats = gender && ag !== 'Unknown' ? statsFor(groupKey({ event, gender, age_group: ag }), seconds) : null;

  if (!overall) {
    alert(`No distributions found for ${event}.`);
    return;
  }

  $('results').hidden = false;
  $('runnerTitle').textContent = `${formatTime(seconds)} — ${descriptor(overall.beatPct)}`;
  $('runnerSubtitle').textContent = `${event} · ${sourceLabel} · ${formatPace(seconds, eventMiles)}`;

  const cards = $('cards');
  cards.innerHTML = '';
  cards.appendChild(card(
    'Overall field',
    `${overall.beatPct.toFixed(1)}%`,
    `You beat about ${overall.slower.toLocaleString()} of ${overall.count.toLocaleString()} ${event} finishers. Estimated place: ${overall.rank.toLocaleString()}.`
  ));

  if (genderStats) {
    cards.appendChild(card(
      'Gender field',
      `${genderStats.beatPct.toFixed(1)}%`,
      `Among ${gender} runners, you beat about ${genderStats.slower.toLocaleString()} of ${genderStats.count.toLocaleString()}.`
    ));
  }

  if (ageStats) {
    cards.appendChild(card(
      'Age group',
      `${ageStats.beatPct.toFixed(1)}%`,
      `In ${ag}, you beat about ${ageStats.slower.toLocaleString()} of ${ageStats.count.toLocaleString()} runners.`
    ));
  }

  if (comboStats) {
    cards.appendChild(card(
      'Gender + age',
      `${comboStats.beatPct.toFixed(1)}%`,
      `In ${gender} ${ag}, estimated rank ${comboStats.rank.toLocaleString()} of ${comboStats.count.toLocaleString()}.`
    ));
  }

  const median = overall.group.p50_seconds;
  cards.appendChild(card(
    'Vs median',
    signedDelta(seconds - median),
    `Median ${event} finish was ${overall.group.p50}. Your pace: ${formatPace(seconds, eventMiles)}.`
  ));

  cards.appendChild(card(
    'Finish pace',
    formatPace(seconds, eventMiles),
    `Official distance used here: ${eventMiles} miles. GPS routes can read longer or shorter.`
  ));

  const bib = Number($('bib').value);
  if (Number.isFinite(bib)) {
    const runner = state.results.rows.find((r) => r.event === event && Number(r.bib) === bib);
    if (runner && runner.teams && runner.teams.length) {
      const team = runner.teams[0];
      cards.appendChild(card(
        'Centipede team',
        team.team_name || 'Team result',
        team.team_rank ? `Team rank ${team.team_rank}; team average ${team.team_avg_chip_time || '—'}.` : `Team average ${team.team_avg_chip_time || '—'}.`
      ));
    }
  }

  renderNearest(event, seconds);
  window.scrollTo({ top: $('results').offsetTop - 20, behavior: 'smooth' });
}

function lookupBib() {
  if (!state.loaded) return;
  const bib = Number($('bib').value);
  if (!Number.isFinite(bib)) {
    alert('Enter a bib number.');
    return;
  }
  const event = $('event').value;
  let row = state.results.rows.find((r) => r.event === event && Number(r.bib) === bib);
  if (!row) row = state.results.rows.find((r) => Number(r.bib) === bib);
  if (!row) {
    alert('No public result found for that bib in the loaded data.');
    return;
  }
  $('event').value = row.event;
  $('time').value = row.chip_time || formatTime(row.chip_seconds);
  $('gender').value = row.gender || '';
  $('age').value = row.age || '';
  $('runnerTitle').textContent = `${row.name || 'Runner'} · Bib ${row.bib}`;
}

async function loadData() {
  try {
    const [summary, results] = await Promise.all([
      fetch('data/summary.json').then((r) => {
        if (!r.ok) throw new Error('summary.json missing');
        return r.json();
      }),
      fetch('data/results.min.json').then((r) => {
        if (!r.ok) throw new Error('results.min.json missing');
        return r.json();
      }),
    ]);
    state.summary = summary;
    state.results = results;
    state.loaded = true;
    const countText = Object.entries(summary.counts_by_event || {})
      .map(([event, count]) => `${event}: ${Number(count).toLocaleString()}`)
      .join(' · ');
    $('dataStatus').textContent = `Data loaded. ${countText}`;
  } catch (err) {
    $('dataStatus').innerHTML = `Data not found yet. Run <code>python scripts/scrape_laurelt.py --out data</code> then <code>python scripts/derive_site_data.py --results data/b2b_2026_results_raw.csv --teams data/b2b_2026_teams_raw.csv --out public/data</code>.`;
  }
}

$('compare').addEventListener('click', compare);
$('lookup').addEventListener('click', lookupBib);
loadData();
