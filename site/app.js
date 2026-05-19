const state = {
  summary: null,
  results: null,
  loaded: false,
  mobileSummaryText: '',
  mobileSummaryFileBase: 'b2b-summary',
  mobileSummaryData: null,
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
  const badgeLabel = 'B2B 2026 WRAPPED';
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
  for (const line of wrapTextLines(ctx, summary.runnerLabel, innerWidth)) {
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
  for (const line of wrapTextLines(ctx, `${summary.overallRank} • ${summary.overallPercentile}`, innerWidth)) {
    ctx.fillText(line, padding, y);
    y += 42;
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
    'Bay to Breakers 2026 - Summary Wrapped',
    `Runner: ${summary.runnerLabel}`,
    `Event: ${summary.event}`,
    `Source: ${summary.sourceLabel}`,
    `Finish time: ${summary.time}`,
    `Pace: ${summary.pace}`,
    `Overall rank estimate: ${summary.overallRank}`,
    `Overall field percentile: ${summary.overallPercentile}`,
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
    state.mobileSummaryFileBase = 'b2b-summary';
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
      <p class="mobile-summary-title">${escapeHtml(summary.runnerLabel)}</p>
      <p class="mobile-summary-subtitle">${escapeHtml(summary.event)} · ${escapeHtml(summary.sourceLabel)}</p>
      <p class="mobile-summary-time">${escapeHtml(summary.time)} · ${escapeHtml(summary.pace)}</p>
      <p class="mobile-summary-rank">${escapeHtml(summary.overallRank)} · ${escapeHtml(summary.overallPercentile)}</p>
    </header>
    <ol class="mobile-summary-list">${rows}</ol>
  `;

  state.mobileSummaryText = buildMobileSummaryText(summary);
  state.mobileSummaryFileBase = slugify(`${summary.runnerLabel}-${summary.event}-wrapped`) || 'b2b-summary';
  state.mobileSummaryData = summary;
  setMobileSummaryStatus('Ready to copy, download text, or download image.');
  section.hidden = false;
}

async function copyMobileSummary() {
  if (!state.mobileSummaryText) {
    setMobileSummaryStatus('Generate your wrapped first, then copy.');
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
    setMobileSummaryStatus('Generate your wrapped first, then download.');
    return;
  }
  const blob = new Blob([state.mobileSummaryText], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${state.mobileSummaryFileBase || 'b2b-summary'}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  setMobileSummaryStatus(`Downloaded ${link.download}.`);
}

function downloadMobileSummaryImage() {
  if (!state.mobileSummaryData) {
    setMobileSummaryStatus('Generate your wrapped first, then download an image.');
    return;
  }
  try {
    const canvas = renderSummaryImageCanvas(state.mobileSummaryData, {
      bg: '#F4FBFF',
      card: '#FFFFFF',
      ink: '#0A0A0A',
      accent: '#FF388F',
      accentPalette: ['#FF388F', '#FF6A1A', '#2EA8BD', '#FFD61F'],
      meta: '#555555',
      copy: '#1F1F1F',
      badgeBg: '#0A0A0A',
      badgeText: '#FFD61F',
    });
    const fileName = `${state.mobileSummaryFileBase || 'b2b-summary'}-summary.png`;
    triggerCanvasDownload(canvas, fileName);
    setMobileSummaryStatus(`Downloaded ${fileName}.`);
  } catch (err) {
    console.error(err);
    setMobileSummaryStatus(`Could not generate image: ${err.message}`);
  }
}

function normalizedFirstName(value) {
  const name = String(value || '').trim();
  if (!name) return '';
  return name.split(/\s+/)[0].replace(/[^a-z'-]/gi, '').toLowerCase();
}

function displayFirstName(value) {
  const name = String(value || '').trim();
  if (!name) return '';
  const first = name.split(/\s+/)[0].replace(/[^a-z'-]/gi, '');
  return first ? first[0].toUpperCase() + first.slice(1).toLowerCase() : '';
}

function runnerForBib(event, bib) {
  if (!Number.isFinite(bib)) return null;
  return state.results.rows.find((r) => r.event === event && Number(r.bib) === bib)
    || state.results.rows.find((r) => Number(r.bib) === bib)
    || null;
}

function sameFirstNameStats(event, firstName, seconds) {
  const normalized = normalizedFirstName(firstName);
  if (!normalized || !Number.isFinite(seconds)) return null;

  const rows = state.results.rows
    .filter((r) => (
      r.event === event
      && Number.isFinite(r.chip_seconds)
      && normalizedFirstName(r.name) === normalized
    ))
    .sort((a, b) => a.chip_seconds - b.chip_seconds);

  if (!rows.length) return null;

  const times = rows.map((r) => r.chip_seconds);
  const faster = lowerBound(times, seconds);
  const equalOrFaster = upperBound(times, seconds);
  const slower = times.length - equalOrFaster;
  return {
    count: rows.length,
    rank: faster + 1,
    slower,
    beatPct: (slower / rows.length) * 100,
    firstName: displayFirstName(firstName),
  };
}

function svgRunner(bibText) {
  const text = String(bibText || 'YOU').toUpperCase();
  const fs = text.length >= 5 ? 6.5 : text.length === 4 ? 8 : 9.5;
  return `
    <g class="runner-figure">
      <line x1="-14" y1="22" x2="-4" y2="22" stroke="#0A0A0A" stroke-width="2" opacity="0.35" stroke-linecap="round"/>
      <line x1="-10" y1="30" x2="-2" y2="30" stroke="#0A0A0A" stroke-width="2" opacity="0.35" stroke-linecap="round"/>
      <circle cx="20" cy="7" r="5.6" fill="#0A0A0A"/>
      <path d="M 11 18 L 0 13 L -3 22"
            stroke="#0A0A0A" stroke-width="2.8" fill="none"
            stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="8" y="14" width="24" height="22" fill="#FF388F" stroke="#0A0A0A" stroke-width="1.4"/>
      <text x="20" y="28" text-anchor="middle"
            font-size="${fs}" font-weight="900" letter-spacing="0.04em" fill="#FFFFFF">${escapeHtml(text)}</text>
      <path d="M 31 18 L 42 13 L 45 22"
            stroke="#0A0A0A" stroke-width="2.8" fill="none"
            stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M 13 36 L 5 46 L 0 53"
            stroke="#0A0A0A" stroke-width="3.4" fill="none"
            stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M 27 36 L 36 48 L 38 56"
            stroke="#0A0A0A" stroke-width="3.4" fill="none"
            stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  `;
}

function renderFieldGraphic(event, seconds, stats, bibText) {
  const root = $('fieldGraphic');
  const cap = $('fieldGraphicCaption');
  if (!root || !stats) return;

  const times = stats.group.times;
  const n = times.length;
  if (!n) { root.innerHTML = ''; if (cap) cap.innerHTML = ''; return; }

  let lo = times[Math.max(0, Math.floor(n * 0.005))];
  let hi = times[Math.min(n - 1, Math.floor(n * 0.995))];
  if (seconds < lo) lo = Math.max(0, seconds - 60);
  if (seconds > hi) hi = seconds + 60;
  const span = Math.max(1, hi - lo);

  const bins = 56;
  const counts = new Array(bins).fill(0);
  for (let i = 0; i < n; i++) {
    const t = times[i];
    if (t < lo || t > hi) continue;
    const idx = Math.min(bins - 1, Math.floor(((t - lo) / span) * bins));
    counts[idx]++;
  }
  const maxC = Math.max(1, ...counts);

  const W = 1080, H = 468;
  const padL = 56, padR = 56;
  const padT = 188, padB = 92;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const baselineY = padT + innerH;

  const xForTime = (t) => padL + ((t - lo) / span) * innerW;
  const userBin = Math.min(bins - 1, Math.max(0, Math.floor(((seconds - lo) / span) * bins)));
  const userX = xForTime(seconds);
  const medianSeconds = stats.group.p50_seconds;
  const medianX = xForTime(medianSeconds);

  const barW = innerW / bins;
  let bars = '';
  for (let i = 0; i < bins; i++) {
    const h = Math.max(1.5, (counts[i] / maxC) * innerH);
    const x = padL + i * barW;
    const y = baselineY - h;
    const isUser = i === userBin;
    bars += `<rect class="bar${isUser ? ' user' : ''}" x="${(x + 0.6).toFixed(2)}" y="${y.toFixed(2)}" width="${(barW - 1.2).toFixed(2)}" height="${h.toFixed(2)}" fill="${isUser ? '#FF388F' : '#2EA8BD'}"/>`;
  }

  const stickerW = 232, stickerH = 96;
  const stickerX = Math.max(padL - 12, Math.min(W - padR + 12 - stickerW, userX - stickerW / 2));
  const stickerY = 12;

  const runnerW = 46, runnerH = 56;
  const runnerX = userX - 20;
  const runnerY = padT - runnerH;

  const medianTooClose = Math.abs(medianX - userX) < 170;
  const medianLabelY = medianTooClose ? baselineY + 22 : padT - 14;
  const medianLabelBoxW = 120, medianLabelBoxH = 24;
  let medianBoxX = medianX - medianLabelBoxW / 2;
  medianBoxX = Math.max(padL, Math.min(W - padR - medianLabelBoxW, medianBoxX));
  const medianTextX = medianBoxX + medianLabelBoxW / 2;

  const beatPct = stats.beatPct;
  const beatPctText = beatPct.toFixed(1);
  const slower = stats.slower;
  const count = stats.count;
  const rank = stats.rank;

  if (cap) {
    cap.innerHTML = `
      <span class="pct">${beatPctText}<span style="opacity:.85">%</span></span>
      <span>Ahead of <strong>${slower.toLocaleString()}</strong> of <strong>${count.toLocaleString()}</strong> ${escapeHtml(event)} finishers — estimated place <strong>${rank.toLocaleString()}</strong>.</span>
    `;
  }

  root.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="field-graphic-svg" role="img"
         aria-label="Histogram of ${escapeHtml(event)} finish times with your position at ${formatTime(seconds)} highlighted">
      <defs>
        <pattern id="fg-grid" width="40" height="22" patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0" fill="none" stroke="rgba(10,10,10,0.06)" stroke-width="1"/>
        </pattern>
      </defs>

      <rect x="${padL}" y="${padT - 6}" width="${innerW}" height="${innerH + 6}" fill="url(#fg-grid)"/>

      ${bars}

      <line x1="${padL - 4}" y1="${baselineY}" x2="${W - padR + 4}" y2="${baselineY}" stroke="#0A0A0A" stroke-width="2"/>
      <line x1="${padL}" y1="${baselineY}" x2="${padL}" y2="${baselineY + 8}" stroke="#0A0A0A" stroke-width="2"/>
      <line x1="${W - padR}" y1="${baselineY}" x2="${W - padR}" y2="${baselineY + 8}" stroke="#0A0A0A" stroke-width="2"/>

      <g class="median-marker">
        <line x1="${medianX}" y1="${padT - 4}" x2="${medianX}" y2="${baselineY}"
              stroke="#0A0A0A" stroke-width="1.4" stroke-dasharray="5 5" opacity="0.65"/>
        <rect x="${medianBoxX}" y="${medianLabelY - 16}" width="${medianLabelBoxW}" height="${medianLabelBoxH}"
              fill="#FFFFFF" stroke="#0A0A0A" stroke-width="1.2"/>
        <text x="${medianTextX - 38}" y="${medianLabelY}" text-anchor="middle"
              font-size="10" font-weight="800" letter-spacing="0.2em" fill="#0A0A0A">MEDIAN</text>
        <text x="${medianTextX + 22}" y="${medianLabelY}" text-anchor="middle"
              font-size="11" font-weight="800" font-variant-numeric="tabular-nums" fill="#0A0A0A">${escapeHtml(stats.group.p50 || formatTime(medianSeconds))}</text>
      </g>

      <line x1="${userX}" y1="${padT}" x2="${userX}" y2="${baselineY}" stroke="#E61F73" stroke-width="3"/>

      <g transform="translate(${runnerX}, ${runnerY})">
        ${svgRunner(bibText)}
      </g>

      <g transform="translate(${stickerX}, ${stickerY})">
        <rect x="3" y="3" width="${stickerW}" height="${stickerH}" fill="#0A0A0A"/>
        <rect x="0" y="0" width="${stickerW}" height="${stickerH}" fill="#FFD61F" stroke="#0A0A0A" stroke-width="1.6"/>
        <line x1="14" y1="30" x2="${stickerW - 14}" y2="30" stroke="#0A0A0A" stroke-width="1"/>
        <text x="16" y="22" font-size="11" font-weight="800" letter-spacing="0.22em" fill="#0A0A0A">YOUR FINISH</text>
        <text x="16" y="62" font-size="28" font-weight="900" letter-spacing="-0.02em" font-variant-numeric="tabular-nums" fill="#0A0A0A">${formatTime(seconds)}</text>
        <text x="16" y="84" font-size="10.5" font-weight="800" letter-spacing="0.14em" fill="#E61F73">TOP ${(100 - beatPct).toFixed(1)}% · #${rank.toLocaleString()}</text>
      </g>

      <text x="${padL}" y="${baselineY + 24}" font-size="12" font-weight="800" letter-spacing="0.18em" font-variant-numeric="tabular-nums" fill="#0A0A0A">${formatTime(lo)}</text>
      <text x="${padL}" y="${baselineY + 42}" font-size="10" font-weight="700" letter-spacing="0.2em" fill="#6B6B6B">FRONT OF PACK</text>
      <text x="${W - padR}" y="${baselineY + 24}" text-anchor="end" font-size="12" font-weight="800" letter-spacing="0.18em" font-variant-numeric="tabular-nums" fill="#0A0A0A">${formatTime(hi)}</text>
      <text x="${W - padR}" y="${baselineY + 42}" text-anchor="end" font-size="10" font-weight="700" letter-spacing="0.2em" fill="#6B6B6B">BACK OF PACK</text>
    </svg>
  `;
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
  const bib = Number($('bib').value);
  const runner = runnerForBib(event, bib);
  const firstName = $('firstName').value.trim() || (runner ? displayFirstName(runner.name) : '');

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

  // Replay the medal earning animation on every submit.
  const medalEl = $('scorecardMedal');
  if (medalEl) {
    medalEl.classList.remove('animate');
    // Force reflow so the keyframes restart even on repeat clicks.
    void medalEl.offsetWidth;
    medalEl.classList.add('animate');
  }

  const cards = $('cards');
  cards.innerHTML = '';
  const summaryStats = [];
  const appendStat = (kicker, value, copy) => {
    cards.appendChild(card(kicker, value, copy));
    summaryStats.push({ kicker, value, copy });
  };

  appendStat(
    'Overall field',
    `${overall.beatPct.toFixed(1)}%`,
    `You beat about ${overall.slower.toLocaleString()} of ${overall.count.toLocaleString()} ${event} finishers. Estimated place: ${overall.rank.toLocaleString()}.`
  );

  if (genderStats) {
    appendStat(
      'Gender field',
      `${genderStats.beatPct.toFixed(1)}%`,
      `Among ${gender} runners, you beat about ${genderStats.slower.toLocaleString()} of ${genderStats.count.toLocaleString()}.`
    );
  }

  if (ageStats) {
    appendStat(
      'Age group',
      `${ageStats.beatPct.toFixed(1)}%`,
      `In ${ag}, you beat about ${ageStats.slower.toLocaleString()} of ${ageStats.count.toLocaleString()} runners.`
    );
  }

  if (comboStats) {
    appendStat(
      'Gender + age',
      `${comboStats.beatPct.toFixed(1)}%`,
      `In ${gender} ${ag}, estimated rank ${comboStats.rank.toLocaleString()} of ${comboStats.count.toLocaleString()}.`
    );
  }

  const median = overall.group.p50_seconds;
  appendStat(
    'Vs median',
    signedDelta(seconds - median),
    `Median ${event} finish was ${overall.group.p50}. Your pace: ${formatPace(seconds, eventMiles)}.`
  );

  appendStat(
    'Finish pace',
    formatPace(seconds, eventMiles),
    `Official distance used here: ${eventMiles} miles. GPS routes can read longer or shorter.`
  );

  const nameStats = sameFirstNameStats(event, firstName, seconds);
  if (nameStats) {
    const sameNameCopy = nameStats.count === 1
      ? `You were the only ${nameStats.firstName} in the public ${event} results.`
      : `Among ${nameStats.count.toLocaleString()} ${nameStats.firstName}s in the ${event}, you beat about ${nameStats.slower.toLocaleString()} and landed in the top ${(100 - nameStats.beatPct).toFixed(1)}%.`;
    appendStat(
      'Name twins',
      nameStats.count === 1 ? `Only ${nameStats.firstName}` : `#${nameStats.rank.toLocaleString()} of ${nameStats.count.toLocaleString()}`,
      sameNameCopy
    );
  }

  if (runner && runner.teams && runner.teams.length) {
    const team = runner.teams[0];
    appendStat(
      'Centipede team',
      team.team_name || 'Team result',
      team.team_rank ? `Team rank ${team.team_rank}; team average ${team.team_avg_chip_time || '—'}.` : `Team average ${team.team_avg_chip_time || '—'}.`
    );
  }

  const bibRaw = $('bib').value.trim();
  const bibForGraphic = bibRaw && /^\d+$/.test(bibRaw) ? `#${bibRaw}` : 'YOU';
  const runnerLabel = runner?.name || firstName || (bibRaw ? `Bib ${bibRaw}` : 'Runner');
  renderMobileSummaryWrapped({
    runnerLabel,
    event,
    sourceLabel,
    time: formatTime(seconds),
    pace: formatPace(seconds, eventMiles),
    overallRank: `${overall.rank.toLocaleString()} of ${overall.count.toLocaleString()}`,
    overallPercentile: `${overall.beatPct.toFixed(1)}% ahead of field`,
    stats: summaryStats,
  });

  renderFieldGraphic(event, seconds, overall, bibForGraphic);
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
  let row = runnerForBib(event, bib);
  if (!row) {
    alert('No public result found for that bib in the loaded data.');
    return;
  }
  $('event').value = row.event;
  $('time').value = row.chip_time || formatTime(row.chip_seconds);
  $('gender').value = row.gender || '';
  $('age').value = row.age || '';
  $('firstName').value = displayFirstName(row.name);
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
    $('dataStatus').innerHTML = `Data not found yet. From the repo root, run <code>./data_pipeline/refresh_site_data.sh</code> to create <code>site/data/*.json</code>.`;
  }
}

$('compare').addEventListener('click', compare);
$('lookup').addEventListener('click', lookupBib);
$('copyMobileSummary').addEventListener('click', () => {
  copyMobileSummary().catch((err) => {
    console.error(err);
    setMobileSummaryStatus(`Could not copy summary: ${err.message}`);
  });
});
$('downloadMobileSummary').addEventListener('click', downloadMobileSummary);
$('downloadMobileSummaryImage').addEventListener('click', downloadMobileSummaryImage);
loadData();
