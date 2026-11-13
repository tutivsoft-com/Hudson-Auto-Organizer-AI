import { requestUrl } from "obsidian";
import { diagnostics } from "./diagnostics";
import { open } from "node:fs/promises";
import { aiRequest, AiProvider, providerName } from "./ai-provider";

export interface DuplicatePair {
  firstIndex: number;
  secondIndex: number;
  similarity: number;
}

export interface CandidatePair {
  firstIndex: number;
  secondIndex: number;
}

export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_BATCH_SIZE = 32;
const DUPLICATE_THRESHOLD = 0.95;
const LOCAL_CANDIDATE_THRESHOLD = 0.3;
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "been", "being", "between", "both", "could", "does", "doing", "down",
  "each", "from", "have", "here", "into", "just", "more", "most", "other", "over", "same", "some", "such",
  "than", "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "under",
  "very", "were", "what", "when", "where", "which", "while", "will", "with", "would", "your"
]);

export async function readFirstWordsFromDisk(path: string, count = 200): Promise<string> {
  const handle = await open(path, "r");
  const decoder = new TextDecoder();
  const oneByte = new Uint8Array(1);
  let position = 0;
  let words = 0;
  let insideWord = false;
  let text = "";

  try {
    while (words < count || insideWord) {
      const { bytesRead } = await handle.read(oneByte, 0, 1, position++);
      if (!bytesRead) break;
      const decoded = decoder.decode(oneByte.subarray(0, bytesRead), { stream: true });
      if (!decoded) continue;
      text += decoded;

      for (const character of decoded) {
        if (/\s/u.test(character)) {
          if (words >= count) return text.trim();
          insideWord = false;
        } else if (!insideWord) {
          words += 1;
          insideWord = true;
        }
      }
    }
    return text.trim();
  } finally {
    await handle.close();
  }
}

export function findLikelyDuplicatePairs(excerpts: string[]): CandidatePair[] {
  const normalized = excerpts.map((text) => text.toLocaleLowerCase().replace(/\s+/g, " ").trim());
  const tokens = normalized.map((text) => (text.match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((token) => !STOP_WORDS.has(token)));
  const termCounts = tokens.map((terms) => {
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    return counts;
  });
  const documentFrequency = new Map<string, number>();
  for (const counts of termCounts) {
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const vectors = termCounts.map((counts) => {
    const vector = new Map<string, number>();
    for (const [term, frequency] of counts) {
      const inverseFrequency = Math.log(1 + excerpts.length / (documentFrequency.get(term) ?? 1));
      vector.set(term, frequency * inverseFrequency);
    }
    return vector;
  });

  const pairs: CandidatePair[] = [];
  for (let firstIndex = 0; firstIndex < excerpts.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < excerpts.length; secondIndex += 1) {
      if (normalized[firstIndex] && normalized[firstIndex] === normalized[secondIndex]) {
        pairs.push({ firstIndex, secondIndex });
        continue;
      }
      if (weightedTokenSimilarity(vectors[firstIndex], vectors[secondIndex]) >= LOCAL_CANDIDATE_THRESHOLD) {
        pairs.push({ firstIndex, secondIndex });
      }
    }
  }
  return pairs;
}

export async function findDuplicatePairs(
  apiKey: string,
  excerpts: string[],
  candidates: CandidatePair[],
  model: string | undefined = undefined,
  stopped: () => boolean = () => false,
  provider: AiProvider = "openai"
): Promise<DuplicatePair[]> {
  const fileIndices = [...new Set(candidates.flatMap((pair) => [pair.firstIndex, pair.secondIndex]))].sort((a, b) => a - b);
  const embeddings = new Map<number, number[]>();

  for (let start = 0; start < fileIndices.length; start += EMBEDDING_BATCH_SIZE) {
    if (stopped()) return [];
    const indices = fileIndices.slice(start, start + EMBEDDING_BATCH_SIZE);
    const batch = indices.map((index) => excerpts[index]);
    const params = aiRequest(provider, apiKey, "embeddings", { model: model || (provider === "openai" ? "text-embedding-3-small" : DEFAULT_EMBEDDING_MODEL), input: batch, encoding_format: "float" });
    diagnostics.event("ai.embedding_batch", { provider, count: batch.length, batch: Math.floor(start / EMBEDDING_BATCH_SIZE) + 1 });
    const response = await diagnostics.request("network.ai.embeddings", requestUrl, params);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${providerName(provider)} returned HTTP ${response.status} while embedding notes.`);
    }

    const payload = response.json as { data?: Array<{ index?: number; embedding?: number[] }> };
    const data = payload.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error(`${providerName(provider)} returned an incomplete embedding batch.`);
    }
    for (const item of data) {
      if (!Array.isArray(item.embedding) || item.embedding.length === 0 || typeof item.index !== "number" || item.index < 0 || item.index >= batch.length) {
        throw new Error(`${providerName(provider)} returned an invalid note embedding.`);
      }
      embeddings.set(indices[item.index], item.embedding);
    }
  }

  const pairs: DuplicatePair[] = [];
  for (const candidate of candidates) {
    const first = embeddings.get(candidate.firstIndex);
    const second = embeddings.get(candidate.secondIndex);
    if (!first || !second) throw new Error(`${providerName(provider)} did not return an embedding for a candidate note.`);
    const similarity = cosineSimilarity(first, second);
    if (similarity > DUPLICATE_THRESHOLD) pairs.push({ ...candidate, similarity });
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

function weightedTokenSimilarity(first: Map<string, number>, second: Map<string, number>): number {
  if (!first.size || !second.size) return 0;
  let dot = 0;
  let firstNorm = 0;
  let secondNorm = 0;
  for (const weight of first.values()) firstNorm += weight * weight;
  for (const weight of second.values()) secondNorm += weight * weight;
  for (const [term, weight] of first) dot += weight * (second.get(term) ?? 0);
  if (firstNorm === 0 || secondNorm === 0) return 0;
  return dot / Math.sqrt(firstNorm * secondNorm);
}

function cosineSimilarity(first: number[], second: number[]): number {
  if (first.length !== second.length) throw new Error("AI returned embeddings with different dimensions.");
  let dot = 0;
  let firstNorm = 0;
  let secondNorm = 0;
  for (let index = 0; index < first.length; index += 1) {
    dot += first[index] * second[index];
    firstNorm += first[index] * first[index];
    secondNorm += second[index] * second[index];
  }
  if (firstNorm === 0 || secondNorm === 0) return 0;
  return dot / Math.sqrt(firstNorm * secondNorm);
}
