'use strict';

const config = require('../config');

/**
 * Build the ICE server list for a WebRTC peer connection.
 *
 * Always includes STUN. TURN is added when configured:
 *   • Cloudflare Realtime (preferred) — short-lived credentials minted
 *     per request so the secret token never reaches the client.
 *   • Static username/credential (Metered/Twilio/coturn) otherwise.
 *
 * Without any TURN, peers behind symmetric / carrier-grade NAT (mobile
 * data) can't connect. Never throws — falls back to STUN-only / static on
 * any error so callers can always return a (degraded) list rather than 500.
 *
 * Shared by GET /calls/ice-servers (authed) and
 * GET /meetings/:roomId/ice-servers (koro-meet, incl. guests).
 */
async function buildIceServers() {
  const servers = config.ice.stunUrls.map((u) => ({ urls: u }));

  // Preferred path: mint ephemeral Cloudflare TURN credentials.
  if (config.ice.cfTurnKeyId && config.ice.cfTurnToken) {
    try {
      const cf = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${config.ice.cfTurnKeyId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.ice.cfTurnToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: config.ice.turnTtl }),
        },
      );
      if (cf.ok) {
        const data = await cf.json();
        // Cloudflare returns iceServers as a single object (urls +
        // username + credential); normalise to an array and append.
        const cfServers = data && data.iceServers
          ? (Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers])
          : [];
        return [...servers, ...cfServers];
      }
      console.warn('[ice] Cloudflare TURN mint failed:', cf.status);
    } catch (err) {
      console.warn('[ice] Cloudflare TURN error:', err.message || err);
    }
    // Fall through to static / STUN-only on failure rather than 500.
  }

  // Static TURN credentials, if configured.
  if (config.ice.turnUrls.length > 0) {
    servers.push({
      urls: config.ice.turnUrls,
      username: config.ice.turnUsername || undefined,
      credential: config.ice.turnCredential || undefined,
    });
  }
  return servers;
}

module.exports = { buildIceServers };
