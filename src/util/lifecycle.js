'use strict';

/**
 * Process lifecycle flag. While draining, the /health endpoint returns 503 so
 * the load balancer (Traefik) stops routing new traffic to this instance
 * BEFORE we close live WebSocket sockets — giving clients a healthy instance
 * to reconnect to. See src/index.js shutdown sequence.
 */
let draining = false;

module.exports = {
  isDraining: () => draining,
  setDraining: (v) => { draining = !!v; },
};
