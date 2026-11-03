import candidates from './word-candidates.json';

export const WORD_POOLS = candidates;

export function drawRandomGenre() {
  const genres = Object.keys(WORD_POOLS);
  const index = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % genres.length;
  return genres[index];
}

export function drawWords(genre, count) {
  const pool = WORD_POOLS[genre];
  if (!pool || pool.length < count) throw new Error('このジャンルの候補ワードが足りません。');
  const picked = new Set();
  const crypto = globalThis.crypto;
  while (picked.size < count) {
    const index = crypto.getRandomValues(new Uint32Array(1))[0] % pool.length;
    picked.add(pool[index]);
  }
  return [...picked];
}
