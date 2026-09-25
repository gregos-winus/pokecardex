// Lecture du nom et du numéro d'une carte avec Tesseract.js (exécuté dans le navigateur).
import { ZONES, extractZone } from './vision.js';

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

// Variantes de lecture du nom, de la plus rentable à la moins rentable (mesuré sur de vraies photos)
const NAME_PASSES = [
  card => [extractZone(card, ZONES.name, 2), 6],
  card => [rawZone(card, ZONES.name, 2), 11],
  card => [extractZone(card, ZONES.name, 2, true), 11], // texte clair sur fond sombre
];

/**
 * Lit les zones de texte d'une carte déjà recadrée (630×880).
 * Le nom est relu avec d'autres réglages tant que `isGood(texteCumulé)` est faux.
 */
export async function readCard(card, lang, { onProgress, isGood, hasNumber, maxPasses = NAME_PASSES.length } = {}) {
  const w = await getWorker(lang, onProgress);
  const texts = [];
  let nameCanvas = null;
  for (const pass of NAME_PASSES.slice(0, maxPasses)) {
    const [canvas, psm] = pass(card);
    nameCanvas ??= canvas;
    texts.push((await recognize(w, canvas, psm)).text);
    if (isGood?.(texts.join(' | '))) break;
  }
  const numberCanvas = extractZone(card, ZONES.number, 3);
  let numberText = (await recognize(w, numberCanvas, 11)).text;
  if (!hasNumber?.(numberText)) numberText += ' | ' + (await recognize(w, rawZone(card, ZONES.number, 3), 11)).text;
  return { nameText: texts.join(' | '), numberText, nameCanvas, numberCanvas, passes: texts.length };
}
