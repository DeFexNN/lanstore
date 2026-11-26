import fsp from 'node:fs/promises';
import path from 'node:path';

/** Append-only JSONL activity log with size-based rotation. */
export class Audit {
  constructor({ file, enabled = true, tailBytes = 512 * 1024, maxBytes = 32 * 1024 * 1024, backups = 3 } = {}) {
    this.file = file;
    this.enabled = enabled;
    this.tailBytes = tailBytes;
    this.maxBytes = Number(maxBytes) || 0;
    this.backups = Math.max(1, Number(backups) || 3);
    this.chain = Promise.resolve();
    this.writes = 0;
  }

  log(event) {
    if (!this.enabled || !this.file) return Promise.resolve();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    this.chain = this.chain
      .then(async () => {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.appendFile(this.file, line);
        if (this.maxBytes > 0 && ++this.writes % 25 === 0) {
          await this._rotateIfNeeded().catch(() => {});
        }
      })
      .catch(() => {});
    return this.chain;
  }

  async _rotateIfNeeded() {
    let stat;
    try {
      stat = await fsp.stat(this.file);
    } catch {
      return;
    }
    if (stat.size < this.maxBytes) return;

    // audit.jsonl -> .1 -> .2 ... oldest is dropped
    await fsp.rm(`${this.file}.${this.backups}`, { force: true }).catch(() => {});
    for (let i = this.backups - 1; i >= 1; i--) {
      await fsp.rename(`${this.file}.${i}`, `${this.file}.${i + 1}`).catch(() => {});
    }
    await fsp.rename(this.file, `${this.file}.1`).catch(() => {});
  }

  async _readTail(file, bytes) {
    let fh;
    try {
      fh = await fsp.open(file, 'r');
      const stat = await fh.stat();
      const start = Math.max(0, stat.size - bytes);
      const length = stat.size - start;
      if (length === 0) return [];
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      return buf.toString('utf8').split('\n').filter(Boolean);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  async tail(limit = 50, filter = {}) {
    if (!this.file) return [];
    const want = Math.max(1, Math.min(Number(limit) || 50, 1000));
    const events = [];
    const matches = (ev) => {
      if (filter.path && !(ev.path || '').startsWith(filter.path)) return false;
      if (filter.agent && ev.agent !== filter.agent) return false;
      if (filter.op && ev.op !== filter.op) return false;
      if (filter.onlyWrites && !['write', 'append', 'put', 'upload', 'move', 'copy', 'delete', 'mkdir', 'restore'].includes(ev.op)) {
        return false;
      }
      return true;
    };

    // Current file first, then the rotated one if more events are needed.
    for (const file of [this.file, `${this.file}.1`]) {
      const lines = (await this._readTail(file, this.tailBytes)).reverse();
      for (const line of lines) {
        if (events.length >= want) break;
        try {
          const ev = JSON.parse(line);
          if (matches(ev)) events.push(ev);
        } catch {
          /* ignore torn line */
        }
      }
      if (events.length >= want) break;
    }
    return events.reverse();
  }
}
