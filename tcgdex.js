// Accès à l'API publique TCGdex (https://tcgdex.dev), multilingue.

const API = 'https://api.tcgdex.net/v2';
const CACHE_NAME = 'pokescan-data-v1';
const MAX_AGE = 3 * 24 * 3600 * 1000;

async function cachedJson(url, maxAge = MAX_AGE) {
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit && Date.now() - Number(hit.headers.get('x-cached-at')) < maxAge) {
      return await hit.json();
    }
  } catch { /* Cache Storage indisponible (contexte non sécurisé, navigation privée…) */ }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`TCGdex a répondu ${res.status} pour ${url}`);
  const body = await res.text();
  if (cache) {
    cache.put(url, new Response(body, {
      headers: { 'content-type': 'application/json', 'x-cached-at': String(Date.now()) },
    })).catch(() => {});
  }
  return JSON.parse(body);
}

export function loadSets(lang) {
  return cachedJson(`${API}/${lang}/sets`);
}

export function loadCards(lang) {
  return cachedJson(`${API}/${lang}/cards`);
}

export function loadCard(lang, id) {
  return cachedJson(`${API}/${lang}/cards/${encodeURIComponent(id)}`);
}

// Les URL d'images TCGdex sont fournies sans qualité ni extension.
export function cardImage(base, quality = 'low') {
  return base ? `${base}/${quality}.webp` : null;
}

export function assetImage(base) {
  return base ? `${base}.webp` : null;
}
