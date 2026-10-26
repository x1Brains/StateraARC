// Statera impersonators for the server-side cards (api/og.js, api/report.js). MUST match src/lib/rules.ts
// isStateraImpersonator: the only official Statera token is $STR; any other token using the Statera name is not ours.
// (09-30 owner: "add a FAKE — not associated with us banner".)
const OFFICIAL = new Set(['0xaaeea145196107f96a209a843e4f14a69dae99d0']);
const KNOWN_FAKES = new Set(['0x1101ece603b96f5e5db610b63be9807fbb544235']);
export const isStateraImpersonator = (addr, name, symbol) => {
  const a = String(addr || '').toLowerCase();
  if (OFFICIAL.has(a)) return false;
  return KNOWN_FAKES.has(a) || /statera/i.test(`${name || ''} ${symbol || ''}`);
};
