const MANAGED_KEY_PASSPHRASE = "Hudson.AutoOrganizerAI.RemoteKey.v1.2026-11-01";

export interface EncryptedEnvelope { q: number; x: string; w: string; n: number; a: string; b: string; c: string; d: string; }

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const output = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) output[i] = binary.charCodeAt(i);
  return output;
}

export async function decryptManagedKeyEnvelope(envelope: EncryptedEnvelope): Promise<string> {
  if (envelope.x !== "AES-256-GCM" || envelope.w !== "PBKDF2-HMAC-SHA256" || envelope.n !== 210000) throw new Error("AI service setup is unavailable.");
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(MANAGED_KEY_PASSPHRASE), { name: "PBKDF2" }, false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: decodeBase64(envelope.a), iterations: envelope.n, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const ciphertext = decodeBase64(envelope.c);
  const tag = decodeBase64(envelope.d);
  const joined = new Uint8Array(new ArrayBuffer(ciphertext.length + tag.length));
  joined.set(ciphertext);
  joined.set(tag, ciphertext.length);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64(envelope.b) }, key, joined);
  return new TextDecoder().decode(plaintext).trim();
}
