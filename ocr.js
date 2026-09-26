// Lecture du nom et du numéro d'une carte avec Tesseract.js (exécuté dans le navigateur).
import { ZONES, enhance, adaptiveThreshold, makeCanvas } from './vision.js';
import { normalize, levenshtein } from './matcher.js';

const TESS_LANG = { fr: 'fra', en: 'eng', de: 'deu', es: 'spa', it: 'ita', pt: 'por' };

// Deux lecteurs OCR : le nom et le numéro sont lus en parallèle (téléphones multicœurs).
// Une seule langue par lecteur : ajouter l'anglais doublait le temps de lecture sans gain mesuré.
let workers = null;
let workersLang = null;
let pending = null;

export async function getWorkers(lang, onProgress) {
  const tl = TESS_LANG[lang] ?? 'eng';
  if (workers && workersLang === tl) return workers;
  if (pending) await pending.catch(() => {});
  if (workers && workersLang === tl) return workers;
  if (workers) { await Promise.all(workers.map(w => w.terminate())); workers = null; }
  if (!window.Tesseract) throw new Error('Tesseract.js n\'a pas pu être chargé (vérifiez la connexion).');
  pending = (async () => {
    const make = async log => {
      const w = await window.Tesseract.createWorker(tl, 1, { logger: log ? m => onProgress?.(m) : undefined });
      await w.setParameters({ user_defined_dpi: '300', preserve_interword_spaces: '1' });
      return w;
    };
    // Le premier télécharge le modèle ; le second le reprend du cache du navigateur
    const first = await make(true);
    const second = await make(false);
    workers = [first, second];
    workersLang = tl;
    return workers;
  })();
  try { return await pending; } finally { pending = null; }
}

async function recognize(w, canvas, psm) {
  await w.setParameters({ tessedit_pageseg_mode: String(psm) });
  const { data } = await w.recognize(canvas);
  return (data.text || '').replace(/\s+/g, ' ').trim();
}

const NAME_SCALE = 1.5; // ×2 n'apportait rien de mesurable et coûtait ~30 % de temps

// Variantes de lecture du nom, dans l'ordre de rentabilité mesuré sur 66 vraies photos.
// `s` est une source de zones (voir cardSampler / canvasSampler dans vision.js).
export const NAME_PASSES = {
  raw: s => [s.zone(ZONES.name, NAME_SCALE), 11], // couleur brute
  adaptive: s => [adaptiveThreshold(enhance(s.zone(ZONES.name, NAME_SCALE))), 6], // binarisation locale
  tight: s => [enhance(s.zone(ZONES.nameTight, 2)), 11], // nom seul, sans les PV
  inverted: s => [enhance(s.zone(ZONES.name, NAME_SCALE), true), 11], // texte clair sur fond sombre
  below: s => [enhance(s.zone(ZONES.nameBelow, NAME_SCALE)), 11], // nom sous un bandeau (anciennes cartes Dresseur)
};
const ALL_PASSES = ['raw', 'adaptive', 'tight', 'inverted', 'below'];

// Bandeau « TRAINER » des anciennes cartes Dresseur : le nom est juste en dessous.
// Tolérant aux erreurs de lecture (« TOOINEDR », « 1RIINGR »…).
const BANNER_WORDS = ['trainer', 'dresseur', 'entrenador', 'allenatore', 'treinador'];
const hasBanner = text => normalize(text).split(' ').some(t =>
  t.length >= 5 && BANNER_WORDS.some(b => Math.abs(t.length - b.length) <= 2 && levenshtein(t, b) <= 3));

/** Les deux coins du bas (numéro à gauche ou à droite selon l'époque), empilés en une seule image. */
function numberImage(s) {
  const left = enhance(s.zone(ZONES.numberLeft, 2.5));
  const right = enhance(s.zone(ZONES.numberRight, 2.5));
  const gap = 16;
  const out = makeCanvas(Math.max(left.width, right.width), left.height + right.height + gap);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(left, 0, 0);
  ctx.drawImage(right, 0, left.height + gap);
  return out;
}

async function readName(w, s, passes, isGood) {
  const texts = [];
  let nameCanvas = null;
  const queue = [...passes];
  while (queue.length) {
    const name = queue.shift();
    const [canvas, psm] = NAME_PASSES[name](s);
    nameCanvas ??= canvas;
    const text = await recognize(w, canvas, psm);
    texts.push(text);
    if (isGood?.(texts.join(' | '))) break;
    if (hasBanner(text) && !passes.includes('below') && !queue.includes('below')) queue.unshift('below');
  }
  return { nameText: texts.join(' | '), nameCanvas, passes: texts.length };
}

/**
 * Lit le nom et le numéro d'une carte.
 * @param s source de zones (cardSampler ou canvasSampler)
 * Le nom est relu avec les variantes `passes` (dans l'ordre) tant que `isGood(texteCumulé)` est faux.
 */
export async function readCard(s, lang, { onProgress, isGood, hasNumber, passes = ALL_PASSES, retryNumber = true } = {}) {
  const [w1, w2] = await getWorkers(lang, onProgress);
  const numberCanvas = numberImage(s);
  const readNumber = async () => {
    let text = await recognize(w2, numberCanvas, 6);
    if (retryNumber && !hasNumber?.(text)) text += ' | ' + await recognize(w2, numberCanvas, 11);
    return text;
  };
  const [name, numberText] = await Promise.all([readName(w1, s, passes, isGood), readNumber()]);
  return { ...name, numberText, numberCanvas };
}
