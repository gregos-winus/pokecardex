import { CardIndex, parseNumber, normalize } from './matcher.js';
import { loadCards, loadSets, loadCard, cardImage, assetImage } from './tcgdex.js';
import { readCard, getWorker } from './ocr.js';
import {
  CARD_W, CARD_H, makeCanvas, signature, remoteSignature, compareSignatures, detectCard, warpCard, sharpness,
} from './vision.js';

const $ = sel => document.querySelector(sel);
const els = {
  stage: $('#stage'), video: $('#video'), photo: $('#photo'), guide: $('#guide'),
  placeholder: $('#placeholder'), placeholderText: $('#placeholderText'), startCamera: $('#startCamera'),
  status: $('#status'), torch: $('#torch'), switchCamera: $('#switchCamera'), backToCamera: $('#backToCamera'),
  scan: $('#scan'), auto: $('#auto'), file: $('#file'), lang: $('#lang'),
  searchForm: $('#searchForm'), searchInput: $('#searchInput'), results: $('#results'),
  openCollection: $('#openCollection'), collectionCount: $('#collectionCount'),
  collectionDialog: $('#collectionDialog'), closeCollection: $('#closeCollection'),
  collectionList: $('#collectionList'), collectionSummary: $('#collectionSummary'), exportCsv: $('#exportCsv'),
  tplResult: $('#tplResult'),
  diag: $('#diag'), diagText: $('#diagText'), diagCrop: $('#diagCrop'), diagCopy: $('#diagCopy'),
};

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  },
};

const state = {
  lang: store.get('pokescan.lang', 'fr'),
  index: null,
  indexPromise: null,
  mode: 'none', // 'camera' | 'photo' | 'none'
  stream: null,
  devices: [],
  deviceId: null,
  torchOn: false,
  photo: null, // { img, scale, tx, ty }
  busy: false,
  autoTimer: null,
  visualAvailable: true,
  collection: store.get('pokescan.collection', []),
};

// ---------------------------------------------------------------- statut

let statusTimer = null;
function setStatus(text, kind = 'info', ttl = 0) {
  clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.dataset.kind = kind;
  els.status.classList.toggle('show', !!text);
  if (ttl) statusTimer = setTimeout(() => els.status.classList.remove('show'), ttl);
}

// ---------------------------------------------------------------- base de cartes

function loadIndex(lang) {
  state.index = null;
  setStatus(`Chargement de la base de cartes (${lang.toUpperCase()})…`, 'busy');
  const p = Promise.all([loadCards(lang), loadSets(lang)])
    .then(([cards, sets]) => {
      if (state.lang !== lang) return null;
      state.index = new CardIndex(cards, sets);
      setStatus(`Base prête : ${state.index.cards.length.toLocaleString('fr-FR')} cartes`, 'ok', 2500);
      return state.index;
    })
    .catch(err => {
      console.error(err);
      state.indexError = err.message;
      setStatus('Impossible de charger la base TCGdex. Vérifiez votre connexion.', 'error');
      throw err;
    });
  state.indexPromise = p;
  // Préchargement de l'OCR en parallèle
  state.ocrStatus = 'chargement';
  getWorker(lang, ocrProgress)
    .then(() => { state.ocrStatus = 'prêt'; })
    .catch(err => { state.ocrStatus = `ERREUR : ${err.message}`; console.warn('OCR', err); });
  return p;
}

function ocrProgress(m) {
  state.ocrStatus = `${m.status} ${Math.round((m.progress || 0) * 100)} %`;
  if (!state.busy && m.status && m.status.includes('loading') && m.progress < 1) {
    setStatus(`Préparation de l'OCR… ${Math.round((m.progress || 0) * 100)} %`, 'busy');
  }
}

async function ensureIndex() {
  if (state.index) return state.index;
  try { return await state.indexPromise; } catch { return loadIndex(state.lang); }
}

// ---------------------------------------------------------------- caméra

async function startCamera(deviceId = state.deviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    els.placeholderText.innerHTML = window.isSecureContext
      ? 'Ce navigateur ne donne pas accès à la caméra.<br>Utilisez le bouton « Photo ».'
      : 'La caméra n\'est accessible qu\'en HTTPS (ou sur localhost).<br>Utilisez le bouton « Photo » en attendant.';
    els.startCamera.hidden = true;
    return;
  }
  stopCamera();
  const request = ++cameraRequest;
  const video = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: { ideal: 'environment' } };
  Object.assign(video, { width: { ideal: 1920 }, height: { ideal: 1080 } });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (err) {
    console.warn(err);
    if (request !== cameraRequest) return;
    els.placeholderText.innerHTML = err.name === 'NotAllowedError'
      ? 'Accès à la caméra refusé.<br>Autorisez-le dans les réglages du navigateur, ou utilisez « Photo ».'
      : 'Aucune caméra disponible.<br>Utilisez le bouton « Photo ».';
    setMode('none');
    return;
  }
  if (request !== cameraRequest) { stream.getTracks().forEach(t => t.stop()); return; }
  state.stream = stream;
  const track = stream.getVideoTracks()[0];
  state.deviceId = track.getSettings().deviceId ?? deviceId;
  try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* non supporté */ }

  els.video.srcObject = state.stream;
  await els.video.play().catch(() => {});
  setMode('camera');

  const caps = track.getCapabilities?.() ?? {};
  els.torch.hidden = !caps.torch;
  state.torchOn = false;
  try {
    state.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  } catch { state.devices = []; }
  els.switchCamera.hidden = state.devices.length < 2;
}

// Invalide les demandes de caméra en cours (ex. photo importée pendant l'autorisation)
let cameraRequest = 0;

function stopCamera() {
  cameraRequest++;
  stopAuto();
  state.stream?.getTracks().forEach(t => t.stop());
  state.stream = null;
  els.video.srcObject = null;
}

async function switchCamera() {
  if (state.devices.length < 2) return;
  const i = state.devices.findIndex(d => d.deviceId === state.deviceId);
  const next = state.devices[(i + 1) % state.devices.length];
  await startCamera(next.deviceId);
}

async function toggleTorch() {
  const track = state.stream?.getVideoTracks()[0];
  if (!track) return;
  state.torchOn = !state.torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
    els.torch.classList.toggle('on', state.torchOn);
  } catch { els.torch.hidden = true; }
}

function setMode(mode) {
  state.mode = mode;
  els.video.hidden = mode !== 'camera';
  els.photo.hidden = mode !== 'photo';
  els.backToCamera.hidden = mode !== 'photo';
  if (mode !== 'camera') { els.torch.hidden = true; els.switchCamera.hidden = true; }
  els.scan.disabled = mode === 'none';
  els.auto.disabled = mode !== 'camera';
  if (mode !== 'camera') els.auto.checked = false;
  showPlaceholder(mode === 'none');
  $('#hint').textContent = mode === 'photo'
    ? 'Déplacez la photo (glisser) et zoomez (pincer ou molette) pour ajuster la carte au cadre, puis « Scanner ».'
    : 'Tenez le téléphone à 15–20 cm, la carte dans le cadre, bien éclairée : le nom en haut, le numéro en bas.';
  layoutGuide();
}

function showPlaceholder(show) {
  els.placeholder.hidden = !show;
}

// ---------------------------------------------------------------- cadre de visée

function guideRect() {
  const sw = els.stage.clientWidth, sh = els.stage.clientHeight;
  // Cadre volontairement pas trop grand : pour le remplir, le téléphone reste à ~15 cm,
  // distance à laquelle la plupart des appareils photo arrivent à faire la mise au point.
  let h = sh * 0.78, w = (h * 63) / 88;
  if (w > sw * 0.9) { w = sw * 0.9; h = (w * 88) / 63; }
  return { x: (sw - w) / 2, y: (sh - h) / 2, w, h };
}

function layoutGuide() {
  const g = guideRect();
  Object.assign(els.guide.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, height: `${g.h}px` });
  if (state.mode === 'photo') drawPhoto();
}

/**
 * Image source courante (trame vidéo ou photo) et position du cadre de visée dans cette image.
 */
function currentFrame() {
  const g = guideRect();
  if (state.mode === 'camera') {
    const v = els.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const frame = makeCanvas(vw, vh);
    frame.getContext('2d').drawImage(v, 0, 0);
    const ew = els.stage.clientWidth, eh = els.stage.clientHeight;
    const s = Math.max(ew / vw, eh / vh); // object-fit: cover
    const dx = (ew - vw * s) / 2, dy = (eh - vh * s) / 2;
    return { frame, guide: { x: (g.x - dx) / s, y: (g.y - dy) / s, w: g.w / s, h: g.h / s } };
  }
  if (state.mode === 'photo') {
    const { img, scale, tx, ty } = state.photo;
    return { frame: img, guide: { x: (g.x - tx) / scale, y: (g.y - ty) / scale, w: g.w / scale, h: g.h / scale } };
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Caméra : garde l'image la plus nette parmi plusieurs images prises sur `duration` ms.
 * Le tremblement de la main et la mise au point rendent beaucoup d'images floues ;
 * l'appui sur « Scanner » fait lui-même bouger le téléphone.
 */
async function grabSharpFrame(duration = 450, samples = 6) {
  if (state.mode !== 'camera') return currentFrame();
  let best = null;
  for (let i = 0; i < samples; i++) {
    if (i) await sleep(duration / samples);
    const cur = currentFrame();
    if (!cur) break;
    const r = clipRect(cur.guide, cur.frame);
    cur.sharpness = r ? sharpness(cur.frame, r) : 0;
    if (!best || cur.sharpness > best.sharpness) best = cur;
  }
  return best;
}

/**
 * Recadrages possibles de la carte visée, du plus probable au moins probable.
 * 1. carte détectée par ses bords puis redressée (perspective) ;
 * 2. simple contenu du cadre de visée ;
 * 3. (photo) image entière, si elle a déjà le format d'une carte.
 */
function captureCandidates(cur) {
  if (!cur) return [];
  const { frame, guide: g } = cur;
  const out = [];

  // En mode photo, les coins trouvés à l'ouverture restent valables tant que la photo n'a pas bougé
  let quad = state.mode === 'photo' ? state.photo.quad : null;
  if (!quad) {
    const mx = g.w * 0.4, my = g.h * 0.3;
    const region = clipRect({ x: g.x - mx, y: g.y - my, w: g.w + 2 * mx, h: g.h + 2 * my }, frame);
    const found = region && detectCard(frame, region);
    if (found && quadArea(found.quad) > g.w * g.h * 0.3) quad = found.quad;
  }
  if (quad) out.push({ card: warpCard(frame, quad), detected: true });
  out.push({ card: cropToCard(frame, g), detected: false });
  const ratio = frame.height / frame.width;
  if (state.mode === 'photo' && ratio > 1.2 && ratio < 1.6) {
    out.push({ card: cropToCard(frame, { x: 0, y: 0, w: frame.width, h: frame.height }), detected: false });
  }
  return out;
}

function cropToCard(frame, r) {
  const out = makeCanvas(CARD_W, CARD_H);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, CARD_W, CARD_H);
  return out;
}

function clipRect(r, img) {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  const w = Math.min(img.width, r.x + r.w) - x, h = Math.min(img.height, r.y + r.h) - y;
  return w > 16 && h > 16 ? { x, y, w, h } : null;
}

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) a += q[i].x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * q[i].y;
  return Math.abs(a) / 2;
}

// ---------------------------------------------------------------- mode photo

const PHOTO_MAX = 2000;

async function openPhoto(file) {
  if (!file) return null;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch {
    setStatus('Image illisible.', 'error', 3000);
    return null;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  stopCamera();
  // Copie réduite : les photos de téléphone (12 Mpx) sont inutilement lourdes à traiter
  const k = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = makeCanvas(img.naturalWidth * k, img.naturalHeight * k);
  const cctx = canvas.getContext('2d');
  cctx.imageSmoothingQuality = 'high';
  cctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Cherche la carte dans toute la photo pour la placer dans le cadre
  const g = guideRect();
  const found = detectCard(canvas);
  let box = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  if (found) {
    const xs = found.quad.map(p => p.x), ys = found.quad.map(p => p.y);
    box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  const scale = Math.min(g.w / box.w, g.h / box.h);
  state.photo = {
    img: canvas, scale, quad: found?.quad ?? null,
    tx: g.x + (g.w - box.w * scale) / 2 - box.x * scale,
    ty: g.y + (g.h - box.h * scale) / 2 - box.y * scale,
  };
  setMode('photo');
  return scan();
}

function drawPhoto() {
  const c = els.photo, p = state.photo;
  if (!p) return;
  const dpr = window.devicePixelRatio || 1;
  const w = els.stage.clientWidth, h = els.stage.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(dpr * p.scale, 0, 0, dpr * p.scale, dpr * p.tx, dpr * p.ty);
  ctx.drawImage(p.img, 0, 0);
}

function zoomPhoto(factor, cx, cy) {
  const p = state.photo;
  const next = Math.min(Math.max(p.scale * factor, 0.02), 20);
  const f = next / p.scale;
  p.quad = null;
  p.tx = cx - (cx - p.tx) * f;
  p.ty = cy - (cy - p.ty) * f;
  p.scale = next;
  drawPhoto();
}

function bindPhotoGestures() {
  const pointers = new Map();
  let last = null;
  const local = e => {
    const r = els.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const gesture = () => {
    const pts = [...pointers.values()];
    if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, d: 0 };
    const [a, b] = pts;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  els.stage.addEventListener('pointerdown', e => {
    if (state.mode !== 'photo' || e.target.closest('button')) return;
    els.stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    last = gesture();
  });
  els.stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    const g = gesture();
    state.photo.tx += g.x - last.x;
    state.photo.ty += g.y - last.y;
    if (g.x !== last.x || g.y !== last.y || g.d !== last.d) state.photo.quad = null; // recadrage manuel
    if (g.d && last.d) zoomPhoto(g.d / last.d, g.x, g.y);
    else drawPhoto();
    last = g;
  });
  const end = e => {
    pointers.delete(e.pointerId);
    last = pointers.size ? gesture() : null;
  };
  els.stage.addEventListener('pointerup', end);
  els.stage.addEventListener('pointercancel', end);
  els.stage.addEventListener('wheel', e => {
    if (state.mode !== 'photo') return;
    e.preventDefault();
    const p = local(e);
    zoomPhoto(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  }, { passive: false });
}

// ---------------------------------------------------------------- reconnaissance

// En scan automatique, chaque image n'essaie qu'une stratégie de lecture (pour rester rapide),
// mais la stratégie change d'une image à l'autre et les indices s'accumulent (voir `tracker`).
const LIVE_STRATEGIES = [
  { crop: 0, passes: ['raw', 'adaptive'] },
  { crop: 0, passes: ['tight', 'inverted'] },
  { crop: 1, passes: ['raw', 'adaptive'] },
  { crop: 0, passes: ['adaptive', 'below'] },
];

/**
 * Lit la carte visée.
 * - scan normal : image la plus nette, puis tous les recadrages et toutes les variantes d'OCR si besoin ;
 * - `live` (scan automatique) : une seule stratégie, choisie par `attempt`, sans rien afficher.
 */
async function scan({ live = false, attempt = 0 } = {}) {
  if (state.busy) return null;
  state.scanCount = (state.scanCount ?? 0) + 1;
  state.busy = true;
  els.scan.disabled = true;
  els.stage.classList.add('scanning');
  try {
    if (!live) setStatus('Lecture de la carte…', 'busy');
    const T = [performance.now()];
    const cur = await grabSharpFrame(live ? 300 : 500, live ? 4 : 6);
    T.push(performance.now());
    let crops = captureCandidates(cur);
    T.push(performance.now());
    if (!crops.length) return null;
    const index = await ensureIndex();
    if (!index) return null;

    let plans;
    if (live) {
      const st = LIVE_STRATEGIES[attempt % LIVE_STRATEGIES.length];
      plans = [{ crop: crops[Math.min(st.crop, crops.length - 1)], passes: st.passes }];
    } else {
      plans = crops.map(crop => ({ crop, passes: undefined }));
    }

    let best = null;
    for (const { crop, passes } of plans) {
      const reading = await readCard(crop.card, state.lang, {
        onProgress: ocrProgress,
        isGood: text => (index.matchNames(text)[0]?.sim ?? 0) >= 0.5,
        hasNumber: text => !!parseNumber(text),
        passes,
        retryNumber: !live,
      });
      const number = parseNumber(reading.numberText);
      const cands = index.candidates({ nameText: reading.nameText, number });
      const quality = cands[0]?.score ?? 0;
      if (!best || quality > best.quality) best = { ...crop, reading, number, cands, quality };
      if (quality >= 0.45) break;
    }
    const { card, detected, reading, number } = best;
    let { cands } = best;
    T.push(performance.now());
    state.lastReading = { reading, number, detected, card, timings: T.slice(1).map((t, i) => Math.round(t - T[i])) };
    logScan({ live, cur, best, T });

    if (!cands.length) {
      if (!live) setStatus('Aucune carte reconnue. Rapprochez-vous et évitez les reflets.', 'warn', 4000);
      return null;
    }

    if (!live) setStatus('Comparaison visuelle…', 'busy');
    cands = await visualRerank(card, cands);
    const top = cands[0];
    const result = { top, alternatives: cands.slice(1, 9), confidence: confidenceOf(cands), reading, number, card, detected, cands };
    if (!live) showResult(result);
    return result;
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Erreur pendant la lecture.', 'error', 4000);
    return null;
  } finally {
    state.busy = false;
    els.scan.disabled = state.mode === 'none';
    els.stage.classList.remove('scanning');
  }
}

function showResult(result) {
  const { top, confidence } = result;
  renderResult(result, top);
  setStatus(confidence === 'high' ? `✓ ${top.card.name}` : `${top.card.name} ?`, confidence === 'high' ? 'ok' : 'warn', 2500);
  navigator.vibrate?.(confidence === 'high' ? 60 : 20);
}

async function visualRerank(card, cands) {
  const best = cands[0].score;
  const pool = cands.filter(c => c.score >= best - 0.3).slice(0, 30);
  const rest = cands.slice(pool.length);
  if (!state.visualAvailable) return cands;
  const mine = signature(card);
  const sigs = await Promise.all(pool.map(c => remoteSignature(cardImage(c.card.image))));
  if (pool.length && sigs.every(s => s === null)) {
    // Images sans CORS ou hors ligne : on se contente du texte.
    state.visualAvailable = pool.some(c => !c.card.image);
    return cands;
  }
  pool.forEach((c, i) => {
    c.visual = sigs[i] ? compareSignatures(mine, sigs[i]) : null;
    c.final = c.score + 0.3 * (c.visual ?? 0);
  });
  pool.sort((a, b) => (b.final - a.final) || (b.card.norm.length - a.card.norm.length) || (b.order - a.order));
  return [...pool, ...rest];
}

function confidenceOf(cands) {
  const [a, b] = cands;
  if (a.score >= 0.85) return 'high';
  if (a.score >= 0.5 && a.visual != null && (!b || (a.final - b.final) > 0.06) && a.visual > 0.45) return 'high';
  if (a.score >= 0.45) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------- diagnostic

const scanLog = [];

function logScan({ live, cur, best, T }) {
  const ms = T.slice(1).map((t, i) => Math.round(t - T[i]));
  scanLog.unshift({
    at: new Date().toLocaleTimeString('fr-FR'),
    mode: live ? 'auto' : 'manuel',
    ms: `${Math.round(T.at(-1) - T[0])} ms (image ${ms[0]}, cadrage ${ms[1]}, OCR ${ms[2]})`,
    sharp: Math.round(cur?.sharpness ?? -1),
    detected: best.detected,
    name: best.reading.nameText.slice(0, 120),
    num: best.reading.numberText.slice(0, 80),
    number: best.number ? `${best.number.number}/${best.number.total}` : '—',
    top: best.cands.slice(0, 3).map(c => `${c.card.name} ${c.card.id} ${c.score.toFixed(2)}`),
  });
  scanLog.length = Math.min(scanLog.length, 8);
  updateDiag();
}

function diagReport() {
  const v = els.video;
  const track = state.stream?.getVideoTracks()[0];
  const set = track?.getSettings?.() ?? {};
  const caps = track?.getCapabilities?.() ?? {};
  const lines = [
    `PokéScan — ${new Date().toLocaleString('fr-FR')}`,
    `Navigateur : ${navigator.userAgent}`,
    `Écran : ${innerWidth}×${innerHeight} @${devicePixelRatio}x · HTTPS : ${isSecureContext ? 'oui' : 'NON'}`,
    `Mode : ${state.mode} · langue : ${state.lang}`,
    `Caméra : ${v.videoWidth}×${v.videoHeight} · ${track?.label ?? '—'} · focus ${set.focusMode ?? '?'} · zoom ${set.zoom ?? '?'}` +
      ` · capacités : ${Object.keys(caps).join(', ') || '—'}`,
    `Base de cartes : ${state.index ? `${state.index.cards.length} cartes` : state.indexError ? `ERREUR ${state.indexError}` : 'chargement…'}`,
    `OCR : ${state.ocrStatus ?? '?'} · scans : ${state.scanCount ?? 0} · auto : ${els.auto.checked ? 'oui' : 'non'}`,
  ];
  const ranking = tracker.ranking().slice(0, 3);
  if (ranking.length) lines.push(`Votes : ${ranking.map(v => `${v.cand.card.name} ${v.cand.card.id} ${v.score.toFixed(2)}`).join(' | ')}`);
  for (const l of scanLog) {
    lines.push('', `[${l.at}] ${l.mode} · ${l.ms} · netteté ${l.sharp} · ${l.detected ? 'bords détectés' : 'contenu du cadre'}`,
      `  nom lu : ${l.name || '—'}`, `  bas : ${l.num || '—'} → n° ${l.number}`, `  candidats : ${l.top.join(' | ') || 'aucun'}`);
  }
  return lines.join('\n');
}

function updateDiag() {
  if (!els.diag.open) return;
  els.diagText.textContent = diagReport();
  const card = state.lastReading?.card;
  if (card) els.diagCrop.getContext('2d').drawImage(card, 0, 0, els.diagCrop.width, els.diagCrop.height);
}

// ---------------------------------------------------------------- scan automatique

/**
 * Accumule les indices de plusieurs images : chaque lecture vote pour ses meilleurs candidats,
 * les votes anciens s'estompent (si l'on change de carte). Une lecture ratée ne remet pas tout à zéro.
 */
const tracker = {
  votes: new Map(), // id → { cand, score, result, strong }
  reset() { this.votes.clear(); },
  add(result) {
    for (const v of this.votes.values()) v.score *= 0.85;
    if (!result) return;
    result.cands.slice(0, 8).forEach((c, rank) => {
      const v = this.votes.get(c.card.id) ?? { cand: c, score: 0, strong: false };
      // Poids d'une lecture : nom (1 si bien lu ; moins pour un nom court ou approximatif),
      // numéro et total du set, ressemblance visuelle avec l'image officielle
      const w = c.nameSim + (c.numMatch ? 0.5 : 0) + (c.totalMatch ? 0.3 : 0) + 0.3 * (c.visual ?? 0);
      v.score += w * (rank === 0 ? 1 : 0.8);
      v.cand = c;
      if (rank === 0) v.result = result;
      v.strong ||= c.numMatch && c.totalMatch && c.nameSim >= 0.5;
      this.votes.set(c.card.id, v);
    });
  },
  ranking() {
    return [...this.votes.values()].sort((a, b) => b.score - a.score);
  },
  /** Carte à retenir, ou null s'il faut encore des images. */
  decision() {
    const [a, ...rest] = this.ranking();
    if (!a?.result) return null;
    // Meilleur autre Pokémon (les autres éditions du même nom ne sont pas des concurrentes)
    const b = rest.find(v => v.cand.card.norm !== a.cand.card.norm);
    if (a.strong && a.score >= 1.2) return a; // nom + numéro + total lus sur une même image
    if (a.score >= 1.2 && (!b || a.score >= 1.6 * b.score)) return a;
    return null;
  },
};

function startAuto() {
  stopAuto();
  if (state.mode !== 'camera') return;
  els.auto.checked = true;
  tracker.reset();
  setStatus('Recherche d\'une carte… tenez la carte immobile dans le cadre', 'busy');
  let attempt = 0;
  const tick = async () => {
    if (!els.auto.checked || state.mode !== 'camera') return;
    const res = await scan({ live: true, attempt: attempt++ });
    if (!els.auto.checked) return;
    tracker.add(res);
    updateDiag();
    const done = tracker.decision();
    if (done) {
      els.auto.checked = false;
      const ranking = tracker.ranking();
      const result = {
        ...done.result,
        top: done.cand,
        alternatives: ranking.filter(v => v !== done).map(v => v.cand).slice(0, 8),
        confidence: done.strong || done.score >= 2 ? 'high' : 'medium',
      };
      showResult(result);
      return;
    }
    const lead = tracker.ranking()[0];
    if (lead && lead.score > 0.3) setStatus(`Lecture… ${lead.cand.card.name} ?`, 'busy');
    else if (attempt >= 6) setStatus('Toujours rien : reculez un peu si l\'image est floue, évitez les reflets sur le nom', 'warn');
    else setStatus('Recherche d\'une carte… tenez la carte immobile dans le cadre', 'busy');
    state.autoTimer = setTimeout(tick, 150);
  };
  tick();
}

function stopAuto() {
  clearTimeout(state.autoTimer);
  state.autoTimer = null;
  if (els.auto.checked) els.auto.checked = false;
}

// ---------------------------------------------------------------- affichage

const CONF_LABEL = { high: 'Carte reconnue', medium: 'Correspondance probable', low: 'Correspondance incertaine' };
const nfEur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const nfUsd = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD' });

function renderResult(result, chosen) {
  const node = els.tplResult.content.firstElementChild.cloneNode(true);
  const c = chosen.card;
  const set = chosen.set ?? state.index?.set(c.setId);

  const conf = node.querySelector('.confidence');
  if (result.confidence) {
    const level = chosen === result.top ? result.confidence : 'medium';
    conf.textContent = chosen === result.top ? CONF_LABEL[level] : 'Choix manuel';
    conf.dataset.level = level;
  } else {
    conf.remove();
  }

  fillCardBasics(node, c, set);

  // Autres possibilités
  const alts = [result.top, ...(result.alternatives ?? [])].filter(x => x && x !== chosen).slice(0, 8);
  if (alts.length) {
    node.querySelector('.alternatives').hidden = false;
    const ul = node.querySelector('.alt-list');
    for (const alt of alts) ul.append(thumb(alt.card, () => renderResult(result, alt)));
  }

  // Debug
  const dbg = node.querySelector('.debug');
  if (result.card) {
    const crop = node.querySelector('.debug-crop');
    crop.width = 189; crop.height = 264;
    crop.getContext('2d').drawImage(result.card, 0, 0, crop.width, crop.height);
    const lines = [
      `Nom lu      : ${result.reading.nameText || '—'}`,
      `Bas de carte: ${result.reading.numberText || '—'}`,
      `Cadrage     : ${result.detected ? 'bords de la carte détectés' : 'contenu du cadre'}`,
      `Numéro      : ${result.number ? `${result.number.number}/${result.number.total}` : 'non lu'}`,
      '',
      ...[result.top, ...result.alternatives].slice(0, 5).map(x =>
        `${x.card.name.padEnd(22)} ${x.card.id.padEnd(14)} texte ${x.score.toFixed(2)}` +
        (x.visual != null ? `  visuel ${x.visual.toFixed(2)}` : '')),
    ];
    node.querySelector('.debug-text').textContent = lines.join('\n');
  } else {
    dbg.remove();
  }

  els.results.replaceChildren(node);
  if (window.matchMedia('(max-width: 899px)').matches) {
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  loadDetails(node, c);
}

function fillCardBasics(node, c, set) {
  const img = node.querySelector('.result-img img');
  img.src = cardImage(c.image, 'high') ?? 'icon.svg';
  img.alt = c.name;
  img.onerror = () => { img.onerror = null; img.src = cardImage(c.image, 'low') ?? 'icon.svg'; };
  node.querySelector('.result-img').href = cardImage(c.image, 'high') ?? '#';
  node.querySelector('.card-name').textContent = c.name;
  const setEl = node.querySelector('.card-set span');
  const official = set?.cardCount?.official;
  setEl.textContent = `${set?.name ?? c.setId} · n° ${c.localId}${official ? ` / ${official}` : ''}`;
  if (set?.logo) {
    const logo = node.querySelector('.set-logo');
    logo.src = assetImage(set.logo);
    logo.hidden = false;
    logo.onerror = () => { logo.hidden = true; };
  }
  node.querySelector('.market').href =
    `https://www.cardmarket.com/fr/Pokemon/Products/Search?searchString=${encodeURIComponent(c.name)}`;
  const add = node.querySelector('.add');
  add.addEventListener('click', () => {
    addToCollection(c, set, node.dataset.price ? Number(node.dataset.price) : null);
    add.textContent = '✓ Ajoutée';
    setTimeout(() => { add.textContent = '+ Ajouter à ma collection'; }, 1500);
  });
}

async function loadDetails(node, c) {
  let d;
  try { d = await loadCard(state.lang, c.id); } catch { return; }
  if (!node.isConnected) return;
  const facts = node.querySelector('.facts');
  const rows = [
    ['Catégorie', d.category],
    ['Rareté', d.rarity],
    ['PV', d.hp],
    ['Type', d.types?.join(', ')],
    ['Stade', d.stage],
    ['Illustrateur', d.illustrator],
    ['Sortie', d.set?.releaseDate],
  ];
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    facts.append(dt, dd);
  }
  const prices = node.querySelector('.prices');
  const cm = d.pricing?.cardmarket;
  const tp = d.pricing?.tcgplayer;
  const chips = [];
  if (cm) {
    const trend = cm.trend ?? cm.avg30 ?? cm.avg;
    if (trend != null) { chips.push(['Tendance Cardmarket', nfEur.format(trend)]); node.dataset.price = trend; }
    if (cm.low != null) chips.push(['Prix bas', nfEur.format(cm.low)]);
  }
  if (tp) {
    const variant = tp.normal ?? tp.holofoil ?? tp['reverse-holofoil'] ?? Object.values(tp).find(v => v && typeof v === 'object');
    if (variant?.marketPrice != null) chips.push(['TCGplayer', nfUsd.format(variant.marketPrice)]);
  }
  for (const [label, value] of chips) {
    const span = document.createElement('span');
    span.className = 'price';
    span.innerHTML = `<small></small><b></b>`;
    span.querySelector('small').textContent = label;
    span.querySelector('b').textContent = value;
    prices.append(span);
  }
}

function thumb(card, onClick) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thumb';
  const set = state.index?.set(card.setId);
  btn.title = `${card.name} — ${set?.name ?? card.setId} ${card.localId}`;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = card.name;
  img.src = cardImage(card.image, 'low') ?? 'icon.svg';
  const cap = document.createElement('span');
  cap.textContent = `${set?.name ?? card.setId} · ${card.localId}`;
  btn.append(img, cap);
  btn.addEventListener('click', onClick);
  li.append(btn);
  return li;
}

async function manualSearch(query) {
  const index = await ensureIndex().catch(() => null);
  if (!index) return;
  const cards = index.search(query);
  const wrap = document.createElement('div');
  wrap.className = 'search-results';
  const h = document.createElement('h2');
  h.textContent = cards.length ? `Résultats pour « ${query} »` : `Aucune carte pour « ${query} »`;
  const ul = document.createElement('ul');
  ul.className = 'alt-list grid';
  for (const c of cards) {
    ul.append(thumb(c, () => renderResult({ top: null, alternatives: [] }, { card: c, set: index.set(c.setId) })));
  }
  wrap.append(h, ul);
  els.results.replaceChildren(wrap);
}

// ---------------------------------------------------------------- collection

function saveCollection() {
  store.set('pokescan.collection', state.collection);
  els.collectionCount.textContent = state.collection.reduce((n, x) => n + x.qty, 0);
}

function addToCollection(card, set, price) {
  const key = `${state.lang}:${card.id}`;
  const existing = state.collection.find(x => x.key === key);
  if (existing) {
    existing.qty++;
    if (price != null) existing.price = price;
  } else {
    state.collection.unshift({
      key, id: card.id, lang: state.lang, name: card.name, localId: card.localId,
      set: set?.name ?? card.setId, official: set?.cardCount?.official ?? null,
      image: card.image ?? null, price: price ?? null, qty: 1, addedAt: new Date().toISOString(),
    });
  }
  saveCollection();
}

function renderCollection() {
  const list = els.collectionList;
  list.replaceChildren();
  const qty = state.collection.reduce((n, x) => n + x.qty, 0);
  const value = state.collection.reduce((n, x) => n + (x.price ?? 0) * x.qty, 0);
  els.collectionSummary.textContent = qty
    ? `${qty} carte${qty > 1 ? 's' : ''} · ${state.collection.length} différente${state.collection.length > 1 ? 's' : ''}` +
      (value ? ` · valeur estimée ${nfEur.format(value)}` : '')
    : 'Aucune carte pour l\'instant. Scannez une carte puis « Ajouter à ma collection ».';
  for (const item of state.collection) {
    const li = document.createElement('li');
    li.innerHTML = `<img alt="" loading="lazy"><div class="c-info"><b></b><small></small></div>
      <div class="qty"><button type="button" data-d="-1" title="Retirer">−</button><span></span><button type="button" data-d="1" title="Ajouter">+</button></div>`;
    li.querySelector('img').src = cardImage(item.image, 'low') ?? 'icon.svg';
    li.querySelector('b').textContent = item.name;
    li.querySelector('small').textContent =
      `${item.set} · ${item.localId}${item.official ? `/${item.official}` : ''} · ${item.lang.toUpperCase()}` +
      (item.price ? ` · ${nfEur.format(item.price)}` : '');
    li.querySelector('.qty span').textContent = item.qty;
    li.querySelectorAll('.qty button').forEach(b => b.addEventListener('click', () => {
      item.qty += Number(b.dataset.d);
      if (item.qty <= 0) state.collection = state.collection.filter(x => x !== item);
      saveCollection();
      renderCollection();
    }));
    list.append(li);
  }
}

function exportCsv() {
  const head = ['Nom', 'Set', 'Numéro', 'Total', 'Langue', 'Quantité', 'Prix tendance (EUR)', 'ID TCGdex', 'Ajoutée le'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = state.collection.map(x =>
    [x.name, x.set, x.localId, x.official, x.lang, x.qty, x.price, x.id, x.addedAt].map(esc).join(';'));
  const blob = new Blob(['﻿' + [head.map(esc).join(';'), ...rows].join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `collection-pokemon-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- initialisation

function init() {
  els.lang.value = state.lang;
  saveCollection();
  layoutGuide();
  new ResizeObserver(layoutGuide).observe(els.stage);
  bindPhotoGestures();

  els.startCamera.addEventListener('click', () => startCamera());
  els.switchCamera.addEventListener('click', switchCamera);
  els.torch.addEventListener('click', toggleTorch);
  els.backToCamera.addEventListener('click', () => { state.photo = null; startCamera(); });
  els.scan.addEventListener('click', () => { stopAuto(); scan(); });
  els.auto.addEventListener('change', () => (els.auto.checked ? startAuto() : stopAuto()));
  els.file.addEventListener('change', () => { openPhoto(els.file.files[0]); els.file.value = ''; });
  els.lang.addEventListener('change', () => {
    state.lang = els.lang.value;
    store.set('pokescan.lang', state.lang);
    loadIndex(state.lang).catch(() => {});
  });
  els.searchForm.addEventListener('submit', e => {
    e.preventDefault();
    const q = els.searchInput.value.trim();
    if (q) manualSearch(q);
  });
  els.openCollection.addEventListener('click', () => { renderCollection(); els.collectionDialog.showModal(); });
  els.closeCollection.addEventListener('click', () => els.collectionDialog.close());
  els.collectionDialog.addEventListener('click', e => { if (e.target === els.collectionDialog) els.collectionDialog.close(); });
  els.exportCsv.addEventListener('click', exportCsv);
  els.diag.addEventListener('toggle', updateDiag);
  setInterval(updateDiag, 1500);
  els.diagCopy.addEventListener('click', async () => {
    const text = diagReport();
    try { await navigator.clipboard.writeText(text); els.diagCopy.textContent = '✓ Copié'; } catch {
      // Presse-papiers refusé : on sélectionne le texte pour une copie manuelle
      getSelection().selectAllChildren(els.diagText);
      els.diagCopy.textContent = 'Sélectionné : copiez-le';
    }
    setTimeout(() => { els.diagCopy.textContent = 'Copier le rapport'; }, 2000);
  });
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.target.closest('input, select, textarea, button, dialog')) {
      e.preventDefault();
      scan();
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAuto(); });

  loadIndex(state.lang).catch(() => {});

  // Démarre directement la caméra si l'autorisation a déjà été accordée
  navigator.permissions?.query({ name: 'camera' })
    .then(p => { if (p.state === 'granted') startCamera(); })
    .catch(() => {});
  if (!navigator.mediaDevices?.getUserMedia) startCamera();
}

// Exposé pour le débogage dans la console
window.pokescan = { state, scan, openPhoto, normalize };

init();
