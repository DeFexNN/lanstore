import fsp from 'node:fs/promises';
import path from 'node:path';

/** Append-only JSONL activity log. */
export class Audit {
  constructor({ file, enabled = true, tailBytes = 512 * 1024 } = {}) {
    this.file = file;
    this.enabled = enabled;
    this.tailBytes = tailBytes;
    this.chain = Promise.resolve();
  }

  log(event) {
    if (!this.enabled || !this.file) return Promise.resolve();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    this.chain = this.chain
      .then(async () => {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.appendFile(this.file, line);
      })
      .catch(() => {});
    return this.chain;
  }

  async tail(limit = 50, filter = {}) {
    if (!this.file) return [];
    let fh;
    try {
      fh = await fsp.open(this.file, 'r');
      const stat = await fh.stat();
      const start = Math.max(0, stat.size - this.tailBytes);
      const length = stat.size - start;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      const events = [];
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (filter.path && !(ev.path || '').startsWith(filter.path)) continue;
          if (filter.agent && ev.agent !== filter.agent) continue;
          if (filter.op && ev.op !== filter.op) continue;
          if (filter.onlyWrites && !['write', 'append', 'put', 'upload', 'move', 'copy', 'delete', 'mkdir'].includes(ev.op)) continue;
          events.push(ev);
        } catch {
          /* ignore torn line */
        }
      }
      return events.slice(-Math.max(1, Math.min(Number(limit) || 50, 1000)));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    } finally {
      await fh?.close().catch(() => {});
    }
  }
}
