/** Throwaway TURN server for E2E relay verification (never used by the app itself). */
import Turn from 'node-turn';
const server = new Turn({
  listeningPort: Number(process.env.TURN_PORT || 3479),
  authMech: 'long-term',
  credentials: { e2e: 'e2e-secret' },
  realm: 'e2e',
  debugLevel: 'OFF',
});
server.start();
console.log(`[local-turn] listening on udp ${process.env.TURN_PORT || 3479}`);
