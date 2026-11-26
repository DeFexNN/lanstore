/**
 * Write guard / conflict queue.
 *
 * Rule: if a file was modified by *another* agent (or an external process)
 * less than `cooldownMs` ago, the first write is rejected and the caller gets
 * the fresh content back. The next write for the same file by the same agent
 * is accepted — that is the "read the new content, then retry" contract.
 *
 * A write made through the hub by the same agent within the cooldown window is
 * allowed by default (the agent already knows what it wrote). Disable with
 * guardSameAgent: true.
 */
export class WriteGuard {
  constructor(cfg) {
    this.cfg = cfg;
    this.lastWrites = new Map(); // pathKey -> { agentId, version, mtimeMs, at }
    this.challenges = new Map(); // pathKey + \0 + agentId -> { version, at }
    this.locks = new Map(); // pathKey -> Promise (mutex tail)
    this.timer = setInterval(() => this.sweep(), Math.max(30_000, Math.floor(cfg.challengeTtlMs / 2)));
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  pathKey(rel) {
    return process.platform === 'win32' ? rel.toLowerCase() : rel;
  }

  /** Serialize read-check-write per path so two simultaneous writes cannot interleave. */
  async withLock(rel, fn) {
    const key = this.pathKey(rel);
    while (this.locks.has(key)) {
      await this.locks.get(key).catch(() => {});
    }
    let release;
    const ticket = new Promise((resolve) => {
      release = resolve;
    });
    this.locks.set(key, ticket);
    try {
      return await fn();
    } finally {
      this.locks.delete(key);
      release();
    }
  }

  recordWrite(rel, agentId, version, mtimeMs) {
    this.lastWrites.set(this.pathKey(rel), {
      agentId: agentId || 'anonymous',
      version: version ?? null,
      mtimeMs: Math.round(mtimeMs ?? Date.now()),
      at: Date.now()
    });
  }

  /** Drop bookkeeping for a path (delete / move source). */
  forget(rel) {
    const key = this.pathKey(rel);
    this.lastWrites.delete(key);
    for (const k of [...this.challenges.keys()]) {
      if (k.startsWith(key + '\u0000')) this.challenges.delete(k);
    }
  }

  peek(rel, agentId) {
    return this.challenges.get(this.pathKey(rel) + '\u0000' + (agentId || 'anonymous')) || null;
  }

  /**
   * Decide whether a write may proceed.
   * Mutates guard state: issues a challenge when blocking, consumes it on accept.
   */
  evaluate(rel, { agentId, exists, version = null, mtimeMs = 0, expectedVersion = null, consume = true } = {}) {
    const now = Date.now();
    const fileKey = this.pathKey(rel);
    const challengeKey = fileKey + '\u0000' + (agentId || 'anonymous');
    const ageMs = exists ? Math.max(0, now - mtimeMs) : null;
    const last = this.lastWrites.get(fileKey) || null;

    if (!exists) {
      this.challenges.delete(challengeKey);
      return { allow: true, reason: 'create', ageMs, lastAgent: null };
    }

    const sameAgentWrite =
      !!last &&
      agentId !== 'anonymous' &&
      last.agentId === agentId &&
      Math.abs(Number(mtimeMs) - last.mtimeMs) < 5;

    const challenge = this.challenges.get(challengeKey) || null;
    const challengeValid =
      !!challenge &&
      challenge.version === version &&
      now - challenge.at <= this.cfg.challengeTtlMs;

    if (challengeValid) {
      if (consume) this.challenges.delete(challengeKey);
      return { allow: true, reason: 'second_attempt', ageMs, version, lastAgent: last?.agentId ?? null };
    }

    if (expectedVersion && expectedVersion !== version) {
      this.challenges.set(challengeKey, { version, at: now });
      return {
        allow: false,
        code: 'VERSION_MISMATCH',
        reason: 'version_mismatch',
        ageMs,
        version,
        lastAgent: last?.agentId ?? null
      };
    }

    const recent = ageMs !== null && ageMs < this.cfg.cooldownMs;
    const ownWriteAllowed = sameAgentWrite && !this.cfg.guardSameAgent;

    if (recent && !ownWriteAllowed) {
      this.challenges.set(challengeKey, { version, at: now });
      return {
        allow: false,
        code: 'RECENTLY_MODIFIED',
        reason: 'recently_modified',
        ageMs,
        version,
        lastAgent: last?.agentId ?? null
      };
    }

    this.challenges.delete(challengeKey);
    return {
      allow: true,
      reason: ownWriteAllowed ? 'own_write' : 'stale',
      ageMs,
      version,
      lastAgent: last?.agentId ?? null
    };
  }

  sweep() {
    const now = Date.now();
    for (const [key, ch] of this.challenges) {
      if (now - ch.at > this.cfg.challengeTtlMs) this.challenges.delete(key);
    }
    for (const [key, rec] of this.lastWrites) {
      if (now - rec.at > 24 * 3600 * 1000) this.lastWrites.delete(key);
    }
  }

  status() {
    return {
      cooldownMs: this.cfg.cooldownMs,
      challengeTtlMs: this.cfg.challengeTtlMs,
      guardSameAgent: this.cfg.guardSameAgent,
      pendingChallenges: this.challenges.size,
      trackedFiles: this.lastWrites.size
    };
  }
}
