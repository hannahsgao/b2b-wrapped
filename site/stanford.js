const EVENT_MILES = { '12K': 7.45, '15K Breakers Bonus': 9.32 };
const SUPPORTED_SOURCES = new Set(['official', 'strava', 'self']);

const state = {
  summary: null,
  results: null,
  curated: { registered_bibs: [], unregistered: [] },
  dbEntries: [],
  staticLoaded: false,
  filter: 'all',
  session: null,
  supabase: null,
  raceSeason: 2026,
  allowedEmailDomains: ['stanford.edu', 'alumni.stanford.edu'],
  authRedirectUrl: null,
  mobileSummaryText: '',
  mobileSummaryFileBase: 'cardinal-summary',
  mobileSummaryData: null,
};

const $ = (id) => document.getElementById(id);

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

function lowerBound(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function fieldStats(event, seconds) {
  if (!state.summary || !seconds) return null;
  const group = state.summary.groups?.[`event=${event}`];
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

function normalizeSource(source) {
  return SUPPORTED_SOURCES.has(source) ? source : 'self';
}

function entryKey(e) {
  return `${e.source}|${e.bib ?? ''}|${e.name}|${e.event}|${e.chip_seconds}`;
}

function isAllowedEmail(email) {
  const domain = String(email || '').toLowerCase().split('@')[1] || '';
  return state.allowedEmailDomains.includes(domain);
}

function setAuthStatus(message, tone = 'warning') {
  const el = $('authStatus');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('error', 'success', 'warning');
  el.classList.add(tone);
}

function setAuthedVisibility(isAuthed) {
  const gate = $('authGate');
  const content = $('authedContent');
  if (gate) gate.hidden = isAuthed;
  if (content) content.hidden = !isAuthed;
}

function getMagicLinkRedirectUrl() {
  if (state.authRedirectUrl) return state.authRedirectUrl;
  return `${window.location.origin}/stanford.html`;
}

async function loadStaticData() {
  if (state.staticLoaded) return;
  const [summary, results, curated] = await Promise.all([
    fetch('data/summary.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('data/results.min.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('data/stanford.json').then((r) => (r.ok ? r.json() : { registered_bibs: [], unregistered: [] })).catch(() => ({ registered_bibs: [], unregistered: [] })),
  ]);
  state.summary = summary;
  state.results = results;
  state.curated = curated || { registered_bibs: [], unregistered: [] };
  state.staticLoaded = true;
}

async function loadDbEntries() {
  if (!state.supabase || !state.session) {
    state.dbEntries = [];
    return;
  }
  const { data, error } = await state.supabase
    .from('stanford_leaderboard_entries')
    .select('id, season, user_id, email, name, affiliation, event, gender, source, chip_seconds, chip_time, distance_miles, created_at, updated_at')
    .eq('season', state.raceSeason)
    .order('chip_seconds', { ascending: true });

  if (error) {
    console.error(error);
    $('dataStatus').textContent = 'Unable to load leaderboard entries from Supabase.';
    state.dbEntries = [];
    return;
  }
  state.dbEntries = Array.isArray(data) ? data : [];
}

function buildEntries() {
  const out = [];
  const seen = new Set();
  const currentUserId = state.session?.user?.id || null;
  const push = (entry) => {
    if (!entry || !Number.isFinite(entry.chip_seconds)) return;
    const k = entryKey(entry);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(entry);
  };

  const bibIndex = new Map();
  if (state.results && Array.isArray(state.results.rows)) {
    for (const row of state.results.rows) {
      if (row.bib != null) bibIndex.set(`${row.event}|${row.bib}`, row);
    }
  }

  for (const ref of state.curated.registered_bibs || []) {
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
      isYou: false,
    });
  }

  for (const item of state.curated.unregistered || []) {
    const event = item.event || '12K';
    const miles = EVENT_MILES[event] || null;
    let seconds = parseTime(item.chip_time) ?? (Number.isFinite(item.chip_seconds) ? item.chip_seconds : null);
    let source = normalizeSource(item.source === 'strava' ? 'strava' : 'self');
    if (item.strava_time && Number(item.strava_distance) > 0 && miles) {
      const stravaSeconds = parseTime(item.strava_time);
      if (stravaSeconds) {
        seconds = Math.round(stravaSeconds * (miles / Number(item.strava_distance)));
        source = 'strava';
      }
    }
    if (!Number.isFinite(seconds)) continue;
    push({
      source,
      name: item.name || 'Anonymous',
      affiliation: item.affiliation || '',
      event,
      bib: null,
      gender: item.gender || null,
      chip_seconds: seconds,
      chip_time: formatTime(seconds),
      distance_miles: miles,
      isYou: false,
    });
  }

  for (const row of state.dbEntries) {
    const event = row.event;
    push({
      source: normalizeSource(row.source),
      name: row.name || 'Anonymous',
      affiliation: row.affiliation || '',
      event,
      bib: null,
      gender: row.gender || null,
      chip_seconds: Number(row.chip_seconds),
      chip_time: row.chip_time || formatTime(row.chip_seconds),
      distance_miles: Number(row.distance_miles) || EVENT_MILES[event] || null,
      user_id: row.user_id,
      isYou: currentUserId ? row.user_id === currentUserId : false,
    });
  }

  out.sort((a, b) => a.chip_seconds - b.chip_seconds || a.name.localeCompare(b.name));
  out.forEach((entry, i) => { entry.cardinal_rank = i + 1; });
  return out;
}

function filteredEntries(entries) {
  if (state.filter === 'all') return entries;
  return entries.filter((e) => e.event === state.filter);
}

function updateStatus(entries) {
  const status = $('dataStatus');
  if (!status) return;
  const counts = entries.reduce((acc, e) => {
    acc.total += 1;
    acc[e.event] = (acc[e.event] || 0) + 1;
    return acc;
  }, { total: 0 });
  const parts = [];
  if (counts['12K']) parts.push(`12K: ${counts['12K']}`);
  if (counts['15K Breakers Bonus']) parts.push(`15K: ${counts['15K Breakers Bonus']}`);
  status.textContent = counts.total
    ? `${counts.total} verified Cardinal ${counts.total === 1 ? 'entry' : 'entries'}${parts.length ? ' · ' + parts.join(' · ') : ''}`
    : 'No verified entries yet. Add yours above.';
}

function syncDeleteButton() {
  const btn = $('clearLocal');
  if (!btn || !state.session) return;
  const event = $('event').value;
  const currentUserId = state.session.user.id;
  const hasEntry = state.dbEntries.some((row) => row.user_id === currentUserId && row.event === event && row.season === state.raceSeason);
  btn.hidden = !hasEntry;
}

function renderBoard() {
  const wrap = $('boardWrap');
  const meta = $('boardMeta');
  if (!wrap || !meta) return;

  const all = buildEntries();
  const showing = filteredEntries(all);
  showing.forEach((entry, i) => { entry.view_rank = i + 1; });

  updateStatus(all);
  syncDeleteButton();

  if (!showing.length) {
    wrap.innerHTML = '<div class="leaderboard-empty">No entries yet for this view. Be the first verified Cardinal on the board.</div>';
    meta.textContent = `${all.length} total entries`;
    return;
  }

  const rows = showing.map((entry) => {
    const pace = formatPace(entry.chip_seconds, entry.distance_miles);
    const source = normalizeSource(entry.source);
    const pill = `<span class="src-pill ${source}">${source}</span>`;
    const aff = entry.affiliation ? escapeHtml(entry.affiliation) : '—';
    const youClass = entry.isYou ? ' class="you"' : '';
    return `
      <tr${youClass}>
        <td class="rank">${entry.view_rank}</td>
        <td>${escapeHtml(entry.name)}</td>
        <td class="event">${escapeHtml(entry.event === '15K Breakers Bonus' ? '15K' : entry.event)}</td>
        <td class="time">${formatTime(entry.chip_seconds)}</td>
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

  const filterLabel = state.filter === 'all' ? 'entries' : `in ${state.filter === '15K Breakers Bonus' ? '15K' : state.filter}`;
  meta.textContent = `${showing.length} ${filterLabel} · ${all.length} total`;
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
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function setMobileSummaryStatus(message) {
  const el = $('mobileSummaryStatus');
  if (!el) return;
  el.textContent = message || '';
}

function wrapTextLines(ctx, text, maxWidth) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const words = clean.split(' ');
  const lines = [];
  let line = words.shift() || '';
  for (const word of words) {
    const test = `${line} ${word}`;
    if (ctx.measureText(test).width <= maxWidth) {
      line = test;
    } else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

function renderSummaryImageCanvas(summary, theme) {
  const width = 1080;
  const padding = 56;
  const innerWidth = width - (padding * 2);
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = 2800;
  const ctx = scratch.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable in this browser.');

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, scratch.width, scratch.height);
  ctx.textBaseline = 'top';

  let y = 56;
  const badgeLabel = 'B2B 2026 CARDINAL WRAPPED';
  ctx.font = '800 20px Archivo, Arial, sans-serif';
  const badgeWidth = Math.min(innerWidth, Math.ceil(ctx.measureText(badgeLabel).width) + 32);
  const badgeHeight = 44;
  ctx.fillStyle = theme.badgeBg || theme.ink;
  ctx.fillRect(padding, y, badgeWidth, badgeHeight);
  ctx.fillStyle = theme.badgeText;
  ctx.fillText(badgeLabel, padding + 16, y + 10);
  y += badgeHeight + 30;

  ctx.fillStyle = theme.accentPalette?.[0] || theme.accent;
  ctx.fillRect(padding, y, innerWidth, 6);
  y += 22;

  ctx.fillStyle = theme.ink;
  ctx.font = '900 72px Archivo, Arial, sans-serif';
  for (const line of wrapTextLines(ctx, summary.name, innerWidth)) {
    ctx.fillText(line, padding, y);
    y += 78;
  }
  y += 6;

  ctx.fillStyle = theme.meta;
  ctx.font = '700 27px Archivo, Arial, sans-serif';
  for (const line of wrapTextLines(ctx, `${summary.event} • ${summary.sourceLabel}`, innerWidth)) {
    ctx.fillText(line, padding, y);
    y += 34;
  }

  ctx.fillStyle = theme.ink;
  ctx.font = '800 34px Archivo, Arial, sans-serif';
  for (const line of wrapTextLines(ctx, `${summary.time} • ${summary.pace}`, innerWidth)) {
    ctx.fillText(line, padding, y);
    y += 42;
  }
  for (const line of wrapTextLines(ctx, `${summary.rankText} • ${summary.cardinalPercent}`, innerWidth)) {
    ctx.fillText(line, padding, y);
    y += 42;
  }
  if (summary.affiliation) {
    for (const line of wrapTextLines(ctx, `Affiliation: ${summary.affiliation}`, innerWidth)) {
      ctx.fillText(line, padding, y);
      y += 42;
    }
  }
  y += 10;

  ctx.fillStyle = theme.meta;
  ctx.font = '800 22px Archivo, Arial, sans-serif';
  ctx.fillText('SCORECARD DETAILS', padding, y);
  y += 34;

  for (let i = 0; i < summary.stats.length; i += 1) {
    const item = summary.stats[i];
    const boxX = padding;
    const boxY = y;
    const boxW = innerWidth;
    const accentColor = theme.accentPalette?.[i % theme.accentPalette.length] || theme.accent;
    const boxPadX = 28;
    const leftRail = 12;

    ctx.font = '800 20px Archivo, Arial, sans-serif';
    const kickerLines = wrapTextLines(ctx, item.kicker.toUpperCase(), boxW - (boxPadX * 2) - leftRail);
    ctx.font = '800 44px Archivo, Arial, sans-serif';
    const valueLines = wrapTextLines(ctx, item.value, boxW - (boxPadX * 2) - leftRail);
    ctx.font = '500 26px Archivo, Arial, sans-serif';
    const copyLines = wrapTextLines(ctx, item.copy, boxW - (boxPadX * 2) - leftRail);

    const boxH = 18 + (kickerLines.length * 24) + 10 + (valueLines.length * 50) + 8 + (copyLines.length * 34) + 18;
    ctx.fillStyle = theme.card;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = accentColor;
    ctx.fillRect(boxX, boxY, leftRail, boxH);
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    let textY = boxY + 18;
    ctx.fillStyle = theme.meta;
    ctx.font = '800 20px Archivo, Arial, sans-serif';
    for (const line of kickerLines) {
      ctx.fillText(line, boxX + boxPadX + leftRail, textY);
      textY += 24;
    }

    ctx.fillStyle = accentColor;
    ctx.font = '800 44px Archivo, Arial, sans-serif';
    textY += 10;
    for (const line of valueLines) {
      ctx.fillText(line, boxX + boxPadX + leftRail, textY);
      textY += 50;
    }

    ctx.fillStyle = theme.copy;
    ctx.font = '500 26px Archivo, Arial, sans-serif';
    textY += 8;
    for (const line of copyLines) {
      ctx.fillText(line, boxX + boxPadX + leftRail, textY);
      textY += 34;
    }

    y += boxH + 16;
  }

  y += 16;
  ctx.fillStyle = theme.meta;
  ctx.font = '700 22px Archivo, Arial, sans-serif';
  const generatedText = `Generated ${new Date().toLocaleString()}`;
  for (const line of wrapTextLines(ctx, generatedText, innerWidth)) {
    ctx.fillText(line, padding, y);
    y += 30;
  }

  const finalHeight = Math.max(1200, Math.ceil(y + 56));
  const output = document.createElement('canvas');
  output.width = width;
  output.height = finalHeight;
  const outCtx = output.getContext('2d');
  if (!outCtx) throw new Error('Could not finalize image canvas.');
  outCtx.drawImage(scratch, 0, 0);
  return output;
}

function triggerCanvasDownload(canvas, filename) {
  const fallbackDownload = () => {
    const dataUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (canvas.toBlob) {
    canvas.toBlob((blob) => {
      if (!blob) {
        fallbackDownload();
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, 'image/png');
    return;
  }
  fallbackDownload();
}

function buildMobileSummaryText(summary) {
  const lines = [
    'Bay to Breakers 2026 - Cardinal Summary Wrapped',
    `Name: ${summary.name}`,
    `Affiliation: ${summary.affiliation || '-'}`,
    `Event: ${summary.event}`,
    `Source: ${summary.sourceLabel}`,
    `Time: ${summary.time}`,
    `Pace: ${summary.pace}`,
    `Cardinal rank: ${summary.rankText}`,
    `Ahead of Cardinals: ${summary.cardinalPercent}`,
    '',
    'Scorecard details:',
  ];
  for (const item of summary.stats) {
    lines.push(`- ${item.kicker}: ${item.value}`);
    lines.push(`  ${item.copy}`);
  }
  lines.push('', `Generated: ${new Date().toLocaleString()}`);
  return lines.join('\n');
}

function renderMobileSummaryWrapped(summary) {
  const section = $('mobileSummaryWrapped');
  const card = $('mobileSummaryCard');
  if (!section || !card) return;

  if (!summary) {
    section.hidden = true;
    card.innerHTML = '';
    state.mobileSummaryText = '';
    state.mobileSummaryFileBase = 'cardinal-summary';
    state.mobileSummaryData = null;
    setMobileSummaryStatus('');
    return;
  }

  const rows = summary.stats.map((item) => `
    <li class="mobile-summary-item">
      <p class="mobile-summary-item-kicker">${escapeHtml(item.kicker)}</p>
      <p class="mobile-summary-item-value">${escapeHtml(item.value)}</p>
      <p class="mobile-summary-item-copy">${escapeHtml(item.copy)}</p>
    </li>
  `).join('');

  card.innerHTML = `
    <header class="mobile-summary-head">
      <p class="mobile-summary-title">${escapeHtml(summary.name)}</p>
      <p class="mobile-summary-subtitle">${escapeHtml(summary.event)} · ${escapeHtml(summary.sourceLabel)}</p>
      <p class="mobile-summary-time">${escapeHtml(summary.time)} · ${escapeHtml(summary.pace)}</p>
      <p class="mobile-summary-rank">${escapeHtml(summary.rankText)} · ${escapeHtml(summary.cardinalPercent)}</p>
      <p class="mobile-summary-affiliation">${escapeHtml(summary.affiliation ? `Affiliation: ${summary.affiliation}` : 'Affiliation: —')}</p>
    </header>
    <ol class="mobile-summary-list">${rows}</ol>
  `;

  state.mobileSummaryText = buildMobileSummaryText(summary);
  state.mobileSummaryFileBase = slugify(`${summary.name}-${summary.event}-wrapped`) || 'cardinal-summary';
  state.mobileSummaryData = summary;
  setMobileSummaryStatus('Ready to copy, download text, or download image.');
  section.hidden = false;
}

async function copyMobileSummary() {
  if (!state.mobileSummaryText) {
    setMobileSummaryStatus('Generate your scorecard first, then copy.');
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(state.mobileSummaryText);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = state.mobileSummaryText;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setMobileSummaryStatus('Summary copied to clipboard.');
  } catch (err) {
    console.error(err);
    setMobileSummaryStatus('Could not copy. Try download instead.');
  }
}

function downloadMobileSummary() {
  if (!state.mobileSummaryText) {
    setMobileSummaryStatus('Generate your scorecard first, then download.');
    return;
  }
  const blob = new Blob([state.mobileSummaryText], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = `${state.mobileSummaryFileBase || 'cardinal-summary'}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  setMobileSummaryStatus(`Downloaded ${link.download}.`);
}

function downloadMobileSummaryImage() {
  if (!state.mobileSummaryData) {
    setMobileSummaryStatus('Generate your scorecard first, then download an image.');
    return;
  }
  try {
    const canvas = renderSummaryImageCanvas(state.mobileSummaryData, {
      bg: '#FDF5F2',
      card: '#FFFFFF',
      ink: '#0A0A0A',
      accent: '#8C1515',
      accentPalette: ['#8C1515', '#B1040E', '#FFD200', '#2E2A25'],
      meta: '#555555',
      copy: '#1F1F1F',
      badgeBg: '#0A0A0A',
      badgeText: '#FFD200',
    });
    const fileName = `${state.mobileSummaryFileBase || 'cardinal-summary'}-summary.png`;
    triggerCanvasDownload(canvas, fileName);
    setMobileSummaryStatus(`Downloaded ${fileName}.`);
  } catch (err) {
    console.error(err);
    setMobileSummaryStatus(`Could not generate image: ${err.message}`);
  }
}

function renderComparison(you, all) {
  const event = you.event;
  const inEvent = all.filter((e) => e.event === event).sort((a, b) => a.chip_seconds - b.chip_seconds);
  const myRank = inEvent.findIndex((e) => e.isYou) + 1;
  const total = inEvent.length;
  const beatN = Math.max(0, total - myRank);
  const beatPct = total > 1 ? (beatN / (total - 1)) * 100 : 100;
  const rankText = total > 1 ? `${ordinal(myRank)} of ${total}` : '1st of 1';
  const sourceLabel = you.source === 'strava' ? 'Strava-normalized' : (you.source === 'official' ? 'official chip time' : 'self-reported');

  $('results').hidden = false;
  $('runnerTitle').textContent = `${formatTime(you.chip_seconds)} — ${descriptor(beatPct)}`;
  $('runnerSubtitle').textContent = `${event} · ${sourceLabel} · ${formatPace(you.chip_seconds, you.distance_miles)}`;

  const cards = $('cards');
  cards.innerHTML = '';
  const summaryStats = [];
  const appendStat = (kicker, value, copy) => {
    cards.appendChild(card(kicker, value, copy));
    summaryStats.push({ kicker, value, copy });
  };

  appendStat(
    'Cardinal rank',
    total > 1 ? `${ordinal(myRank)}` : '1st',
    total > 1
      ? `Out of ${total} Cardinal ${event} entries on the board. You beat ${beatN}.`
      : `Sole Cardinal ${event} entry so far — flex the bib.`
  );

  appendStat(
    'Cardinal %',
    `${beatPct.toFixed(0)}%`,
    total > 1
      ? `Ahead of ${beatPct.toFixed(0)}% of Stanford folks in ${event}.`
      : 'Add some friends to the board to fill this in.'
  );

  const fs = fieldStats(event, you.chip_seconds);
  if (fs) {
    appendStat(
      'Full field %',
      `${fs.beatPct.toFixed(1)}%`,
      `Ahead of ${fs.slower.toLocaleString()} of ${fs.count.toLocaleString()} total ${event} finishers (Laurel Timing).`
    );

    const delta = you.chip_seconds - fs.median;
    const deltaText = delta === 0
      ? 'exactly the median'
      : (delta < 0 ? `${formatTime(-delta)} faster than median` : `${formatTime(delta)} slower than median`);
    appendStat('Vs field median', deltaText, `Median ${event} finish was ${fs.medianText}.`);
  }

  appendStat(
    'Pace',
    formatPace(you.chip_seconds, you.distance_miles),
    `Official distance used here: ${you.distance_miles} mi. GPS routes can read longer or shorter.`
  );

  if (inEvent.length > 1) {
    const median = inEvent[Math.floor(inEvent.length / 2)];
    appendStat('Cardinal median', formatTime(median.chip_seconds), `Median Cardinal ${event} time across ${inEvent.length} entries.`);
  }

  renderMobileSummaryWrapped({
    name: you.name || 'Anonymous',
    affiliation: you.affiliation || '',
    event,
    sourceLabel,
    time: formatTime(you.chip_seconds),
    pace: formatPace(you.chip_seconds, you.distance_miles),
    rankText,
    cardinalPercent: `${beatPct.toFixed(0)}% ahead of Cardinals`,
    stats: summaryStats,
  });
}

function populateFormFromEntry(entry) {
  if (!entry) return;
  $('name').value = entry.name || '';
  $('event').value = entry.event || '12K';
  $('affiliation').value = entry.affiliation || '';
  $('gender').value = entry.gender || '';
  if (entry.source === 'strava') {
    $('stravaTime').value = formatTime(entry.chip_seconds);
    $('stravaDistance').value = entry.distance_miles || '';
    document.querySelector('.strava')?.setAttribute('open', '');
    $('time').value = '';
  } else {
    $('time').value = formatTime(entry.chip_seconds);
    $('stravaTime').value = '';
    $('stravaDistance').value = '';
  }
}

function hydrateFormFromCurrentUser() {
  if (!state.session) return;
  const userId = state.session.user.id;
  const currentEvent = $('event').value;
  const row = state.dbEntries.find((r) => r.user_id === userId && r.event === currentEvent && r.season === state.raceSeason)
    || state.dbEntries.find((r) => r.user_id === userId && r.season === state.raceSeason);
  if (!row) {
    syncDeleteButton();
    return;
  }
  populateFormFromEntry({
    name: row.name,
    event: row.event,
    affiliation: row.affiliation,
    gender: row.gender,
    source: normalizeSource(row.source),
    chip_seconds: Number(row.chip_seconds),
    distance_miles: Number(row.distance_miles) || EVENT_MILES[row.event],
  });
  syncDeleteButton();
}

function setFilter(filter, btn) {
  state.filter = filter;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.setAttribute('aria-pressed', tab === btn ? 'true' : 'false');
  });
  renderBoard();
}

async function compareFromForm() {
  if (!state.supabase || !state.session) {
    alert('Sign in first.');
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

  const user = state.session.user;
  const payload = {
    season: state.raceSeason,
    user_id: user.id,
    email: user.email,
    name,
    affiliation: affiliation || null,
    event,
    gender,
    source,
    chip_seconds: seconds,
    chip_time: formatTime(seconds),
    distance_miles: miles,
    updated_at: new Date().toISOString(),
  };

  $('dataStatus').textContent = 'Saving your verified entry…';

  const { error } = await state.supabase
    .from('stanford_leaderboard_entries')
    .upsert(payload, { onConflict: 'user_id,event,season' });

  if (error) {
    console.error(error);
    alert(`Could not save entry: ${error.message}`);
    renderBoard();
    return;
  }

  await loadDbEntries();
  const all = buildEntries();
  renderBoard();

  const you = all.find((entry) => entry.isYou && entry.event === event)
    || all.find((entry) => entry.isYou);
  if (you) {
    renderComparison(you, all);
    window.scrollTo({ top: $('results').offsetTop - 20, behavior: 'smooth' });
  }
}

async function clearCurrentEventEntry() {
  if (!state.supabase || !state.session) return;
  const event = $('event').value;
  const ok = window.confirm(`Remove your ${event} entry from the verified leaderboard?`);
  if (!ok) return;

  const { error } = await state.supabase
    .from('stanford_leaderboard_entries')
    .delete()
    .eq('user_id', state.session.user.id)
    .eq('event', event)
    .eq('season', state.raceSeason);

  if (error) {
    console.error(error);
    alert(`Could not remove entry: ${error.message}`);
    return;
  }

  ['name', 'affiliation', 'time', 'gender', 'stravaTime', 'stravaDistance'].forEach((id) => {
    if ($(id)) $(id).value = '';
  });
  $('results').hidden = true;
  renderMobileSummaryWrapped(null);

  await loadDbEntries();
  renderBoard();
  hydrateFormFromCurrentUser();
}

async function sendMagicLink() {
  if (!state.supabase) return;
  const email = $('authEmail').value.trim().toLowerCase();
  if (!email) {
    setAuthStatus('Enter your Stanford email first.', 'error');
    return;
  }
  if (!isAllowedEmail(email)) {
    setAuthStatus('Use a @stanford.edu or @alumni.stanford.edu email.', 'error');
    return;
  }

  setAuthStatus('Sending magic link…', 'warning');

  const redirectTo = getMagicLinkRedirectUrl();
  const isRedirectError = (message) => /redirect|not allowed|invalid/i.test(String(message || ''));
  const isRateLimitError = (message) => /rate.?limit|too many requests|email rate limit exceeded/i.test(String(message || ''));
  const isEmailSendError = (message) => /error sending magic link email|error sending email|smtp|mailer/i.test(String(message || ''));
  let { error } = await state.supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo,
      shouldCreateUser: true,
    },
  });

  // If redirect URLs are misconfigured in Supabase, retry without override so
  // Supabase can fall back to its project-level Site URL.
  if (error && isRedirectError(error.message)) {
    ({ error } = await state.supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    }));
  }

  if (error) {
    console.error(error);
    if (isRateLimitError(error.message)) {
      setAuthStatus('Too many sign-in emails sent. Wait a minute, then try again.', 'error');
    } else if (isEmailSendError(error.message)) {
      setAuthStatus('Sign-in email could not be sent. Check Supabase SMTP (Resend host/user/password + verified sender domain).', 'error');
    } else if (isRedirectError(error.message)) {
      setAuthStatus(`Sign-in failed: ${error.message}. Check Supabase redirect URLs for this domain.`, 'error');
    } else {
      setAuthStatus(`Sign-in failed: ${error.message}`, 'error');
    }
    return;
  }

  setAuthStatus('Magic link sent. Open it from your inbox, then return here.', 'success');
}

async function signOut() {
  if (!state.supabase) return;
  await state.supabase.auth.signOut();
}

async function refreshSession() {
  if (!state.supabase) return;
  const { data, error } = await state.supabase.auth.getSession();
  if (error) {
    console.error(error);
    setAuthStatus(`Session refresh failed: ${error.message}`, 'error');
    return;
  }
  await handleSession(data.session);
}

async function handleSession(session) {
  if (!session) {
    state.session = null;
    setAuthedVisibility(false);
    setAuthStatus('Sign in with a Stanford email to continue.', 'warning');
    renderMobileSummaryWrapped(null);
    return;
  }

  const email = session.user?.email || '';
  if (!isAllowedEmail(email)) {
    await state.supabase.auth.signOut();
    setAuthedVisibility(false);
    setAuthStatus('Only Stanford emails are allowed on this leaderboard.', 'error');
    return;
  }

  state.session = session;
  $('whoami').textContent = `Signed in as ${email}`;
  setAuthedVisibility(true);

  await loadStaticData();
  await loadDbEntries();
  renderBoard();
  hydrateFormFromCurrentUser();

  const all = buildEntries();
  const you = all.find((entry) => entry.isYou);
  if (you) renderComparison(you, all);
  else {
    $('results').hidden = true;
    renderMobileSummaryWrapped(null);
  }
}

function loadConfig() {
  const cfg = window.B2B_AUTH_CONFIG || {};
  const supabaseUrl = String(cfg.supabaseUrl || '').trim();
  const supabaseAnonKey = String(cfg.supabaseAnonKey || '').trim();
  const emailRedirectUrl = String(cfg.emailRedirectUrl || '').trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing B2B_AUTH_CONFIG.supabaseUrl or supabaseAnonKey in auth config script');
  }
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    throw new Error('Supabase client library failed to load.');
  }
  state.allowedEmailDomains = Array.isArray(cfg.allowedEmailDomains) && cfg.allowedEmailDomains.length
    ? cfg.allowedEmailDomains.map((d) => String(d).toLowerCase())
    : state.allowedEmailDomains;
  state.raceSeason = Number.isFinite(Number(cfg.raceSeason)) ? Number(cfg.raceSeason) : state.raceSeason;
  if (emailRedirectUrl) {
    try {
      state.authRedirectUrl = new URL(emailRedirectUrl, window.location.origin).toString();
    } catch {
      throw new Error('Invalid B2B_AUTH_CONFIG.emailRedirectUrl');
    }
  }
  return { supabaseUrl, supabaseAnonKey };
}

async function boot() {
  try {
    const { supabaseUrl, supabaseAnonKey } = loadConfig();
    state.supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    state.supabase.auth.onAuthStateChange((_event, session) => {
      handleSession(session).catch((err) => {
        console.error(err);
        setAuthedVisibility(false);
        setAuthStatus(`Auth error: ${err.message}`, 'error');
      });
    });

    const { data, error } = await state.supabase.auth.getSession();
    if (error) throw error;
    await handleSession(data.session);
  } catch (err) {
    console.error(err);
    setAuthedVisibility(false);
    setAuthStatus(`Auth config error: ${err.message}`, 'error');
  }
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => setFilter(btn.dataset.filter, btn));
});

$('event').addEventListener('change', () => {
  hydrateFormFromCurrentUser();
  renderBoard();
});
$('sendLink').addEventListener('click', sendMagicLink);
$('refreshSession').addEventListener('click', refreshSession);
$('signOut').addEventListener('click', signOut);
$('compare').addEventListener('click', () => {
  compareFromForm().catch((err) => {
    console.error(err);
    alert(`Could not save entry: ${err.message}`);
  });
});
$('clearLocal').addEventListener('click', () => {
  clearCurrentEventEntry().catch((err) => {
    console.error(err);
    alert(`Could not remove entry: ${err.message}`);
  });
});
$('copyMobileSummary').addEventListener('click', () => {
  copyMobileSummary().catch((err) => {
    console.error(err);
    setMobileSummaryStatus(`Could not copy summary: ${err.message}`);
  });
});
$('downloadMobileSummary').addEventListener('click', downloadMobileSummary);
$('downloadMobileSummaryImage').addEventListener('click', downloadMobileSummaryImage);

boot();
