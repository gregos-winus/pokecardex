// Lecture du nom et du numéro d'une carte avec Tesseract.js (exécuté dans le navigateur).
import { ZONES, extractZone, adaptiveThreshold } from './vision.js';

const TESS_LANG = { fr: 'fra', en: 'eng', de: 'deu', es: 'spa', it: 'ita', pt: 'por' };

let worker = null;
let workerLang = null;
let pending = null;

export async function getWorker(lang, onProgress) {
  const tl = TESS_LANG[lang] ?? 'eng';
  if (worker && workerLang === tl) return worker;
  if (pending) await pending.catch(() => {});
  if (worker && workerLang === tl) return worker;
  if (worker) { await worker.terminate(); worker = null; }
  if (!window.Tesseract) throw new Error('Tesseract.js n\'a pas pu être chargé (vérifiez la connexion).');
  pending = (async () => {
    // Le nom est souvent en français ET le numéro/les codes en caractères latins simples :
    // la langue anglaise en complément améliore la lecture des suffixes (V, VMAX, ex, GX).
    const langs = tl === 'eng' ? 'eng' : `${tl}+eng`;
    const w = await window.Tesseract.createWorker(langs, 1, {
      logger: m => onProgress?.(m),
    });
    await w.setParameters({ user_defined_dpi: '300', preserve_interword_spaces: '1' });
    worker = w;
    workerLang = tl;
    return w;
  })();
  try { return await pending; } finally { pending = null; }
}

async function recognize(w, canvas, psm) {
  await w.setParameters({ tessedit_pageseg_mode: String(psm) });
  const { data } = await w.recognize(canvas);
  return { text: (data.text || '').replace(/\s+/g, ' ').trim(), confidence: data.confidence ?? 0 };
}

// Copie brute (couleur, sans retouche) d'une zone : sert de 2e essai à l'OCR
function rawZone(card, zone, scale) {
  const out = document.createElement('canvas');
  out.width = Math.round(card.width * zone.w * scale);
  out.height = Math.round(card.height * zone.h * scale);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(card, zone.x * card.width, zone.y * card.height, zone.w * card.width, zone.h * card.height, 0, 0, out.width, out.height);
  return out;
}

// Variantes de lecture du nom, dans l'ordre de rentabilité mesuré sur 66 vraies photos
export const NAME_PASSES = {
  raw: card => [rawZone(card, ZONES.name, 2), 11], // couleur brute
  adaptive: card => [adaptiveThreshold(extractZone(card, ZONES.name, 2)), 6], // binarisation locale
  tight: card => [extractZone(card, ZONES.nameTight, 3), 11], // nom seul, sans les PV
  inverted: card => [extractZone(card, ZONES.name, 2, true), 11], // texte clair sur fond sombre
  below: card => [extractZone(card, ZONES.nameBelow, 2), 11], // nom sous un bandeau (anciennes cartes Dresseur)
};
const ALL_PASSES = ['raw', 'adaptive', 'tight', 'inverted', 'below'];

// Bandeau « TRAINER » des anciennes cartes Dresseur : le nom est juste en dessous
const BANNER = /tra[il1]n[eo]r|dresseur|entrenador|allenatore|treinador/i;

/**
 * Lit les zones de texte d'une carte déjà recadrée (630×880).
 * Le nom est relu avec les variantes `passes` (dans l'ordre) tant que `isGood(texteCumulé)` est faux.
 */
export async function readCard(card, lang, { onProgress, isGood, hasNumber, passes = ALL_PASSES, retryNumber = true } = {}) {
  const w = await getWorker(lang, onProgress);
  const texts = [];
  let nameCanvas = null;
  const queue = [...passes];
  while (queue.length) {
    const name = queue.shift();
    const [canvas, psm] = NAME_PASSES[name](card);
    nameCanvas ??= canvas;
    const text = (await recognize(w, canvas, psm)).text;
    texts.push(text);
    if (isGood?.(texts.join(' | '))) break;
    if (BANNER.test(text) && !passes.includes('below') && !queue.includes('below')) queue.unshift('below');
  }
  const numberCanvas = extractZone(card, ZONES.number, 3);
  let numberText = (await recognize(w, numberCanvas, 11)).text;
  if (retryNumber && !hasNumber?.(numberText)) numberText += ' | ' + (await recognize(w, rawZone(card, ZONES.number, 3), 11)).text;
  return { nameText: texts.join(' | '), numberText, nameCanvas, numberCanvas, passes: texts.length };
}
