// Rapprochement entre le texte lu par l'OCR et la base de cartes TCGdex.

export function normalize(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - levenshtein(a, b) / max : 1;
}

// Mots du bandeau de titre qui ne font jamais partie du nom : PV/HP, catégorie, stade d'évolution
const NOISE_TOKENS = new Set([
  'pv', 'hp', 'kp', 'ps',
  'dresseur', 'trainer', 'supporter', 'objet', 'item', 'stade', 'stadium', 'outil', 'tool',
  'base', 'basic', 'niveau', 'stage', 'phase',
]);

// « Evolves from Charmeleon », « Évolution de Riolu »… : le mot suivant est le nom d'un AUTRE Pokémon
const EVOLVES_FROM = [['evolves', 'from'], ['evolution', 'de'], ['entwickelt', 'sich', 'aus'], ['evoluciona', 'de'], ['evolve', 'da'], ['evolui', 'de']];

export function nameTokens(ocrText) {
  const tokens = normalize(ocrText).split(' ');
  for (const seq of EVOLVES_FROM) {
    for (let i = 0; i + seq.length < tokens.length; i++) {
      if (seq.every((w, j) => tokens[i + j] === w)) tokens[i + seq.length] = '';
    }
  }
  return tokens.filter(t => t && !NOISE_TOKENS.has(t) && !/^\d+$/.test(t));
}

// Meilleure correspondance entre un nom de carte et une fenêtre de mots consécutifs du texte OCR.
// Renvoie la similarité et le nombre d'erreurs (distance d'édition).
function nameMatch(target, targetWords, tokens) {
  let best = { sim: 0, errors: target.length };
  for (let k = Math.max(1, targetWords - 1); k <= targetWords + 1; k++) {
    for (let i = 0; i + k <= tokens.length; i++) {
      const w = tokens.slice(i, i + k).join('');
      if (Math.abs(w.length - target.length) > Math.max(2, target.length * 0.4)) continue;
      const errors = levenshtein(w, target);
      const sim = 1 - errors / Math.max(w.length, target.length);
      if (sim > best.sim) best = { sim, errors };
    }
  }
  // Nom collé à d'autres mots par l'OCR (« BASEPikachu »)
  if (best.sim < 0.95 && target.length >= 5 && tokens.some(t => t.length > target.length && t.includes(target))) {
    best = { sim: 0.95, errors: 0 };
  }
  return best;
}

// Score d'un nom : similarité pondérée par le nombre de lettres effectivement reconnues.
// Un nom court (« Mew », « Abo ») ressemble trop facilement à du bruit d'OCR.
function nameScore(target, m) {
  return m.sim * Math.min(1, (target.length - m.errors) / 6);
}

// Extrait « 025/198 » (numéro / total officiel du set) du texte du bas de carte.
export function parseNumber(ocrText) {
  const text = String(ocrText ?? '')
    .replace(/[Oo]/g, '0')
    .replace(/[Il|!\]]/g, '1')
    .replace(/[⁄∕\\]/g, '/');
  const re = /(\d{1,4})\s*\/\s*(\d{2,3})(?!\d)/g;
  const found = [];
  let m;
  while ((m = re.exec(text))) {
    let n = parseInt(m[1].slice(-3), 10);
    const t = parseInt(m[2], 10);
    if (t < 10 || n === 0 || n > t + 200) continue;
    found.push({ number: n, total: t });
  }
  return found[0] ?? null;
}

// Sets de Pokémon TCG Pocket (jeu mobile) : aucune carte physique
const POCKET_SET = /^(?:[AB]\d+[a-z]?|P-[AB])$/;

export class CardIndex {
  constructor(cards, sets) {
    this.sets = new Map();
    sets.forEach((s, i) => { if (!POCKET_SET.test(s.id)) this.sets.set(s.id, { ...s, order: i }); });
    this.cards = cards.map(c => {
      const setId = c.id.slice(0, c.id.length - String(c.localId).length - 1);
      const norm = normalize(c.name);
      return {
        ...c,
        setId,
        norm,
        num: /^\d+[a-z]?$/i.test(c.localId) ? parseInt(c.localId, 10) : null,
      };
    }).filter(c => !POCKET_SET.test(c.setId));
    this.byName = new Map();
    for (const c of this.cards) {
      if (!c.norm) continue;
      if (!this.byName.has(c.norm)) this.byName.set(c.norm, []);
      this.byName.get(c.norm).push(c);
    }
    this.names = [...this.byName.keys()].map(n => ({
      norm: n,
      compact: n.replace(/ /g, ''),
      words: n.split(' ').length,
    }));
    this.byId = new Map(this.cards.map(c => [c.id, c]));
  }

  set(id) {
    return this.sets.get(id);
  }

  matchNames(ocrText) {
    const tokens = nameTokens(ocrText);
    if (!tokens.length) return [];
    const out = [];
    for (const n of this.names) {
      const m = nameMatch(n.compact, n.words, tokens);
      if (m.sim < 0.6) continue;
      const score = nameScore(n.compact, m);
      if (score >= 0.45) out.push({ norm: n.norm, sim: score });
    }
    // À similarité égale, on préfère le nom le plus long (« Pikachu V » plutôt que « Pikachu »)
    out.sort((a, b) => (b.sim - a.sim) || (b.norm.length - a.norm.length));
    return out;
  }

  /**
   * @param {{nameText: string, number: {number:number,total:number}|null}} reading
   * @returns liste de candidats triés { card, score, nameSim, numMatch, totalMatch }
   */
  candidates(reading) {
    const names = this.matchNames(reading.nameText);
    const bestSim = names[0]?.sim ?? 0;
    const nameSims = new Map();
    for (const n of names) {
      if (n.sim >= Math.max(0.5, bestSim - 0.12)) nameSims.set(n.norm, n.sim);
    }

    const pool = new Map();
    for (const norm of nameSims.keys()) {
      for (const c of this.byName.get(norm)) pool.set(c.id, c);
    }
    const num = reading.number;
    if (num) {
      for (const c of this.cards) {
        if (c.num !== num.number) continue;
        const set = this.sets.get(c.setId);
        if (set && (set.cardCount?.official === num.total || set.cardCount?.total === num.total)) pool.set(c.id, c);
      }
    }

    const scored = [];
    for (const c of pool.values()) {
      const set = this.sets.get(c.setId);
      const nameSim = nameSims.get(c.norm) ?? 0;
      const numMatch = !!num && c.num === num.number;
      const totalMatch = !!num && !!set &&
        (set.cardCount?.official === num.total || set.cardCount?.total === num.total);
      // Un nom à moitié lu compte peu (carré) ; numéro + total ensemble désignent presque une carte unique
      // Un nom à moitié lu compte peu (carré) : numéro + total bien lus doivent pouvoir l'emporter
      const score = 0.55 * nameSim * nameSim + 0.3 * (numMatch ? 1 : 0) + 0.15 * (totalMatch ? 1 : 0);
      scored.push({ card: c, set, score, nameSim, numMatch, totalMatch, order: set?.order ?? 0 });
    }
    // Score, puis longueur du nom, puis les sets les plus récents d'abord
    scored.sort((a, b) => (b.score - a.score) || (b.card.norm.length - a.card.norm.length) || (b.order - a.order));
    return scored;
  }

  search(query, limit = 60) {
    const q = normalize(query);
    if (!q) return [];
    const compact = q.replace(/ /g, '');
    const hits = [];
    for (const n of this.names) {
      let s;
      if (n.norm.startsWith(q)) s = 2;
      else if (n.norm.includes(q)) s = 1.5;
      else s = similarity(n.compact, compact);
      if (s >= 0.7) hits.push({ norm: n.norm, s });
    }
    hits.sort((a, b) => (b.s - a.s) || a.norm.length - b.norm.length);
    const cards = [];
    for (const h of hits) {
      const list = [...this.byName.get(h.norm)]
        .sort((a, b) => (this.sets.get(b.setId)?.order ?? 0) - (this.sets.get(a.setId)?.order ?? 0));
      for (const c of list) {
        cards.push(c);
        if (cards.length >= limit) return cards;
      }
    }
    return cards;
  }
}
