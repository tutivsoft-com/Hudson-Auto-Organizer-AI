export function isNearVerbatimDuplicate(first: string, second: string): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const firstWords = normalize(first);
  const secondWords = normalize(second);
  const firstSet = new Set(firstWords);
  const secondSet = new Set(secondWords);
  if (!firstSet.size || !secondSet.size) return false;
  if (first.toLocaleLowerCase().replace(/\s+/g, " ").trim() === second.toLocaleLowerCase().replace(/\s+/g, " ").trim()) return true;
  let intersection = 0;
  for (const word of firstSet) if (secondSet.has(word)) intersection += 1;
  const union = new Set([...firstSet, ...secondSet]).size;
  return Math.min(firstSet.size, secondSet.size) >= 8 && union > 0 && intersection / union >= 0.95;
}
