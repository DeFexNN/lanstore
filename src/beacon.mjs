import dgram from 'node:dgram';

import { APP_VERSION } from './util.mjs';

export const DISCOVER_MAGIC = 'LANSTORE_DISCOVER';
export const HUB_MAGIC = 'LANSTORE_HUB';

/**
 * UDP beacon: answers "who is the lanstore hub?" probes from clients on the LAN.
 * This is what lets an agent on another PC find the hub without knowing its IP.
 */
export function startBeacon({ cfg, identity, log = () => {} }) {
  const enabled = cfg.discovery?.enabled !== false;
  const port = Number(cfg.discovery?.port ?? 8788);
  if (!enabled) return { enabled: false, port, close: async () => {} };

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let closed = false;

  socket.on('error', (err) => log(`beacon: ${err.message}`));
  socket.on('message', (buf, rinfo) => {
    if (buf.length === 0 || buf.length > 4096) return;
    let req;
    try {
      req = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (req?.magic !== DISCOVER_MAGIC) return;

    const reply = JSON.stringify({
      magic: HUB_MAGIC,
      protocol: 1,
      name: cfg.name,
      hubId: identity.hubId,
      port: cfg.port,
      version: APP_VERSION,
      authEnabled: !!cfg.auth?.enabled,
      cooldownSec: Math.round(cfg.cooldownMs / 1000),
      ts: Date.now()
    });
    try {
      socket.send(Buffer.from(reply), rinfo.port, rinfo.address, () => {});
    } catch {
      /* ignore */
    }
  });

  try {
    socket.bind(port, '0.0.0.0');
  } catch (err) {
    log(`beacon: cannot bind udp/${port}: ${err.message}`);
  }

  return {
    enabled: true,
    port,
    close: () =>
      new Promise((resolve) => {
        if (closed) return resolve();
        closed = true;
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      })
  };
}
