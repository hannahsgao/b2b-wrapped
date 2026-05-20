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
  mobileSummaryImageBlob: null,
  mobileSummaryImageUrl: null,
  mobileSummaryImageFileName: '',
  mobileSummaryImageToken: 0,
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

/* ---------------- shareable poster (canvas) ---------------------------- */

function drawTextLines(ctx, lines, x, y, lineHeight) {
  let cursor = y;
  for (const line of lines) {
    ctx.fillText(line, x, cursor);
    cursor += lineHeight;
  }
  return cursor;
}

function strokeRectOutline(ctx, x, y, w, h, color, lineWidth) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.strokeRect(x + lineWidth / 2, y + lineWidth / 2, w - lineWidth, h - lineWidth);
  ctx.restore();
}

function drawDiagonalPaper(ctx, x, y, w, h, base, accent) {
  ctx.save();
  ctx.fillStyle = base;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.16;
  const step = 22;
  ctx.beginPath();
  for (let d = -h; d < w + h; d += step) {
    ctx.moveTo(x + d, y);
    ctx.lineTo(x + d - h, y + h);
    ctx.lineTo(x + d - h + 10, y + h);
    ctx.lineTo(x + d + 10, y);
  }
  ctx.fill();
  ctx.restore();
}

function renderSummaryImageCanvas(summary, theme) {
  const width = 1080;
  const height = 1920;
  const padding = 48;
  const innerWidth = width - (padding * 2);
  const palette = theme.accentPalette || [theme.accent, theme.accent, theme.accent, theme.accent];

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable in this browser.');

  drawDiagonalPaper(ctx, 0, 0, width, height, theme.bg, theme.accent);

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(padding, padding, innerWidth, height - padding * 2);
  strokeRectOutline(ctx, padding, padding, innerWidth, height - padding * 2, theme.ink, 4);

  ctx.textBaseline = 'top';

  const headerH = 84;
  ctx.fillStyle = theme.ink;
  ctx.fillRect(padding, padding, innerWidth, headerH);

  ctx.fillStyle = theme.badgeText;
  ctx.font = '900 28px Archivo, Arial, sans-serif';
  ctx.fillText('B·2·B', padding + 26, padding + 26);

  ctx.font = '800 16px Archivo, Arial, sans-serif';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(theme.editionLabel || '2026 CARDINAL', padding + 156, padding + 32);

  ctx.fillStyle = theme.accent;
  ctx.font = '800 16px Archivo, Arial, sans-serif';
  const eventLine = `${summary.event.toUpperCase()} · STANFORD · 5/17/26`;
  const eventWidth = ctx.measureText(eventLine).width;
  ctx.fillText(eventLine, padding + innerWidth - eventWidth - 26, padding + 32);

  let y = padding + headerH;

  const heroPadX = 40;
  const heroBlockH = 488;
  const heroTop = y;
  ctx.fillStyle = theme.card;
  ctx.fillRect(padding, y, innerWidth, heroBlockH);
  ctx.save();
  const grad = ctx.createRadialGradient(
    padding + innerWidth, y, 20,
    padding + innerWidth, y, 360,
  );
  grad.addColorStop(0, theme.accentSoft || 'rgba(255, 210, 0, 0.32)');
  grad.addColorStop(1, 'rgba(255, 210, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(padding, y, innerWidth, heroBlockH);
  ctx.restore();

  ctx.font = '900 16px Archivo, Arial, sans-serif';
  const kickerLabel = 'CARDINAL SCORECARD';
  const kickerW = Math.ceil(ctx.measureText(kickerLabel).width) + 28;
  const kickerH = 32;
  const kickerX = padding + heroPadX;
  const kickerY = heroTop + 22;
  ctx.fillStyle = theme.ink;
  ctx.fillRect(kickerX + 4, kickerY + 4, kickerW, kickerH);
  ctx.fillStyle = palette[1] || theme.accent;
  ctx.fillRect(kickerX, kickerY, kickerW, kickerH);
  strokeRectOutline(ctx, kickerX, kickerY, kickerW, kickerH, theme.ink, 2);
  ctx.fillStyle = theme.ink;
  ctx.fillText(kickerLabel, kickerX + 14, kickerY + 9);

  let nameY = kickerY + kickerH + 18;
  ctx.fillStyle = theme.ink;
  ctx.font = '900 64px Archivo, Arial, sans-serif';
  const nameLines = wrapTextLines(ctx, summary.name, innerWidth - heroPadX * 2).slice(0, 2);
  nameY = drawTextLines(ctx, nameLines, padding + heroPadX, nameY, 68);

  ctx.font = '800 18px Archivo, Arial, sans-serif';
  ctx.fillStyle = theme.meta;
  const subtitle = summary.affiliation
    ? `${summary.event} · ${summary.affiliation.toUpperCase()} · ${summary.sourceLabel.toUpperCase()}`
    : `${summary.event} · ${summary.sourceLabel.toUpperCase()}`;
  for (const line of wrapTextLines(ctx, subtitle, innerWidth - heroPadX * 2).slice(0, 2)) {
    ctx.fillText(line, padding + heroPadX, nameY + 6);
    nameY += 22;
  }

  const timeBoxW = innerWidth - heroPadX * 2;
  const timeBoxH = 168;
  const timeBoxX = padding + heroPadX;
  const timeBoxY = nameY + 30;
  ctx.fillStyle = theme.accent;
  ctx.fillRect(timeBoxX + 10, timeBoxY + 10, timeBoxW, timeBoxH);
  ctx.fillStyle = theme.ink;
  ctx.fillRect(timeBoxX, timeBoxY, timeBoxW, timeBoxH);

  ctx.font = '900 15px Archivo, Arial, sans-serif';
  const finishLabel = 'FINISH';
  const finishLabelW = Math.ceil(ctx.measureText(finishLabel).width) + 22;
  const finishLabelH = 26;
  ctx.fillStyle = palette[1] || theme.accent;
  ctx.fillRect(timeBoxX + 22, timeBoxY - finishLabelH / 2 + 2, finishLabelW, finishLabelH);
  strokeRectOutline(ctx, timeBoxX + 22, timeBoxY - finishLabelH / 2 + 2, finishLabelW, finishLabelH, theme.ink, 2);
  ctx.fillStyle = theme.ink;
  ctx.fillText(finishLabel, timeBoxX + 33, timeBoxY - finishLabelH / 2 + 8);

  ctx.fillStyle = palette[1] || '#FFD200';
  ctx.font = '900 104px Archivo, Arial, sans-serif';
  ctx.fillText(summary.time, timeBoxX + 24, timeBoxY + 38);

  ctx.font = '900 30px Archivo, Arial, sans-serif';
  ctx.fillStyle = '#FFFFFF';
  const paceText = summary.pace;
  const paceW = ctx.measureText(paceText).width;
  ctx.fillText(paceText, timeBoxX + timeBoxW - paceW - 24, timeBoxY + 46);

  ctx.font = '800 15px Archivo, Arial, sans-serif';
  ctx.fillStyle = theme.accent;
  const descriptorText = (summary.descriptor || '').toUpperCase();
  const descLines = wrapTextLines(ctx, descriptorText, 320).slice(0, 2);
  let descCursor = timeBoxY + 92;
  for (const line of descLines) {
    const w = ctx.measureText(line).width;
    ctx.fillText(line, timeBoxX + timeBoxW - w - 24, descCursor);
    descCursor += 18;
  }

  const badgeY = timeBoxY + timeBoxH + 24;
  const badges = (summary.badges || []).slice(0, 3);
  if (badges.length) {
    let bx = padding + heroPadX;
    ctx.font = '800 14px Archivo, Arial, sans-serif';
    for (let i = 0; i < badges.length; i += 1) {
      const label = badges[i];
      const w = Math.ceil(ctx.measureText(label).width) + 24;
      const h = 32;
      const fills = [theme.accent, palette[1] || theme.accent, theme.ink];
      const text = [theme.badgeText, theme.ink, palette[1] || theme.accent];
      ctx.fillStyle = fills[i % fills.length];
      ctx.fillRect(bx, badgeY, w, h);
      strokeRectOutline(ctx, bx, badgeY, w, h, theme.ink, 2);
      ctx.fillStyle = text[i % text.length];
      ctx.fillText(label, bx + 12, badgeY + 9);
      bx += w + 10;
    }
  }

  y += heroBlockH;

  const drawSectionTitle = (title, swatchColor) => {
    const sx = padding + heroPadX;
    const sy = y + 22;
    ctx.save();
    ctx.translate(sx + 9, sy + 9);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = swatchColor;
    ctx.fillRect(-9, -9, 18, 18);
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-9, -9, 18, 18);
    ctx.restore();
    ctx.font = '900 17px Archivo, Arial, sans-serif';
    ctx.fillStyle = theme.ink;
    ctx.fillText(title.toUpperCase(), sx + 30, sy + 2);
  };

  ctx.save();
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(padding, y);
  ctx.lineTo(padding + innerWidth, y);
  ctx.stroke();
  ctx.restore();

  // -------- pacing tiles ----------------------------------------------
  drawSectionTitle('Pacing wrapped', palette[0]);
  y += 58;

  const tiles = (summary.tiles || []).slice(0, 6);
  const tileCols = 3;
  const tileGap = 14;
  const tileW = Math.floor((innerWidth - heroPadX * 2 - tileGap * (tileCols - 1)) / tileCols);
  const tileH = 134;

  for (let i = 0; i < tiles.length; i += 1) {
    const col = i % tileCols;
    const row = Math.floor(i / tileCols);
    const tx = padding + heroPadX + col * (tileW + tileGap);
    const ty = y + row * (tileH + tileGap);
    const accent = palette[i % palette.length];

    ctx.fillStyle = theme.ink;
    ctx.fillRect(tx + 4, ty + 4, tileW, tileH);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(tx, ty, tileW, tileH);
    strokeRectOutline(ctx, tx, ty, tileW, tileH, theme.ink, 2);

    ctx.fillStyle = accent;
    ctx.fillRect(tx, ty, tileW, 7);

    const tile = tiles[i];
    ctx.fillStyle = theme.meta;
    ctx.font = '800 11px Archivo, Arial, sans-serif';
    const kickerLines = wrapTextLines(ctx, tile.kicker.toUpperCase(), tileW - 22);
    drawTextLines(ctx, kickerLines.slice(0, 2), tx + 12, ty + 18, 14);

    ctx.fillStyle = accent;
    ctx.font = '900 28px Archivo, Arial, sans-serif';
    const valueLines = wrapTextLines(ctx, tile.value, tileW - 22);
    drawTextLines(ctx, valueLines.slice(0, 1), tx + 12, ty + 52, 30);

    ctx.fillStyle = theme.copy;
    ctx.font = '600 11px Archivo, Arial, sans-serif';
    const copyLines = wrapTextLines(ctx, tile.copy || '', tileW - 22);
    drawTextLines(ctx, copyLines.slice(0, 2), tx + 12, ty + 96, 13);
  }

  const tileRows = Math.ceil(tiles.length / tileCols) || 0;
  y += tileRows * tileH + (tileRows > 0 ? (tileRows - 1) * tileGap : 0) + 24;

  ctx.save();
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(padding, y);
  ctx.lineTo(padding + innerWidth, y);
  ctx.stroke();
  ctx.restore();

  // -------- mini histogram --------------------------------------------
  drawSectionTitle('You vs the field', palette[1]);
  y += 58;

  if (summary.histogram) {
    const h = summary.histogram;
    const chartX = padding + heroPadX;
    const chartY = y;
    const chartW = innerWidth - heroPadX * 2;
    const chartH = 220;
    const padL = 16, padR = 16, padT = 14, padB = 38;
    const innerChartW = chartW - padL - padR;
    const innerChartH = chartH - padT - padB;
    const baselineY = chartY + padT + innerChartH;

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(chartX, chartY, chartW, chartH);
    strokeRectOutline(ctx, chartX, chartY, chartW, chartH, theme.ink, 2);

    const bins = h.bins || [];
    const maxC = Math.max(1, ...bins);
    const barW = innerChartW / bins.length;
    for (let i = 0; i < bins.length; i += 1) {
      const bh = Math.max(1.5, (bins[i] / maxC) * innerChartH);
      const bx = chartX + padL + i * barW;
      const by = baselineY - bh;
      const isUser = i === h.userBin;
      ctx.fillStyle = isUser ? theme.accent : (theme.field || '#2E2A25');
      ctx.fillRect(bx + 1, by, Math.max(1, barW - 2), bh);
    }
    ctx.fillStyle = theme.ink;
    ctx.fillRect(chartX + padL - 4, baselineY, innerChartW + 8, 2);

    const xForTime = (t) => chartX + padL + ((t - h.lo) / Math.max(1, h.hi - h.lo)) * innerChartW;
    const medianX = xForTime(h.medianSeconds);
    ctx.save();
    ctx.strokeStyle = theme.ink;
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(medianX, chartY + padT - 4);
    ctx.lineTo(medianX, baselineY);
    ctx.stroke();
    ctx.restore();

    const userX = xForTime(h.userSeconds);
    ctx.fillStyle = palette[1] || theme.accent;
    ctx.fillRect(userX - 1.5, chartY + padT, 3, innerChartH);

    const stickerW = 128;
    const stickerH = 52;
    let stickerX = userX - stickerW / 2;
    stickerX = Math.max(chartX + 4, Math.min(chartX + chartW - stickerW - 4, stickerX));
    const stickerY = chartY + 6;
    ctx.fillStyle = theme.ink;
    ctx.fillRect(stickerX + 4, stickerY + 4, stickerW, stickerH);
    ctx.fillStyle = palette[1] || '#FFD200';
    ctx.fillRect(stickerX, stickerY, stickerW, stickerH);
    strokeRectOutline(ctx, stickerX, stickerY, stickerW, stickerH, theme.ink, 2);
    ctx.fillStyle = theme.ink;
    ctx.font = '900 11px Archivo, Arial, sans-serif';
    ctx.fillText('YOU', stickerX + 12, stickerY + 8);
    ctx.font = '900 20px Archivo, Arial, sans-serif';
    ctx.fillText(summary.time, stickerX + 12, stickerY + 24);

    ctx.fillStyle = theme.ink;
    ctx.font = '800 13px Archivo, Arial, sans-serif';
    ctx.fillText(formatTime(h.lo), chartX + padL, baselineY + 8);
    const hiText = formatTime(h.hi);
    const hiW = ctx.measureText(hiText).width;
    ctx.fillText(hiText, chartX + chartW - padR - hiW, baselineY + 8);

    ctx.fillStyle = theme.meta;
    ctx.font = '700 10px Archivo, Arial, sans-serif';
    ctx.fillText('FRONT OF PACK', chartX + padL, baselineY + 22);
    const bopText = 'BACK OF PACK';
    const bopW = ctx.measureText(bopText).width;
    ctx.fillText(bopText, chartX + chartW - padR - bopW, baselineY + 22);

    const captionY = chartY + chartH + 14;
    ctx.fillStyle = theme.ink;
    ctx.font = '900 15px Archivo, Arial, sans-serif';
    ctx.fillText(
      `${h.beatPct.toFixed(1)}% AHEAD · ${h.slower.toLocaleString()} OF ${h.count.toLocaleString()} ${summary.event.toUpperCase()} FINISHERS`,
      chartX,
      captionY,
    );
    y = captionY + 26;
  }

  ctx.save();
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(padding, y);
  ctx.lineTo(padding + innerWidth, y);
  ctx.stroke();
  ctx.restore();

  // -------- neighbors ------------------------------------------------
  drawSectionTitle(theme.neighborsTitle || 'Cardinal neighbors', palette[2] || theme.accent);
  y += 58;

  const neighbors = (summary.neighbors || []).slice(0, 5);
  if (neighbors.length) {
    const tableX = padding + heroPadX;
    const tableW = innerWidth - heroPadX * 2;
    const rowH = 40;
    const tableH = rowH * neighbors.length + 4;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(tableX, y, tableW, tableH);
    strokeRectOutline(ctx, tableX, y, tableW, tableH, theme.ink, 2);

    for (let i = 0; i < neighbors.length; i += 1) {
      const rn = neighbors[i];
      const ry = y + 2 + i * rowH;
      if (rn.isYou) {
        ctx.fillStyle = palette[1] || theme.accent;
        ctx.fillRect(tableX + 2, ry, tableW - 4, rowH);
      }

      ctx.fillStyle = rn.isYou ? palette[0] : theme.meta;
      ctx.font = '900 15px Archivo, Arial, sans-serif';
      ctx.fillText(rn.isYou ? '★' : '·', tableX + 18, ry + 13);

      ctx.fillStyle = theme.ink;
      ctx.font = rn.isYou ? '900 17px Archivo, Arial, sans-serif' : '700 17px Archivo, Arial, sans-serif';
      ctx.fillText(rn.name, tableX + 42, ry + 11);

      ctx.font = '800 15px Archivo, Arial, sans-serif';
      const timeText = rn.time;
      const timeW = ctx.measureText(timeText).width;
      ctx.fillStyle = theme.ink;
      ctx.fillText(timeText, tableX + tableW - 200 - timeW / 2, ry + 13);

      ctx.font = '800 15px Archivo, Arial, sans-serif';
      ctx.fillStyle = rn.delta === 0 ? theme.ink : palette[0];
      const deltaText = rn.deltaLabel;
      const deltaW = ctx.measureText(deltaText).width;
      ctx.fillText(deltaText, tableX + tableW - 22 - deltaW, ry + 13);
    }
    y += tableH + 20;
  }

  const footerH = 78;
  const footerY = height - padding - footerH;
  const stripeY = footerY - 10;
  const stripeColors = [palette[1] || '#FFD200', theme.ink, theme.accent, theme.ink];
  for (let i = 0, sx = padding; sx < padding + innerWidth; sx += 26, i += 1) {
    ctx.fillStyle = stripeColors[i % stripeColors.length];
    ctx.fillRect(sx, stripeY, 13, 10);
  }

  ctx.fillStyle = theme.accent;
  ctx.fillRect(padding, footerY, innerWidth, footerH);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '900 20px Archivo, Arial, sans-serif';
  ctx.fillText(theme.footerLeft || 'B2BWRAPPED.XYZ/STANFORD', padding + 28, footerY + 28);
  ctx.fillStyle = palette[1] || '#FFD200';
  ctx.font = '900 16px Archivo, Arial, sans-serif';
  const tag = theme.footerRight || 'GO CARDINAL · #B2B2026';
  const tagW = ctx.measureText(tag).width;
  ctx.fillText(tag, padding + innerWidth - tagW - 28, footerY + 30);

  return canvas;
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => resolve(blob || null), 'image/png');
      return;
    }
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const base64 = dataUrl.split(',')[1] || '';
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      resolve(new Blob([bytes], { type: 'image/png' }));
    } catch (err) {
      resolve(null);
    }
  });
}

function downloadBlobAsFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function saveImageBlob(blob, filename) {
  if (blob && typeof File === 'function' && typeof navigator.canShare === 'function' && typeof navigator.share === 'function') {
    try {
      const file = new File([blob], filename, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return 'shared';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
    }
  }
  if (blob) {
    downloadBlobAsFile(blob, filename);
    return 'downloaded';
  }
  return 'failed';
}

function detectSaveImageHintKind() {
  const ua = navigator.userAgent || '';
  const isIos = /iPhone|iPad|iPod/i.test(ua)
    || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  if (isIos) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
  return isTouch ? 'touch' : 'desktop';
}

function mobileSummaryImageHintText() {
  switch (detectSaveImageHintKind()) {
    case 'ios':     return 'Press and hold the image → Save to Photos';
    case 'android': return 'Press and hold the image → Download image';
    case 'touch':   return 'Press and hold the image to save it to your device';
    default:        return 'Right-click the image → Save Image As…';
  }
}

function getSummaryImageTheme() {
  return {
    bg: '#F4E9E1',
    card: '#FFFFFF',
    ink: '#0A0A0A',
    accent: '#8C1515',
    accentPalette: ['#8C1515', '#FFD200', '#2E2A25', '#6E0F11'],
    accentSoft: 'rgba(255, 210, 0, 0.32)',
    meta: '#555555',
    copy: '#1F1F1F',
    badgeBg: '#0A0A0A',
    badgeText: '#FFD200',
    field: '#2E2A25',
    editionLabel: '2026 CARDINAL',
    neighborsTitle: 'Cardinal neighbors',
    footerLeft: 'B2BWRAPPED.XYZ/STANFORD',
    footerRight: 'GO CARDINAL · #B2B2026',
  };
}

function releaseMobileSummaryImage() {
  state.mobileSummaryImageToken += 1;
  if (state.mobileSummaryImageUrl) {
    URL.revokeObjectURL(state.mobileSummaryImageUrl);
  }
  state.mobileSummaryImageBlob = null;
  state.mobileSummaryImageUrl = null;
  state.mobileSummaryImageFileName = '';
  const figure = $('mobileSummaryImagePreview');
  const img = $('mobileSummaryImage');
  const hint = $('mobileSummaryImageHint');
  if (img) {
    img.removeAttribute('src');
    img.removeAttribute('download');
  }
  if (hint) hint.textContent = '';
  if (figure) figure.hidden = true;
}

async function ensureMobileSummaryImage() {
  if (!state.mobileSummaryData) return null;
  if (state.mobileSummaryImageBlob) return state.mobileSummaryImageBlob;

  const figure = $('mobileSummaryImagePreview');
  const img = $('mobileSummaryImage');
  const hint = $('mobileSummaryImageHint');
  state.mobileSummaryImageToken += 1;
  const token = state.mobileSummaryImageToken;

  const canvas = renderSummaryImageCanvas(state.mobileSummaryData, getSummaryImageTheme());
  const blob = await canvasToPngBlob(canvas);

  if (token !== state.mobileSummaryImageToken || !state.mobileSummaryData || !blob) {
    return null;
  }

  if (state.mobileSummaryImageUrl) URL.revokeObjectURL(state.mobileSummaryImageUrl);
  const url = URL.createObjectURL(blob);
  const fileName = `${state.mobileSummaryFileBase || 'cardinal-summary'}-summary.png`;

  state.mobileSummaryImageBlob = blob;
  state.mobileSummaryImageUrl = url;
  state.mobileSummaryImageFileName = fileName;

  if (img) {
    img.src = url;
    img.setAttribute('download', fileName);
  }
  if (hint) hint.textContent = mobileSummaryImageHintText();
  if (figure) figure.hidden = false;

  return blob;
}

function buildMobileSummaryText(summary) {
  const lines = [
    'Bay to Breakers 2026 — Cardinal Wrapped',
    `Name: ${summary.name}`,
    `Affiliation: ${summary.affiliation || '—'}`,
    `Event: ${summary.event}`,
    `Source: ${summary.sourceLabel}`,
    `Finish: ${summary.time}  ·  Pace: ${summary.pace}`,
  ];
  if (summary.descriptor) lines.push(`Vibes: ${summary.descriptor}`);
  if (summary.rankText) lines.push(`Cardinal rank: ${summary.rankText}`);
  if (summary.cardinalPercent) lines.push(`Cardinal field: ${summary.cardinalPercent}`);
  lines.push('', 'Pacing wrapped:');
  for (const item of (summary.tiles || summary.stats || [])) {
    lines.push(`- ${item.kicker}: ${item.value}`);
    if (item.copy) lines.push(`    ${item.copy}`);
  }
  if (summary.neighbors && summary.neighbors.length) {
    lines.push('', 'Cardinal neighbors:');
    for (const n of summary.neighbors) {
      const tag = n.isYou ? '★ YOU' : '·    ';
      const name = String(n.name || '').padEnd(22).slice(0, 22);
      lines.push(`${tag} ${name} ${n.time}   ${n.deltaLabel}`);
    }
  }
  lines.push('', `Generated: ${new Date().toLocaleString()}`);
  return lines.join('\n');
}

function renderMiniHistogramSvg(h, summary, theme) {
  if (!h || !h.bins || !h.bins.length) return '';
  const W = 1080, H = 280;
  const padL = 22, padR = 22, padT = 16, padB = 44;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const baselineY = padT + innerH;
  const bins = h.bins;
  const maxC = Math.max(1, ...bins);
  const barW = innerW / bins.length;

  const fieldColor = theme.fieldBar || '#2E2A25';
  const userColor = theme.userBar || '#8C1515';
  const ink = theme.ink || '#0A0A0A';
  const stickerColor = theme.userSticker || '#FFD200';

  let bars = '';
  for (let i = 0; i < bins.length; i += 1) {
    const bh = Math.max(1.5, (bins[i] / maxC) * innerH);
    const bx = padL + i * barW;
    const by = baselineY - bh;
    const isUser = i === h.userBin;
    bars += `<rect x="${(bx + 0.6).toFixed(2)}" y="${by.toFixed(2)}" width="${(barW - 1.2).toFixed(2)}" height="${bh.toFixed(2)}" fill="${isUser ? userColor : fieldColor}"/>`;
  }

  const xForTime = (t) => padL + ((t - h.lo) / Math.max(1, h.hi - h.lo)) * innerW;
  const userX = xForTime(h.userSeconds);
  const medianX = xForTime(h.medianSeconds);

  const stickerW = 160;
  const stickerH = 56;
  let stickerX = Math.max(padL + 4, Math.min(W - padR - stickerW - 4, userX - stickerW / 2));
  const stickerY = padT - 6;

  return `
    <svg viewBox="0 0 ${W} ${H}" class="summary-poster-graph-svg" role="img"
         aria-label="Histogram of ${escapeHtml(summary.event)} finish times with your position at ${escapeHtml(summary.time)} highlighted">
      ${bars}
      <line x1="${padL - 4}" y1="${baselineY}" x2="${W - padR + 4}" y2="${baselineY}" stroke="${ink}" stroke-width="2"/>
      <line x1="${medianX}" y1="${padT - 4}" x2="${medianX}" y2="${baselineY}" stroke="${ink}" stroke-width="1.6" stroke-dasharray="6 6" opacity="0.7"/>
      <line x1="${userX}" y1="${padT}" x2="${userX}" y2="${baselineY}" stroke="${userColor}" stroke-width="3"/>
      <g transform="translate(${stickerX}, ${stickerY})">
        <rect x="4" y="4" width="${stickerW}" height="${stickerH}" fill="${ink}"/>
        <rect x="0" y="0" width="${stickerW}" height="${stickerH}" fill="${stickerColor}" stroke="${ink}" stroke-width="2"/>
        <text x="14" y="22" font-size="12" font-weight="900" letter-spacing="0.18em" fill="${ink}">YOU</text>
        <text x="14" y="46" font-size="22" font-weight="900" font-variant-numeric="tabular-nums" fill="${ink}">${escapeHtml(summary.time)}</text>
      </g>
      <text x="${padL}" y="${baselineY + 22}" font-size="13" font-weight="800" font-variant-numeric="tabular-nums" fill="${ink}">${escapeHtml(formatTime(h.lo))}</text>
      <text x="${W - padR}" y="${baselineY + 22}" text-anchor="end" font-size="13" font-weight="800" font-variant-numeric="tabular-nums" fill="${ink}">${escapeHtml(formatTime(h.hi))}</text>
      <text x="${padL}" y="${baselineY + 38}" font-size="10" font-weight="700" letter-spacing="0.18em" fill="#6B6B6B">FRONT OF PACK</text>
      <text x="${W - padR}" y="${baselineY + 38}" text-anchor="end" font-size="10" font-weight="700" letter-spacing="0.18em" fill="#6B6B6B">BACK OF PACK</text>
    </svg>
  `;
}

function renderMobileSummaryWrapped(summary) {
  const section = $('mobileSummaryWrapped');
  const card = $('mobileSummaryCard');
  if (!section || !card) return;

  if (!summary) {
    section.hidden = true;
    card.innerHTML = '';
    card.className = 'mobile-summary-card';
    state.mobileSummaryText = '';
    state.mobileSummaryFileBase = 'cardinal-summary';
    state.mobileSummaryData = null;
    releaseMobileSummaryImage();
    setMobileSummaryStatus('');
    return;
  }

  const tiles = (summary.tiles || []).slice(0, 6);
  const tilesHtml = tiles.map((item) => `
    <li class="summary-poster-tile">
      <p class="summary-poster-tile-kicker">${escapeHtml(item.kicker)}</p>
      <p class="summary-poster-tile-value">${escapeHtml(item.value)}</p>
      <p class="summary-poster-tile-copy">${escapeHtml(item.copy || '')}</p>
    </li>
  `).join('');

  const neighbors = (summary.neighbors || []).slice(0, 7);
  const neighborsHtml = neighbors.map((n) => `
    <li class="summary-poster-neighbor${n.isYou ? ' you' : ''}">
      <span class="summary-poster-neighbor-marker">${n.isYou ? '★' : '·'}</span>
      <span class="summary-poster-neighbor-name">${escapeHtml(n.name)}${n.affiliation ? `<small>${escapeHtml(n.affiliation)}</small>` : ''}</span>
      <span class="summary-poster-neighbor-time">${escapeHtml(n.time)}</span>
      <span class="summary-poster-neighbor-delta${n.delta === 0 ? ' zero' : ''}">${escapeHtml(n.deltaLabel)}</span>
    </li>
  `).join('');

  const badges = (summary.badges || []).slice(0, 3);
  const badgesHtml = badges.map((label) => `<li>${escapeHtml(label)}</li>`).join('');

  const histogramSvg = renderMiniHistogramSvg(summary.histogram, summary, {
    ink: '#0A0A0A',
    fieldBar: '#2E2A25',
    userBar: '#8C1515',
    userSticker: '#FFD200',
  });

  card.className = 'summary-poster';
  card.innerHTML = `
    <header class="summary-poster-head">
      <span class="summary-poster-mark">B<span>·</span>2<span>·</span>B</span>
      <span class="summary-poster-edition">2026 Cardinal</span>
      <span class="summary-poster-event">${escapeHtml(summary.event)} · Stanford</span>
    </header>

    <section class="summary-poster-hero">
      <p class="summary-poster-kicker">Cardinal scorecard</p>
      <h3 class="summary-poster-name">${escapeHtml(summary.name)}</h3>
      <p class="summary-poster-meta">${escapeHtml(summary.event)} · ${summary.affiliation ? escapeHtml(summary.affiliation) + ' · ' : ''}${escapeHtml(summary.sourceLabel)}</p>
      <div class="summary-poster-time">
        <p class="summary-poster-time-value">${escapeHtml(summary.time)}</p>
        <div class="summary-poster-time-meta">
          <p class="summary-poster-pace">${escapeHtml(summary.pace)}</p>
          <p class="summary-poster-descriptor">${escapeHtml(summary.descriptor || '')}</p>
        </div>
      </div>
      ${badgesHtml ? `<ul class="summary-poster-badges">${badgesHtml}</ul>` : ''}
    </section>

    ${tilesHtml ? `
      <section class="summary-poster-block">
        <h4 class="summary-poster-block-title">Pacing wrapped</h4>
        <ol class="summary-poster-tiles">${tilesHtml}</ol>
      </section>
    ` : ''}

    ${histogramSvg ? `
      <section class="summary-poster-block">
        <h4 class="summary-poster-block-title">You vs the field</h4>
        <div class="summary-poster-graph">
          ${histogramSvg}
          <p class="summary-poster-graph-legend">
            <span><span class="swatch swatch--you"></span><strong>YOU</strong> ${escapeHtml(summary.time)}</span>
            <span><span class="swatch swatch--field"></span>Field histogram</span>
            ${summary.histogram ? `<span><strong>${summary.histogram.beatPct.toFixed(1)}%</strong> ahead of <strong>${summary.histogram.slower.toLocaleString()}</strong> / ${summary.histogram.count.toLocaleString()}</span>` : ''}
          </p>
        </div>
      </section>
    ` : ''}

    ${neighborsHtml ? `
      <section class="summary-poster-block">
        <h4 class="summary-poster-block-title">Cardinal neighbors</h4>
        <ol class="summary-poster-neighbors">${neighborsHtml}</ol>
      </section>
    ` : ''}

    <footer class="summary-poster-foot">
      <span>b2bwrapped.xyz/stanford</span>
      <span>Go Cardinal · #B2B2026</span>
    </footer>
  `;

  state.mobileSummaryText = buildMobileSummaryText(summary);
  state.mobileSummaryFileBase = slugify(`${summary.name}-${summary.event}-cardinal`) || 'cardinal-summary';
  state.mobileSummaryData = summary;
  setMobileSummaryStatus('Ready to copy, download text, or save image.');
  section.hidden = false;

  releaseMobileSummaryImage();
  requestAnimationFrame(() => {
    ensureMobileSummaryImage().catch((err) => {
      console.error('Could not pre-render summary image', err);
    });
  });
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

async function downloadMobileSummaryImage() {
  if (!state.mobileSummaryData) {
    setMobileSummaryStatus('Generate your scorecard first, then save an image.');
    return;
  }
  try {
    if (!state.mobileSummaryImageBlob) {
      setMobileSummaryStatus('Preparing image…');
      await ensureMobileSummaryImage();
    }
    const blob = state.mobileSummaryImageBlob;
    const fileName = state.mobileSummaryImageFileName
      || `${state.mobileSummaryFileBase || 'cardinal-summary'}-summary.png`;
    if (!blob) throw new Error('image not ready');
    const result = await saveImageBlob(blob, fileName);
    if (result === 'shared') {
      setMobileSummaryStatus('Pick “Save Image” in the share sheet — or press and hold the preview above to save to Photos.');
    } else if (result === 'cancelled') {
      setMobileSummaryStatus('Image save cancelled. Press and hold the preview above to save it directly.');
    } else if (result === 'downloaded') {
      setMobileSummaryStatus(`Downloaded ${fileName}. On mobile, press and hold the preview above to save to Photos instead.`);
    } else {
      setMobileSummaryStatus('Could not save image — press and hold the preview above to save it directly.');
    }
  } catch (err) {
    console.error(err);
    setMobileSummaryStatus(`Could not save image: ${err.message}`);
  }
}

function signedDeltaLabel(deltaSeconds) {
  if (deltaSeconds === 0) return 'tied';
  const abs = formatTime(Math.abs(deltaSeconds));
  return deltaSeconds < 0 ? `-${abs}` : `+${abs}`;
}

function buildCardinalNeighbors(inEvent, you) {
  if (!inEvent.length) return [];
  const youIdx = inEvent.findIndex((e) => e.isYou);
  if (youIdx === -1) return [];
  const start = Math.max(0, youIdx - 2);
  const end = Math.min(inEvent.length, start + 5);
  return inEvent.slice(start, end).map((e) => {
    const delta = e.chip_seconds - you.chip_seconds;
    return {
      name: e.name || 'Anonymous',
      affiliation: e.affiliation || '',
      time: formatTime(e.chip_seconds),
      chip_seconds: e.chip_seconds,
      delta,
      deltaLabel: e.isYou ? 'YOU' : signedDeltaLabel(delta),
      isYou: !!e.isYou,
    };
  });
}

function buildPosterHistogram(group, seconds) {
  if (!group || !group.times || !group.times.length) return null;
  const times = group.times;
  const n = times.length;
  let lo = times[Math.max(0, Math.floor(n * 0.005))];
  let hi = times[Math.min(n - 1, Math.floor(n * 0.995))];
  if (seconds < lo) lo = Math.max(0, seconds - 60);
  if (seconds > hi) hi = seconds + 60;
  const span = Math.max(1, hi - lo);
  const binCount = 36;
  const counts = new Array(binCount).fill(0);
  for (let i = 0; i < n; i += 1) {
    const t = times[i];
    if (t < lo || t > hi) continue;
    const idx = Math.min(binCount - 1, Math.floor(((t - lo) / span) * binCount));
    counts[idx] += 1;
  }
  const userBin = Math.min(binCount - 1, Math.max(0, Math.floor(((seconds - lo) / span) * binCount)));
  const upper = upperBound(times, seconds);
  const slower = times.length - upper;
  const beatPct = (slower / times.length) * 100;
  const rank = lowerBound(times, seconds) + 1;
  return {
    bins: counts,
    lo,
    hi,
    userBin,
    userSeconds: seconds,
    medianSeconds: group.p50_seconds,
    medianText: group.p50,
    beatPct,
    slower,
    count: times.length,
    rank,
  };
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

  // -------- poster data -----------------------------------------------
  const tiles = [];
  tiles.push({
    kicker: 'Cardinal rank',
    value: total > 1 ? ordinal(myRank) : '1st',
    copy: total > 1
      ? `Of ${total} Cardinal ${event} entries — beat ${beatN}.`
      : 'Sole Cardinal entry so far.',
  });
  if (fs) {
    tiles.push({
      kicker: 'Top of field',
      value: `${(100 - fs.beatPct).toFixed(1)}%`,
      copy: `Beat ${fs.slower.toLocaleString()} of ${fs.count.toLocaleString()} ${event} finishers.`,
    });
    const fdelta = you.chip_seconds - fs.median;
    tiles.push({
      kicker: 'Vs field median',
      value: fdelta === 0 ? '±0' : (fdelta < 0 ? `-${formatTime(-fdelta)}` : `+${formatTime(fdelta)}`),
      copy: `Median ${event}: ${fs.medianText}.`,
    });
  } else {
    tiles.push({
      kicker: 'Cardinal %',
      value: `${beatPct.toFixed(0)}%`,
      copy: total > 1 ? `Ahead of ${beatPct.toFixed(0)}% of Cardinal ${event} folks.` : 'Solo for now.',
    });
  }
  tiles.push({
    kicker: 'Pace',
    value: formatPace(you.chip_seconds, you.distance_miles),
    copy: `Across ${you.distance_miles} mi.`,
  });
  if (inEvent.length > 1) {
    const median = inEvent[Math.floor(inEvent.length / 2)];
    const cdelta = you.chip_seconds - median.chip_seconds;
    tiles.push({
      kicker: 'Vs Cardinal median',
      value: cdelta === 0 ? '±0' : (cdelta < 0 ? `-${formatTime(-cdelta)}` : `+${formatTime(cdelta)}`),
      copy: `Cardinal median ${event}: ${formatTime(median.chip_seconds)}.`,
    });
  }
  if (tiles.length < 6) {
    tiles.push({
      kicker: 'Distance',
      value: `${you.distance_miles} mi`,
      copy: event === '12K' ? '12 kilometers across SF.' : 'Bonus 15K route.',
    });
  }

  const badges = [
    total > 1 ? `Cardinal #${myRank} / ${total}` : `Cardinal #1 / 1`,
    fs ? `Top ${(100 - fs.beatPct).toFixed(1)}% of field` : `Top ${(100 - beatPct).toFixed(0)}% of Cardinals`,
    formatPace(you.chip_seconds, you.distance_miles),
  ];

  const histogram = fs ? buildPosterHistogram(state.summary.groups[`event=${event}`], you.chip_seconds) : null;
  const neighbors = buildCardinalNeighbors(inEvent, you);

  renderMobileSummaryWrapped({
    name: you.name || 'Anonymous',
    affiliation: you.affiliation || '',
    event,
    sourceLabel,
    time: formatTime(you.chip_seconds),
    pace: formatPace(you.chip_seconds, you.distance_miles),
    descriptor: descriptor(beatPct),
    rankText,
    cardinalPercent: `${beatPct.toFixed(0)}% ahead of Cardinals`,
    stats: summaryStats,
    tiles,
    badges,
    histogram,
    neighbors,
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
