export const LOG_LIMIT = 1000;
export const LOG_BYTES = 256 * 1024;
type Detail = Record<string, string | number>;
export interface LogEntry { at: string; session: string; version: string; level: string; event: string; detail: Detail; }
export interface LogStorage {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number } | null>;
  read(path: string): Promise<string>;
  write(path: string, value: string): Promise<void>;
}
const numbers = new Set(["httpStatus", "elapsedMs", "count", "span", "selected", "applied", "failed", "files", "lines", "batch"]);
const choices: Record<string, Set<string>> = {
  provider: new Set(["openai", "openrouter"]),
  operation: new Set(["classify", "embeddings", "routing", "reserve", "settle", "release", "recover", "preview", "apply", "split", "undo", "report", "manual", "append", "move", "trash", "capsule", "archive"]),
  status: new Set(["started", "completed", "failed", "stopped", "cancelled", "pending", "reserved", "released", "committed", "denied"]),
  errorType: new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "NetworkError", "TimeoutError"])
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const version = /^\d+\.\d+\.\d+$/;

export function safeDetail(value: unknown): Detail {
  if (!value || typeof value !== "object") return {};
  const fields = value as Record<string, unknown>;
  const isError = Object.prototype.toString.call(value) === "[object Error]";
  const output: Detail = {};
  for (const key of [...numbers, ...Object.keys(choices), "version", "runId"]) {
    const item = isError && key === "errorType" ? fields.name : isError && key === "httpStatus" ? fields.httpStatus ?? fields.status : fields[key];
    if (numbers.has(key) && typeof item === "number" && Number.isFinite(item) && item >= 0) output[key] = item;
    else if (typeof item === "string" && (choices[key]?.has(item) || key === "version" && version.test(item) || key === "runId" && uuid.test(item))) output[key] = item;
  }
  return output;
}

export class DiagnosticLog {
  private entries: LogEntry[] = [];
  private dropped = 0;
  private revision = 0;
  private savedRevision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private closed = false;
  private storageStatus = "pending";
  private readonly ready: Promise<void>;
  private readonly session = crypto.randomUUID();

  constructor(private readonly plugin: string, private readonly appVersion: string, readonly path: string, private readonly storage: LogStorage) {
    this.ready = this.restore();
  }

  private async restore(): Promise<void> {
    try {
      if (!await this.storage.exists(this.path)) return;
      if ((await this.storage.stat(this.path))!.size > LOG_BYTES) throw new Error("Log exceeds the size limit");
      const data = JSON.parse(await this.storage.read(this.path));
      if (data.format !== 1 || data.plugin !== this.plugin || !Array.isArray(data.entries)) throw new Error("Invalid log format");
      const previous: LogEntry[] = [];
      for (const entry of data.entries.slice(-LOG_LIMIT)) {
        if (!entry || typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at)) || !uuid.test(entry.session) || !version.test(entry.version) || !["info", "warn", "error"].includes(entry.level)) continue;
        previous.push({ at: new Date(entry.at).toISOString(), session: entry.session, version: entry.version, level: entry.level,
          event: this.eventName(entry.event), detail: safeDetail(entry.detail) });
      }
      this.entries = [...previous, ...this.entries];
      this.dropped += Number.isSafeInteger(data.dropped) && data.dropped >= 0 ? data.dropped : 0;
      this.trim();
    } catch { this.record("warn", "log.restore_failed"); }
  }

  private eventName(value: unknown): string {
    return typeof value === "string" && /^[a-z0-9_.]{1,96}$/i.test(value) ? value : "event.omitted";
  }

  record(level: "info" | "warn" | "error", event: string, detail?: unknown): void {
    if (this.closed) return;
    this.entries.push({ at: new Date().toISOString(), session: this.session, version: this.appVersion, level, event: this.eventName(event), detail: safeDetail(detail) });
    this.revision++;
    this.trim();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 250);
  }

  private trim(): void {
    if (this.entries.length > LOG_LIMIT) this.dropped += this.entries.splice(0, this.entries.length - LOG_LIMIT).length;
  }

  private serialize(): string {
    let result = "";
    do {
      result = JSON.stringify({ format: 1, plugin: this.plugin, version: this.appVersion, dropped: this.dropped, entries: this.entries });
      if (new TextEncoder().encode(result).byteLength <= LOG_BYTES) return result;
      const count = Math.max(1, Math.ceil(this.entries.length / 10));
      this.entries.splice(0, count); this.dropped += count;
    } while (this.entries.length);
    return result;
  }

  async export(): Promise<string> {
    await this.ready;
    return JSON.stringify({ ...JSON.parse(this.serialize()), storageStatus: this.storageStatus }, null, 2);
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.ready;
    if (this.writing) { await this.writing; return; }
    this.writing = (async () => {
      while (this.savedRevision < this.revision) {
        const revision = this.revision;
        try {
          await this.storage.write(this.path, this.serialize());
          this.savedRevision = revision;
          this.storageStatus = "saved";
        } catch { this.storageStatus = "failed"; break; }
      }
    })();
    try { await this.writing; } finally { this.writing = undefined; }
  }

  async close(): Promise<void> { await this.ready; this.closed = true; await this.flush(); }
}
