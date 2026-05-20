const state = {
  summary: null,
  results: null,
  loaded: false,
  mobileSummaryText: '',
  mobileSummaryFileBase: 'b2b-summary',
  mobileSummaryData: null,
  mobileSummaryImageBlob: null,
  mobileSummaryImageUrl: null,
  mobileSummaryImageFileName: '',
  mobileSummaryImageToken: 0,
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

function drawDropShadowBox(ctx, x, y, w, h, fill, shadow, shadowOffset = 8) {
  ctx.fillStyle = shadow;
  ctx.fillRect(x + shadowOffset, y + shadowOffset, w, h);
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  strokeRectOutline(ctx, x, y, w, h, '#0A0A0A', 3);
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

function drawDottedDivider(ctx, x1, y, x2, color = '#0A0A0A', dash = [10, 8]) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}

function drawConfettiDots(ctx, x, y, w, h, colors, density = 0.0006, seed = 1) {
  const count = Math.max(8, Math.floor(w * h * density));
  let s = seed;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = 0; i < count; i += 1) {
    const cx = x + rand() * w;
    const cy = y + rand() * h;
    const r = 2 + rand() * 4;
    ctx.fillStyle = colors[Math.floor(rand() * colors.length)];
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPercentileRing(ctx, cx, cy, radius, ringWidth, percent, opts) {
  const o = opts || {};
  const trackColor = o.trackColor || '#E6E6E6';
  const fillColor = o.fillColor || '#FF388F';
  const ink = o.ink || '#0A0A0A';
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineWidth = ringWidth;
  ctx.strokeStyle = trackColor;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + Math.max(0.0001, Math.min(1, percent / 100)) * Math.PI * 2;
  ctx.strokeStyle = fillColor;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, startAngle, endAngle);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = ink;
  ctx.beginPath();
  ctx.arc(cx, cy, radius + ringWidth / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, radius - ringWidth / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawCurvedText(ctx, text, cx, cy, radius, startAngle, opts) {
  const o = opts || {};
  ctx.save();
  ctx.font = o.font || '900 16px Archivo, Arial, sans-serif';
  ctx.fillStyle = o.color || '#0A0A0A';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const direction = o.direction || 1; // 1 = clockwise (top arc), -1 = ccw (bottom arc)
  const chars = String(text).split('');
  const widths = chars.map((c) => ctx.measureText(c).width);
  let totalAngle = 0;
  for (const w of widths) totalAngle += (w + 2) / radius;
  let angle = startAngle - (direction * totalAngle) / 2;
  for (let i = 0; i < chars.length; i += 1) {
    const charAngle = (widths[i] + 2) / radius;
    angle += (direction * charAngle) / 2;
    ctx.save();
    ctx.translate(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
    ctx.rotate(angle + (direction > 0 ? Math.PI / 2 : -Math.PI / 2));
    ctx.fillText(chars[i], 0, 0);
    ctx.restore();
    angle += (direction * charAngle) / 2;
  }
  ctx.restore();
}

function drawStarburst(ctx, cx, cy, rOuter, rInner, points, color, ink) {
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = (-Math.PI / 2) + (i * Math.PI) / points;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  if (ink) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ink;
    ctx.stroke();
  }
  ctx.restore();
}

function renderSummaryImageCanvas(summary, theme) {
  const width = 1080;
  const height = 1680;
  const padding = 48;
  const innerWidth = width - (padding * 2);
  const palette = theme.accentPalette || [theme.accent, theme.accent, theme.accent, theme.accent];
  const heroPadX = 40;
  const eventDate = theme.eventDate || '5/17/26';
  const editionLabel = theme.editionLabel || '2026 WRAPPED';
  const mark = theme.mark || 'B·2·B';
  const eventCity = theme.eventCity || 'SAN FRANCISCO';

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable in this browser.');

  // background paper with diagonal hatching for character
  drawDiagonalPaper(ctx, 0, 0, width, height, theme.bg, theme.accent);

  // outer frame (paper card)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(padding, padding, innerWidth, height - padding * 2);
  strokeRectOutline(ctx, padding, padding, innerWidth, height - padding * 2, theme.ink, 4);

  ctx.textBaseline = 'top';

  // -------- header ticket bar -----------------------------------------
  const headerH = 84;
  ctx.fillStyle = theme.ink;
  ctx.fillRect(padding, padding, innerWidth, headerH);

  ctx.fillStyle = theme.badgeText;
  ctx.font = '900 28px Archivo, Arial, sans-serif';
  ctx.fillText(mark, padding + 26, padding + 26);

  ctx.font = '800 16px Archivo, Arial, sans-serif';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(editionLabel, padding + 156, padding + 32);

  ctx.fillStyle = theme.accent;
  ctx.font = '800 16px Archivo, Arial, sans-serif';
  const eventLine = `${summary.event.toUpperCase()} · ${eventCity} · ${eventDate}`;
  const eventWidth = ctx.measureText(eventLine).width;
  ctx.fillText(eventLine, padding + innerWidth - eventWidth - 26, padding + 32);

  let y = padding + headerH;

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

  // ====== HERO BLOCK ===================================================
  const heroBlockH = 528;
  const heroTop = y;
  ctx.fillStyle = theme.card;
  ctx.fillRect(padding, y, innerWidth, heroBlockH);
  ctx.save();
  const grad = ctx.createRadialGradient(
    padding + innerWidth, y, 20,
    padding + innerWidth, y, 420,
  );
  grad.addColorStop(0, theme.accentSoft || 'rgba(255, 214, 31, 0.35)');
  grad.addColorStop(1, 'rgba(255, 214, 31, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(padding, y, innerWidth, heroBlockH);
  ctx.restore();
  // a few decorative dots in the hero corner
  drawConfettiDots(ctx, padding + innerWidth - 260, y + 8, 260, 90,
    [palette[0], palette[1] || '#FFD61F', palette[2] || theme.field || '#2EA8BD'], 0.0008, 7);

  // kicker sticker
  ctx.font = '900 16px Archivo, Arial, sans-serif';
  const kickerLabel = 'WRAPPED SCORECARD';
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

  // tiny star burst next to kicker
  drawStarburst(ctx, kickerX + kickerW + 26, kickerY + kickerH / 2, 12, 5, 6, palette[0], theme.ink);

  let nameY = kickerY + kickerH + 18;
  ctx.fillStyle = theme.ink;
  ctx.font = '900 64px Archivo, Arial, sans-serif';
  const nameLines = wrapTextLines(ctx, summary.runnerLabel, innerWidth - heroPadX * 2).slice(0, 2);
  nameY = drawTextLines(ctx, nameLines, padding + heroPadX, nameY, 68);

  ctx.font = '800 18px Archivo, Arial, sans-serif';
  ctx.fillStyle = theme.meta;
  const subtitle = `${summary.event} · ${summary.sourceLabel.toUpperCase()}`;
  ctx.fillText(subtitle, padding + heroPadX, nameY + 6);

  // big finish time block
  const timeBoxW = innerWidth - heroPadX * 2;
  const timeBoxH = 168;
  const timeBoxX = padding + heroPadX;
  const timeBoxY = nameY + 50;
  // pink drop shadow
  ctx.fillStyle = theme.accent;
  ctx.fillRect(timeBoxX + 10, timeBoxY + 10, timeBoxW, timeBoxH);
  ctx.fillStyle = theme.ink;
  ctx.fillRect(timeBoxX, timeBoxY, timeBoxW, timeBoxH);

  // FINISH tab
  ctx.font = '900 15px Archivo, Arial, sans-serif';
  const finishLabel = 'FINISH';
  const finishLabelW = Math.ceil(ctx.measureText(finishLabel).width) + 22;
  const finishLabelH = 26;
  ctx.fillStyle = palette[1] || theme.accent;
  ctx.fillRect(timeBoxX + 22, timeBoxY - finishLabelH / 2 + 2, finishLabelW, finishLabelH);
  strokeRectOutline(ctx, timeBoxX + 22, timeBoxY - finishLabelH / 2 + 2, finishLabelW, finishLabelH, theme.ink, 2);
  ctx.fillStyle = theme.ink;
  ctx.fillText(finishLabel, timeBoxX + 33, timeBoxY - finishLabelH / 2 + 8);

  // huge time
  ctx.fillStyle = palette[1] || '#FFD61F';
  ctx.font = '900 104px Archivo, Arial, sans-serif';
  ctx.fillText(summary.time, timeBoxX + 24, timeBoxY + 38);

  // pace + descriptor on the right
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

  // -------- HERO VITALS STRIP (replaces flat badge row) ----------------
  const vitalsY = timeBoxY + timeBoxH + 26;
  const vitalsCardH = 88;
  const vitalsGap = 10;
  const vitalsCardW = Math.floor((timeBoxW - vitalsGap * 2) / 3);
  const h = summary.histogram;
  const topPctText = h ? `${(100 - h.beatPct).toFixed(1)}%` : `${(summary.tiles && summary.tiles[0] && summary.tiles[0].value) || '—'}`;
  const placeText = h ? `#${h.rank.toLocaleString()}` : (summary.tiles && summary.tiles[1] ? summary.tiles[1].value : '—');
  const fieldText = h ? `${h.count.toLocaleString()} finishers` : (summary.event ? `${summary.event} field` : '');
  const vitalsCards = [
    {
      label: 'TOP OF FIELD',
      value: topPctText,
      sub: h ? `Ahead of ${h.slower.toLocaleString()}` : '',
      fill: theme.accent,
      valueColor: palette[1] || '#FFD61F',
      labelColor: '#FFFFFF',
      subColor: '#FFFFFF',
    },
    {
      label: 'ESTIMATED PLACE',
      value: placeText,
      sub: fieldText,
      fill: palette[1] || '#FFD61F',
      valueColor: theme.ink,
      labelColor: theme.ink,
      subColor: theme.ink,
    },
    {
      label: 'FINISH PACE',
      value: summary.pace,
      sub: 'per mile',
      fill: theme.ink,
      valueColor: palette[1] || '#FFD61F',
      labelColor: palette[2] || theme.field || '#2EA8BD',
      subColor: '#FFFFFF',
    },
  ];
  for (let i = 0; i < vitalsCards.length; i += 1) {
    const c = vitalsCards[i];
    const vx = padding + heroPadX + i * (vitalsCardW + vitalsGap);
    // shadow
    ctx.fillStyle = theme.ink;
    ctx.fillRect(vx + 5, vitalsY + 5, vitalsCardW, vitalsCardH);
    // fill
    ctx.fillStyle = c.fill;
    ctx.fillRect(vx, vitalsY, vitalsCardW, vitalsCardH);
    strokeRectOutline(ctx, vx, vitalsY, vitalsCardW, vitalsCardH, theme.ink, 2);

    // label
    ctx.font = '900 11px Archivo, Arial, sans-serif';
    ctx.fillStyle = c.labelColor;
    ctx.fillText(c.label, vx + 14, vitalsY + 12);

    // value — fit by shrinking font if needed
    let valueFont = 38;
    ctx.font = `900 ${valueFont}px Archivo, Arial, sans-serif`;
    while (ctx.measureText(c.value).width > vitalsCardW - 26 && valueFont > 22) {
      valueFont -= 2;
      ctx.font = `900 ${valueFont}px Archivo, Arial, sans-serif`;
    }
    ctx.fillStyle = c.valueColor;
    ctx.fillText(c.value, vx + 14, vitalsY + 30);

    // sub
    if (c.sub) {
      ctx.font = '700 11px Archivo, Arial, sans-serif';
      ctx.fillStyle = c.subColor;
      ctx.fillText(c.sub, vx + 14, vitalsY + vitalsCardH - 18);
    }
  }

  y += heroBlockH;
  drawDottedDivider(ctx, padding, y, padding + innerWidth, theme.ink);

  // ====== PACING TILES (smaller squares) ===============================
  drawSectionTitle('Pacing wrapped', palette[0]);
  y += 58;

  const tiles = (summary.tiles || []).slice(0, 6);
  const tileCols = 3;
  const tileGap = 12;
  const tileW = Math.floor((innerWidth - heroPadX * 2 - tileGap * (tileCols - 1)) / tileCols);
  const tileH = 110;

  for (let i = 0; i < tiles.length; i += 1) {
    const col = i % tileCols;
    const row = Math.floor(i / tileCols);
    const tx = padding + heroPadX + col * (tileW + tileGap);
    const ty = y + row * (tileH + tileGap);
    const accent = palette[i % palette.length];

    // shadow
    ctx.fillStyle = theme.ink;
    ctx.fillRect(tx + 4, ty + 4, tileW, tileH);
    // base
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(tx, ty, tileW, tileH);
    strokeRectOutline(ctx, tx, ty, tileW, tileH, theme.ink, 2);
    // colored top bar
    ctx.fillStyle = accent;
    ctx.fillRect(tx, ty, tileW, 8);
    // colored mini-bib chip in top-right corner
    const chipW = 28, chipH = 18;
    ctx.fillStyle = theme.ink;
    ctx.fillRect(tx + tileW - chipW - 8, ty + 14, chipW, chipH);
    ctx.fillStyle = accent;
    ctx.font = '900 10px Archivo, Arial, sans-serif';
    const chipNum = `0${i + 1}`;
    const chipNumW = ctx.measureText(chipNum).width;
    ctx.fillText(chipNum, tx + tileW - chipW - 8 + (chipW - chipNumW) / 2, ty + 18);

    const tile = tiles[i];
    // kicker
    ctx.fillStyle = theme.meta;
    ctx.font = '800 10.5px Archivo, Arial, sans-serif';
    const kickerLines = wrapTextLines(ctx, tile.kicker.toUpperCase(), tileW - 50);
    drawTextLines(ctx, kickerLines.slice(0, 2), tx + 12, ty + 16, 13);

    // value — fit by shrinking font
    let tileValueFont = 32;
    ctx.font = `900 ${tileValueFont}px Archivo, Arial, sans-serif`;
    while (ctx.measureText(tile.value).width > tileW - 20 && tileValueFont > 18) {
      tileValueFont -= 2;
      ctx.font = `900 ${tileValueFont}px Archivo, Arial, sans-serif`;
    }
    ctx.fillStyle = accent;
    ctx.fillText(tile.value, tx + 12, ty + 44);

    // copy
    ctx.fillStyle = theme.copy;
    ctx.font = '600 10.5px Archivo, Arial, sans-serif';
    const copyLines = wrapTextLines(ctx, tile.copy, tileW - 20);
    drawTextLines(ctx, copyLines.slice(0, 2), tx + 12, ty + 82, 12);
  }

  const tileRows = Math.ceil(tiles.length / tileCols) || 0;
  y += tileRows * tileH + (tileRows > 0 ? (tileRows - 1) * tileGap : 0) + 22;
  drawDottedDivider(ctx, padding, y, padding + innerWidth, theme.ink);

  // ====== MINI HISTOGRAM ===============================================
  drawSectionTitle('You vs the field', palette[1]);
  y += 58;

  if (summary.histogram) {
    const hg = summary.histogram;
    const chartX = padding + heroPadX;
    const chartY = y;
    const chartW = innerWidth - heroPadX * 2;
    const chartH = 200;
    const padL = 18, padR = 18, padT = 14, padB = 38;
    const innerChartW = chartW - padL - padR;
    const innerChartH = chartH - padT - padB;
    const baselineY = chartY + padT + innerChartH;

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(chartX, chartY, chartW, chartH);
    strokeRectOutline(ctx, chartX, chartY, chartW, chartH, theme.ink, 2);

    const bins = hg.bins || [];
    const maxC = Math.max(1, ...bins);
    const barW = innerChartW / bins.length;
    for (let i = 0; i < bins.length; i += 1) {
      const bh = Math.max(1.5, (bins[i] / maxC) * innerChartH);
      const bx = chartX + padL + i * barW;
      const by = baselineY - bh;
      const isUser = i === hg.userBin;
      ctx.fillStyle = isUser ? theme.accent : theme.field || '#2EA8BD';
      ctx.fillRect(bx + 1, by, Math.max(1, barW - 2), bh);
    }
    ctx.fillStyle = theme.ink;
    ctx.fillRect(chartX + padL - 4, baselineY, innerChartW + 8, 2);

    const xForTime = (t) => chartX + padL + ((t - hg.lo) / Math.max(1, hg.hi - hg.lo)) * innerChartW;
    const medianX = xForTime(hg.medianSeconds);
    ctx.save();
    ctx.strokeStyle = theme.ink;
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(medianX, chartY + padT - 4);
    ctx.lineTo(medianX, baselineY);
    ctx.stroke();
    ctx.restore();
    // median tag
    ctx.font = '800 10px Archivo, Arial, sans-serif';
    const medText = `MEDIAN ${hg.medianText || formatTime(hg.medianSeconds)}`;
    const medW = ctx.measureText(medText).width + 12;
    const medTagX = Math.max(chartX + 2, Math.min(chartX + chartW - medW - 2, medianX - medW / 2));
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(medTagX, chartY + padT - 12, medW, 16);
    strokeRectOutline(ctx, medTagX, chartY + padT - 12, medW, 16, theme.ink, 1.2);
    ctx.fillStyle = theme.ink;
    ctx.fillText(medText, medTagX + 6, chartY + padT - 9);

    const userX = xForTime(hg.userSeconds);
    ctx.fillStyle = palette[1] || theme.accent;
    ctx.fillRect(userX - 1.5, chartY + padT, 3, innerChartH);

    // YOU sticker
    const stickerW = 130;
    const stickerH = 50;
    let stickerX = userX - stickerW / 2;
    stickerX = Math.max(chartX + 4, Math.min(chartX + chartW - stickerW - 4, stickerX));
    const stickerY = chartY + 4;
    ctx.fillStyle = theme.ink;
    ctx.fillRect(stickerX + 4, stickerY + 4, stickerW, stickerH);
    ctx.fillStyle = palette[1] || '#FFD61F';
    ctx.fillRect(stickerX, stickerY, stickerW, stickerH);
    strokeRectOutline(ctx, stickerX, stickerY, stickerW, stickerH, theme.ink, 2);
    ctx.fillStyle = theme.ink;
    ctx.font = '900 11px Archivo, Arial, sans-serif';
    ctx.fillText('YOU', stickerX + 12, stickerY + 8);
    ctx.font = '900 20px Archivo, Arial, sans-serif';
    ctx.fillText(summary.time, stickerX + 12, stickerY + 22);

    ctx.fillStyle = theme.ink;
    ctx.font = '800 13px Archivo, Arial, sans-serif';
    ctx.fillText(formatTime(hg.lo), chartX + padL, baselineY + 8);
    const hiText = formatTime(hg.hi);
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
      `${hg.beatPct.toFixed(1)}% AHEAD · ${hg.slower.toLocaleString()} OF ${hg.count.toLocaleString()} ${summary.event.toUpperCase()} FINISHERS`,
      chartX,
      captionY,
    );
    y = captionY + 24;
  }

  drawDottedDivider(ctx, padding, y, padding + innerWidth, theme.ink);

  // ====== FINISH-LINE NEIGHBORS ========================================
  drawSectionTitle('Finish-line neighbors', palette[2] || theme.accent);
  y += 58;

  const neighbors = (summary.neighbors || []).slice(0, 5);
  if (neighbors.length) {
    const tableX = padding + heroPadX;
    const tableW = innerWidth - heroPadX * 2;
    const rowH = 38;
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

      ctx.fillStyle = rn.isYou ? (palette[0]) : theme.meta;
      ctx.font = '900 15px Archivo, Arial, sans-serif';
      ctx.fillText(rn.isYou ? '★' : '·', tableX + 18, ry + 12);

      ctx.fillStyle = theme.ink;
      ctx.font = rn.isYou ? '900 17px Archivo, Arial, sans-serif' : '700 17px Archivo, Arial, sans-serif';
      ctx.fillText(rn.name, tableX + 42, ry + 10);

      ctx.font = '800 15px Archivo, Arial, sans-serif';
      const timeText = rn.time;
      const timeW = ctx.measureText(timeText).width;
      ctx.fillStyle = theme.ink;
      ctx.fillText(timeText, tableX + tableW - 200 - timeW / 2, ry + 12);

      ctx.font = '800 15px Archivo, Arial, sans-serif';
      ctx.fillStyle = rn.delta === 0 ? theme.ink : (palette[0]);
      const deltaText = rn.deltaLabel;
      const deltaW = ctx.measureText(deltaText).width;
      ctx.fillText(deltaText, tableX + tableW - 22 - deltaW, ry + 12);

      if (i < neighbors.length - 1) {
        ctx.save();
        ctx.strokeStyle = 'rgba(10,10,10,0.18)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tableX + 12, ry + rowH);
        ctx.lineTo(tableX + tableW - 12, ry + rowH);
        ctx.stroke();
        ctx.restore();
      }
    }
    y += tableH + 18;
  }

  // ====== FOOTER TICKER ===============================================
  const footerH = 78;
  const footerY = height - padding - footerH;
  const stripeY = footerY - 10;
  const stripeColors = [palette[1] || '#FFD61F', theme.ink, theme.accent, theme.ink];
  for (let i = 0, sx = padding; sx < padding + innerWidth; sx += 26, i += 1) {
    ctx.fillStyle = stripeColors[i % stripeColors.length];
    ctx.fillRect(sx, stripeY, 13, 10);
  }

  ctx.fillStyle = theme.accent;
  ctx.fillRect(padding, footerY, innerWidth, footerH);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '900 20px Archivo, Arial, sans-serif';
  ctx.fillText(theme.footerLeft || 'B2BWRAPPED.XYZ', padding + 28, footerY + 28);
  ctx.fillStyle = palette[1] || '#FFD61F';
  ctx.font = '900 16px Archivo, Arial, sans-serif';
  const tag = theme.footerRight || 'SHARE WITH #B2B2026';
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
    bg: '#4FC0D4',
    card: '#FFFFFF',
    ink: '#0A0A0A',
    accent: '#FF388F',
    accentPalette: ['#FF388F', '#FFD61F', '#2EA8BD', '#FF6A1A'],
    accentSoft: 'rgba(255, 214, 31, 0.35)',
    meta: '#555555',
    copy: '#1F1F1F',
    badgeBg: '#0A0A0A',
    badgeText: '#FFD61F',
    field: '#2EA8BD',
    footerLeft: 'B2BWRAPPED.XYZ',
    footerRight: 'SHARE WITH #B2B2026',
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
  const fileName = `${state.mobileSummaryFileBase || 'b2b-summary'}-summary.png`;

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
    'Bay to Breakers 2026 — Wrapped',
    `Runner: ${summary.runnerLabel}`,
    `Event: ${summary.event}`,
    `Source: ${summary.sourceLabel}`,
    `Finish: ${summary.time}  ·  Pace: ${summary.pace}`,
  ];
  if (summary.descriptor) lines.push(`Vibes: ${summary.descriptor}`);
  if (summary.overallRank) lines.push(`Overall: ${summary.overallRank} · ${summary.overallPercentile || ''}`.trim());
  lines.push('', 'Pacing wrapped:');
  for (const item of (summary.tiles || summary.stats || [])) {
    lines.push(`- ${item.kicker}: ${item.value}`);
    if (item.copy) lines.push(`    ${item.copy}`);
  }
  if (summary.neighbors && summary.neighbors.length) {
    lines.push('', 'Finish-line neighbors:');
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

  const fieldColor = theme.fieldBar || '#2EA8BD';
  const userColor = theme.userBar || '#FF388F';
  const ink = theme.ink || '#0A0A0A';
  const stickerColor = theme.userSticker || '#FFD61F';

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
  if (!section) return;

  if (!summary) {
    section.hidden = true;
    state.mobileSummaryText = '';
    state.mobileSummaryFileBase = 'b2b-summary';
    state.mobileSummaryData = null;
    releaseMobileSummaryImage();
    setMobileSummaryStatus('');
    return;
  }

  state.mobileSummaryText = buildMobileSummaryText(summary);
  state.mobileSummaryFileBase = slugify(`${summary.runnerLabel}-${summary.event}-wrapped`) || 'b2b-summary';
  state.mobileSummaryData = summary;
  setMobileSummaryStatus('Rendering your wrapped image…');
  section.hidden = false;

  releaseMobileSummaryImage();
  requestAnimationFrame(() => {
    ensureMobileSummaryImage()
      .then(() => setMobileSummaryStatus('Ready to save, share, or copy.'))
      .catch((err) => {
        console.error('Could not pre-render summary image', err);
        setMobileSummaryStatus(`Could not render image: ${err.message}`);
      });
  });
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

async function downloadMobileSummaryImage() {
  if (!state.mobileSummaryData) {
    setMobileSummaryStatus('Generate your wrapped first, then save an image.');
    return;
  }
  try {
    if (!state.mobileSummaryImageBlob) {
      setMobileSummaryStatus('Preparing image…');
      await ensureMobileSummaryImage();
    }
    const blob = state.mobileSummaryImageBlob;
    const fileName = state.mobileSummaryImageFileName
      || `${state.mobileSummaryFileBase || 'b2b-summary'}-summary.png`;
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

function signedDeltaLabel(deltaSeconds) {
  if (deltaSeconds === 0) return 'tied';
  const abs = formatTime(Math.abs(deltaSeconds));
  return deltaSeconds < 0 ? `-${abs}` : `+${abs}`;
}

function buildPosterNeighbors(event, seconds, runnerLabel) {
  const pool = nearestRows(event, seconds, 12);
  if (!pool.length) return [];
  const items = pool.map((r) => ({
    name: r.name || '—',
    bib: r.bib ?? null,
    time: formatTime(r.chip_seconds),
    chip_seconds: r.chip_seconds,
    delta: r.chip_seconds - seconds,
    deltaLabel: signedDeltaLabel(r.chip_seconds - seconds),
    isYou: false,
  }));
  items.push({
    name: runnerLabel || 'YOU',
    bib: null,
    time: formatTime(seconds),
    chip_seconds: seconds,
    delta: 0,
    deltaLabel: 'YOU',
    isYou: true,
  });
  items.sort((a, b) => a.chip_seconds - b.chip_seconds);
  const youIdx = items.findIndex((r) => r.isYou);
  // window 2 above + YOU + 2 below
  const start = Math.max(0, youIdx - 2);
  const end = Math.min(items.length, start + 5);
  return items.slice(start, end);
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

  // Pacing squares — punchy compact tiles for the poster
  const deltaSeconds = seconds - median;
  const deltaShort = deltaSeconds === 0
    ? '±0'
    : (deltaSeconds < 0 ? `-${formatTime(-deltaSeconds)}` : `+${formatTime(deltaSeconds)}`);
  const tiles = [];
  tiles.push({
    kicker: 'Top of field',
    value: `${(100 - overall.beatPct).toFixed(1)}%`,
    copy: `Beat ${overall.slower.toLocaleString()} of ${overall.count.toLocaleString()} ${event} finishers.`,
  });
  tiles.push({
    kicker: 'Estimated place',
    value: `#${overall.rank.toLocaleString()}`,
    copy: `Out of ${overall.count.toLocaleString()} ${event} finishers.`,
  });
  tiles.push({
    kicker: 'Vs median',
    value: deltaShort,
    copy: `Median ${event}: ${overall.group.p50}.`,
  });
  tiles.push({
    kicker: 'Pace',
    value: formatPace(seconds, eventMiles),
    copy: `Across ${eventMiles} mi of San Francisco.`,
  });
  if (genderStats) {
    tiles.push({
      kicker: `${gender} field`,
      value: `${(100 - genderStats.beatPct).toFixed(1)}%`,
      copy: `Top of ${genderStats.count.toLocaleString()} ${gender} ${event} runners.`,
    });
  } else if (ageStats) {
    tiles.push({
      kicker: `${ag} field`,
      value: `${(100 - ageStats.beatPct).toFixed(1)}%`,
      copy: `Top of ${ageStats.count.toLocaleString()} ${ag} runners.`,
    });
  }
  if (tiles.length < 6) {
    const nameStats = sameFirstNameStats(event, firstName, seconds);
    if (nameStats) {
      tiles.push({
        kicker: 'Name twins',
        value: nameStats.count === 1 ? `Only ${nameStats.firstName}` : `#${nameStats.rank.toLocaleString()}`,
        copy: nameStats.count === 1
          ? `The only ${nameStats.firstName} in ${event}.`
          : `Of ${nameStats.count.toLocaleString()} ${nameStats.firstName}s in ${event}.`,
      });
    }
  }
  if (tiles.length < 6 && runner && runner.teams && runner.teams.length) {
    const team = runner.teams[0];
    tiles.push({
      kicker: 'Team',
      value: team.team_name ? team.team_name.toString().slice(0, 18) : 'Centipede',
      copy: team.team_rank
        ? `Team rank ${team.team_rank} · avg ${team.team_avg_chip_time || '—'}.`
        : `Avg ${team.team_avg_chip_time || '—'}.`,
    });
  }

  const badges = [
    `#${overall.rank.toLocaleString()} of ${overall.count.toLocaleString()}`,
    `Top ${(100 - overall.beatPct).toFixed(1)}%`,
    `${formatPace(seconds, eventMiles)}`,
  ];

  const histogram = buildPosterHistogram(overall.group, seconds);
  const neighbors = buildPosterNeighbors(event, seconds, runnerLabel);

  renderMobileSummaryWrapped({
    runnerLabel,
    event,
    sourceLabel,
    time: formatTime(seconds),
    pace: formatPace(seconds, eventMiles),
    descriptor: descriptor(overall.beatPct),
    overallRank: `${overall.rank.toLocaleString()} of ${overall.count.toLocaleString()}`,
    overallPercentile: `${overall.beatPct.toFixed(1)}% ahead of field`,
    stats: summaryStats,
    tiles,
    badges,
    histogram,
    neighbors,
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
