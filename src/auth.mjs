import { HubError } from './util.mjs';
import { clientIp } from './http.mjs';

/**
 * Token -> agent identity. When auth is disabled every caller is "anonymous".
 */
export function createAuth(cfg) {
  const enabled = !!(cfg.auth && cfg.auth.enabled);
  const byToken = new Map();
  for (const [agent, token] of Object.entries(cfg.auth?.tokens || {})) {
    if (token) byToken.set(String(token), String(agent));
  }

  return {
    enabled,
    agents: [...new Set(Object.keys(cfg.auth?.tokens || {}))],
    identify(req, url = null, { optional = false } = {}) {
      if (!enabled) {
        const claimed = String(req.headers['x-agent-id'] || '').trim().toLowerCase();
        const id = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(claimed) ? claimed : 'anonymous';
        return { id, ip: clientIp(req), anonymous: id === 'anonymous' };
      }

      let token = null;
      const auth = req.headers.authorization;
      if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
        token = auth.slice(7).trim();
      } else if (req.headers['x-api-key']) {
        token = String(req.headers['x-api-key']).trim();
      } else if (url?.searchParams?.get('token')) {
        token = url.searchParams.get('token');
      }

      if (!token) {
        if (optional) return { id: 'anonymous', ip: clientIp(req), anonymous: true, unauthenticated: true };
        throw new HubError('unauthorized', 'missing API token (Authorization: Bearer <token>)', 401);
      }
      const agent = byToken.get(token);
      if (!agent) throw new HubError('unauthorized', 'invalid API token', 401);
      return { id: agent, ip: clientIp(req), anonymous: false };
    }
  };
}
