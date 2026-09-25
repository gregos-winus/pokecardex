// Traitement d'image : découpe des zones de texte et comparaison visuelle avec les images officielles.

export const CARD_W = 630;
export const CARD_H = 880;

// Zones relatives à la carte (0..1). Larges pour tolérer un cadrage approximatif.
export const ZONES = {
  name: { x: 0.02, y: 0.015, w: 0.96, h: 0.125 },
  number: { x: 0.0, y: 0.865, w: 1.0, h: 0.125 },
  nameBelow: { x: 0.02, y: 0.12, w: 0.75, h: 0.12 },
  nameTight: { x: 0.03, y: 0.02, w: 0.62, h: 0.09 },
};

let sharpCanvas = null;

/** Netteté d'une zone : variance du laplacien sur une vignette en niveaux de gris. */
export function sharpness(source, r, size = 240) {
  const k = size / Math.max(r.w, r.h);
  const w = Math.max(8, Math.round(r.w * k)), h = Math.max(8, Math.round(r.h * k));
  sharpCanvas ??= makeCanvas(w, h);
  if (sharpCanvas.width !== w || sharpCanvas.height !== h) { sharpCanvas.width = w; sharpCanvas.height = h; }
  const ctx = ctx2d(sharpCanvas);
  ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += l; sum2 += l * l; n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

/** Extrait une zone de la carte normalisée, agrandie, en niveaux de gris contrastés. */
export function extractZone(card, zone, scale = 2, invert = false) {
  const sx = zone.x * card.width, sy = zone.y * card.height;
  const sw = zone.w * card.width, sh = zone.h * card.height;
  const out = makeCanvas(sw * scale, sh * scale);
  const ctx = ctx2d(out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(card, sx, sy, sw, sh, 0, 0, out.width, out.height);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  const gray = new Uint8ClampedArray(d.length / 4);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    gray[p] = g;
    hist[g]++;
  }
  // Étirement du contraste entre les percentiles 2 et 98
  const total = gray.length;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let v = ((gray[p] - lo) * 255) / range;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/**
 * Binarisation adaptative : chaque pixel est comparé à la moyenne de son voisinage.
 * Plus robuste que le contraste global quand l'éclairage ou le fond varient le long du nom.
 */
export function adaptiveThreshold(canvas) {
  const w = canvas.width, h = canvas.height, ctx = ctx2d(canvas);
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const I = new Float64Array((w + 1) * (h + 1)); // image intégrale
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += d[(y * w + x) * 4];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.max(8, Math.round(h / 3));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r);
      const mean = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      const o = (y * w + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = d[o] < mean - 10 ? 0 : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Signature visuelle compacte : vignette en niveaux de gris centrée-réduite
 * + histogramme de teintes de l'illustration.
 */
export function signature(source) {
  // Réduction en deux étapes pour limiter l'aliasing
  const mid = makeCanvas(128, 176);
  const mctx = ctx2d(mid);
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(source, 0, 0, mid.width, mid.height);
  const small = makeCanvas(24, 33);
  const sctx = ctx2d(small);
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(mid, 0, 0, small.width, small.height);

  const px = sctx.getImageData(0, 0, small.width, small.height).data;
  const n = small.width * small.height;
  const gray = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    gray[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
    mean += gray[i];
  }
  mean /= n;
  let norm = 0;
  for (let i = 0; i < n; i++) { gray[i] -= mean; norm += gray[i] * gray[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < n; i++) gray[i] /= norm;

  // Histogramme teinte/saturation sur la zone d'illustration (haut de la carte)
  const art = mctx.getImageData(10, 18, 108, 70).data;
  const BINS = 12;
  const hist = new Float32Array(BINS + 1); // dernière case : pixels peu saturés
  let count = 0;
  for (let i = 0; i < art.length; i += 4) {
    const r = art[i] / 255, g = art[i + 1] / 255, b = art[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const s = max ? (max - min) / max : 0;
    if (s < 0.2 || max < 0.15) { hist[BINS]++; count++; continue; }
    let h;
    if (max === r) h = ((g - b) / (max - min) + 6) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    hist[Math.floor((h / 6) * BINS) % BINS]++;
    count++;
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= count || 1;
  return { gray, hist };
}

export function compareSignatures(a, b) {
  let ncc = 0;
  for (let i = 0; i < a.gray.length; i++) ncc += a.gray[i] * b.gray[i];
  let inter = 0;
  for (let i = 0; i < a.hist.length; i++) inter += Math.min(a.hist[i], b.hist[i]);
  return 0.6 * Math.max(0, ncc) + 0.4 * inter;
}

const sigCache = new Map();

/** Signature d'une image distante (nécessite CORS). Renvoie null si indisponible. */
export async function remoteSignature(url) {
  if (!url) return null;
  if (sigCache.has(url)) return sigCache.get(url);
  const p = new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      try { resolve(signature(img)); } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  sigCache.set(url, p);
  return p;
}

// ---------------------------------------------------------------- détection de la carte

/**
 * Cherche le contour de la carte (quadrilatère) dans une zone de l'image.
 * Principe : contours (Sobel couleur) → droites (Hough) → paires de droites parallèles
 * → quadrilatères au bon format, notés selon la proportion de leur périmètre couverte par des contours.
 * @returns {{quad: {x:number,y:number}[], score:number}|null} coins HG, HD, BD, BG en coordonnées source
 */
export function detectCard(source, region = { x: 0, y: 0, w: source.width, h: source.height }, opts = {}) {
  const { max: MAX = 360, areaExp = 0.2, landscape = 0.4, outer = 0.4, outerMax = 1.4 } = opts;
  const k = Math.min(1, MAX / Math.max(region.w, region.h));
  const W = Math.max(8, Math.round(region.w * k)), H = Math.max(8, Math.round(region.h * k));
  const c = makeCanvas(W, H);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;

  // Gradient couleur : pour chaque pixel, le canal au plus fort gradient
  const mag = new Float32Array(W * H), ang = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let best = 0, bgx = 0, bgy = 0;
      for (let ch = 0; ch < 3; ch++) {
        const p = (i, j) => px[((y + j) * W + (x + i)) * 4 + ch];
        const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
        const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
        const m = gx * gx + gy * gy;
        if (m > best) { best = m; bgx = gx; bgy = gy; }
      }
      mag[y * W + x] = Math.sqrt(best);
      ang[y * W + x] = Math.atan2(bgy, bgx);
    }
  }
  const sorted = Float32Array.from(mag).sort();
  const thr = Math.max(60, sorted[Math.floor(sorted.length * 0.85)]);
  const edge = new Uint8Array(W * H);
  for (let i = 0; i < edge.length; i++) edge[i] = mag[i] > thr ? 1 : 0;

  // Transformée de Hough orientée par le gradient
  const NT = 180, diag = Math.ceil(Math.hypot(W, H)), NR = 2 * diag + 1;
  const acc = new Uint16Array(NT * NR);
  const cosT = new Float32Array(NT), sinT = new Float32Array(NT);
  for (let t = 0; t < NT; t++) { cosT[t] = Math.cos((t * Math.PI) / NT); sinT[t] = Math.sin((t * Math.PI) / NT); }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!edge[i]) continue;
      let t0 = Math.round((((ang[i] % Math.PI) + Math.PI) % Math.PI) / Math.PI * NT);
      for (let d = -3; d <= 3; d++) {
        const t = (t0 + d + NT) % NT;
        const r = Math.round(x * cosT[t] + y * sinT[t]) + diag;
        acc[t * NR + r]++;
      }
    }
  }
  const minDim = Math.min(W, H);
  const minVotes = Math.max(12, minDim * 0.12);
  const peaks = [];
  for (let t = 0; t < NT; t++) {
    for (let r = 0; r < NR; r++) {
      const v = acc[t * NR + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -4; dt <= 4 && isMax; dt++) {
        for (let dr = -4; dr <= 4; dr++) {
          if (!dt && !dr) continue;
          let tt = t + dt, rr = r + dr;
          if (tt < 0) { tt += NT; rr = NR - 1 - rr; } else if (tt >= NT) { tt -= NT; rr = NR - 1 - rr; }
          if (rr < 0 || rr >= NR) continue;
          const o = acc[tt * NR + rr];
          if (o > v || (o === v && (dt < 0 || (dt === 0 && dr < 0)))) { isMax = false; break; }
        }
      }
      if (isMax) peaks.push({ t, rho: r - diag, v, theta: (t * Math.PI) / NT });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const lines = peaks.slice(0, 36);

  const angDiff = (a, b) => { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      if (angDiff(a.theta, b.theta) > (14 * Math.PI) / 180) continue;
      // Distance entre les deux droites (au milieu de l'image)
      const cx = W / 2, cy = H / 2;
      const da = cx * Math.cos(a.theta) + cy * Math.sin(a.theta) - a.rho;
      const db = cx * Math.cos(b.theta) + cy * Math.sin(b.theta) - b.rho;
      const sameDir = Math.abs(a.theta - b.theta) < Math.PI / 2;
      const dist = Math.abs(sameDir ? da - db : da + db);
      if (dist < minDim * 0.15) continue;
      pairs.push([a, b]);
    }
  }

  const inter = (a, b) => {
    const det = Math.cos(a.theta) * Math.sin(b.theta) - Math.sin(a.theta) * Math.cos(b.theta);
    if (Math.abs(det) < 1e-6) return null;
    return {
      x: (a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / det,
      y: (b.rho * Math.cos(a.theta) - a.rho * Math.cos(b.theta)) / det,
    };
  };
  const support = (p, q) => {
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const n = Math.max(12, Math.min(60, Math.round(len / 3)));
    const nx = -(q.y - p.y) / len, ny = (q.x - p.x) / len;
    const normal = Math.atan2(ny, nx);
    let hits = 0, total = 0;
    for (let s = 0; s < n; s++) {
      const f = 0.08 + (0.84 * s) / (n - 1);
      const x0 = p.x + (q.x - p.x) * f, y0 = p.y + (q.y - p.y) * f;
      total++;
      for (let o = -2; o <= 2; o++) {
        const x = Math.round(x0 + nx * o), y = Math.round(y0 + ny * o);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (edge[i] && angDiff(ang[i], normal) < 0.35) { hits++; break; }
      }
    }
    return hits / total;
  };

  const CARD = 88 / 63;
  const quads = [];
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const [a1, a2] = pairs[i], [b1, b2] = pairs[j];
      const cross = angDiff(a1.theta, b1.theta);
      if (cross < (60 * Math.PI) / 180) continue;
      const p1 = inter(a1, b1), p2 = inter(b1, a2), p3 = inter(a2, b2), p4 = inter(b2, a1);
      if (!p1 || !p2 || !p3 || !p4) continue;
      const pts = [p1, p2, p3, p4];
      if (pts.some(p => p.x < -W * 0.03 || p.y < -H * 0.03 || p.x > W * 1.03 || p.y > H * 1.03)) continue;
      // Convexité
      let sign = 0, convex = true;
      for (let m = 0; m < 4; m++) {
        const A = pts[m], B = pts[(m + 1) % 4], C = pts[(m + 2) % 4];
        const z = (B.x - A.x) * (C.y - B.y) - (B.y - A.y) * (C.x - B.x);
        if (m === 0) sign = Math.sign(z); else if (Math.sign(z) !== sign) { convex = false; break; }
      }
      if (!convex) continue;
      const side = m => Math.hypot(pts[(m + 1) % 4].x - pts[m].x, pts[(m + 1) % 4].y - pts[m].y);
      const s0 = (side(0) + side(2)) / 2, s1 = (side(1) + side(3)) / 2;
      const ratio = Math.max(s0, s1) / Math.min(s0, s1);
      if (ratio < 1.15 || ratio > 1.75) continue;
      let area = 0;
      for (let m = 0; m < 4; m++) area += pts[m].x * pts[(m + 1) % 4].y - pts[(m + 1) % 4].x * pts[m].y;
      area = Math.abs(area) / 2;
      const areaFrac = area / (W * H);
      if (areaFrac < 0.04) continue;
      const cov = [0, 1, 2, 3].map(m => support(pts[m], pts[(m + 1) % 4]));
      const minCov = Math.min(...cov);
      if (minCov < 0.2) continue;
      const mean = cov.reduce((s, v) => s + v, 0) / 4;
      // Carte couchée (grand côté horizontal) : rare, on la pénalise
      const longIsS0 = s0 > s1;
      const dx = longIsS0 ? pts[1].x - pts[0].x : pts[2].x - pts[1].x;
      const dy = longIsS0 ? pts[1].y - pts[0].y : pts[2].y - pts[1].y;
      const lying = Math.abs(dx) > Math.abs(dy);
      const score = mean * Math.sqrt(minCov) *
        Math.exp(-(((ratio - CARD) / 0.22) ** 2)) * Math.pow(areaFrac, areaExp) * (lying ? landscape : 1);
      quads.push({ pts, score, area });
    }
  }
  if (!quads.length) return null;
  let best = quads.reduce((a, b) => (b.score > a.score ? b : a));
  if (best.score < 0.18) return null;
  if (outer) {
    // Parmi les bons candidats qui englobent le meilleur, on garde le plus grand (bord extérieur de la carte)
    const inside = (q, p) => {
      for (let m = 0; m < 4; m++) {
        const A = q[m], B = q[(m + 1) % 4];
        if ((B.x - A.x) * (p.y - A.y) - (B.y - A.y) * (p.x - A.x) < -2 * Math.hypot(B.x - A.x, B.y - A.y)) return false;
      }
      return true;
    };
    const orient = q => { let a = 0; for (let m = 0; m < 4; m++) a += q[m].x * q[(m + 1) % 4].y - q[(m + 1) % 4].x * q[m].y; return a > 0 ? q : [...q].reverse(); };
    const bq = orient(best.pts);
    for (const q of quads) {
      // bord extérieur de la carte : un peu plus grand seulement (pas le bord de la photo ou d'un livre)
      if (q.score < best.score * outer || q.area <= best.area || q.area > best.area * outerMax) continue;
      const oq = orient(q.pts);
      if (bq.every(p => inside(oq, p)) && q.area > best.area) best = q;
    }
  }

  const quad = orderCorners(best.pts).map(p => ({ x: region.x + p.x / k, y: region.y + p.y / k }));
  return { quad, score: best.score };
}

/** Ordonne les coins en HG, HD, BD, BG en supposant la carte à peu près à l'endroit. */
function orderCorners(pts) {
  // Les grands côtés donnent l'axe vertical de la carte
  const len = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let shortA, shortB; // deux petits côtés opposés
  if (len(pts[0], pts[1]) + len(pts[2], pts[3]) < len(pts[1], pts[2]) + len(pts[3], pts[0])) {
    shortA = [pts[0], pts[1]]; shortB = [pts[2], pts[3]];
  } else {
    shortA = [pts[1], pts[2]]; shortB = [pts[3], pts[0]];
  }
  const mid = s => ({ x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 });
  let top = shortA, bottom = shortB;
  const mA = mid(shortA), mB = mid(shortB);
  // Le haut est le petit côté le plus haut dans l'image (ou le plus à gauche si la carte est couchée)
  if (Math.abs(mA.y - mB.y) > Math.abs(mA.x - mB.x) * 0.4 ? mB.y < mA.y : mB.x < mA.x) { top = shortB; bottom = shortA; }
  const mt = mid(top), mb = mid(bottom);
  const down = { x: mb.x - mt.x, y: mb.y - mt.y };
  const left = { x: -down.y, y: down.x };
  const leftness = p => (p.x - mt.x) * left.x + (p.y - mt.y) * left.y;
  const [tl, tr] = leftness(top[0]) > leftness(top[1]) ? [top[0], top[1]] : [top[1], top[0]];
  const lb = p => (p.x - mb.x) * left.x + (p.y - mb.y) * left.y;
  const [bl, br] = lb(bottom[0]) > lb(bottom[1]) ? [bottom[0], bottom[1]] : [bottom[1], bottom[0]];
  return [tl, tr, br, bl];
}

/** Homographie qui envoie le rectangle (0,0)-(w,h) sur le quadrilatère `q`. */
function homography(w, h, q) {
  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], { x: u, y: v } = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Élimination de Gauss
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let cc = col; cc < 8; cc++) A[r][cc] -= f * A[col][cc];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

/**
 * Redresse la carte délimitée par `quad` (coordonnées dans `source`) en 630×880.
 * `pad` agrandit un peu la zone : un bord détecté trop à l'intérieur ne coupe pas le texte.
 */
export function warpCard(source, quad, pad = 0.025) {
  const H0 = homography(1, 1, quad);
  const map = (x, y) => { const z = H0[6] * x + H0[7] * y + 1; return { x: (H0[0] * x + H0[1] * y + H0[2]) / z, y: (H0[3] * x + H0[4] * y + H0[5]) / z }; };
  if (pad) quad = [map(-pad, -pad), map(1 + pad, -pad), map(1 + pad, 1 + pad), map(-pad, 1 + pad)];
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
  const bx = Math.max(0, Math.floor(Math.min(...xs)) - 2), by = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const bw = Math.min(source.width, Math.ceil(Math.max(...xs)) + 2) - bx;
  if (bw < 2) return makeCanvas(CARD_W, CARD_H);
  const bh = Math.min(source.height, Math.ceil(Math.max(...ys)) + 2) - by;
  // Copie de la zone utile, réduite si elle est bien plus grande que la sortie
  const k = Math.min(1, (CARD_H * 1.6) / Math.max(bw, bh));
  const sw = Math.max(1, Math.round(bw * k)), sh = Math.max(1, Math.round(bh * k));
  const tmp = makeCanvas(sw, sh);
  const tctx = ctx2d(tmp);
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(source, bx, by, bw, bh, 0, 0, sw, sh);
  const src = tctx.getImageData(0, 0, sw, sh).data;
  const H = homography(CARD_W, CARD_H, quad.map(p => ({ x: (p.x - bx) * k, y: (p.y - by) * k })));

  const out = makeCanvas(CARD_W, CARD_H);
  const octx = ctx2d(out);
  const img = octx.createImageData(CARD_W, CARD_H);
  const d = img.data;
  for (let y = 0; y < CARD_H; y++) {
    for (let x = 0; x < CARD_W; x++) {
      const z = H[6] * x + H[7] * y + 1;
      const u = (H[0] * x + H[1] * y + H[2]) / z, v = (H[3] * x + H[4] * y + H[5]) / z;
      const o = (y * CARD_W + x) * 4;
      const x0 = Math.floor(u), y0 = Math.floor(v);
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) { d[o] = d[o + 1] = d[o + 2] = 128; d[o + 3] = 255; continue; }
      const fx = u - x0, fy = v - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        d[o + ch] = (src[i00 + ch] * (1 - fx) + src[i10 + ch] * fx) * (1 - fy) + (src[i01 + ch] * (1 - fx) + src[i11 + ch] * fx) * fy;
      }
      d[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}
