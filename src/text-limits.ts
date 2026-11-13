export function firstWords(value: string, count = 200): string {
  return value.trim().split(/\s+/u).slice(0, Math.max(0, count)).join(" ");
}
