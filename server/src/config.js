// Centralized configuration loaded from environment variables.
// In development we load the repo-root .env (where the user placed the key);
// in production (Render) these come from the dashboard's environment settings.
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Prefer server/.env, then fall back to the repo-root .env (one level up from server/).
const candidates = [
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../.env'),
];
for (const p of candidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const isProduction = process.env.NODE_ENV === 'production';

// --- Device-token auth secret (see deviceAuth.js) ---
// X-Device-Token = HMAC-SHA256(deviceId, DEVICE_TOKEN_SECRET). Without a real
// secret anyone can mint tokens, so production REFUSES to boot without one.
// Dev falls back to a fixed (insecure) string so local work keeps flowing.
let deviceTokenSecret = process.env.DEVICE_TOKEN_SECRET || '';
if (!deviceTokenSecret) {
  if (isProduction) {
    console.error(
      '[fatal] DEVICE_TOKEN_SECRET is required in production. ' +
        'Generate one with `openssl rand -hex 32` and set it in the environment.',
    );
    process.exit(1);
  }
  deviceTokenSecret = 'dev-insecure-device-token-secret';
  console.warn(
    '[warn] DEVICE_TOKEN_SECRET not set — using an INSECURE dev fallback. Set a real secret before deploying.',
  );
}

export const config = {
  port: parseInt(process.env.PORT || '8787', 10),
  isProduction,

  // Secret used to mint/verify stateless device tokens (X-Device-Token).
  deviceTokenSecret,

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite',
    // Google Generative Language REST endpoint (works for any model name).
    baseUrl:
      process.env.GEMINI_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta',
  },

  // Rate limiting (per spec): 50 scans/day/device, lifetime soft cap 5000.
  rateLimit: {
    perDayPerDevice: parseInt(process.env.RATE_LIMIT_PER_DAY || '50', 10),
    lifetimeSoftCap: parseInt(process.env.RATE_LIMIT_LIFETIME || '5000', 10),
    // Per-IP backstops: registration is the new abuse surface (it mints valid
    // device tokens), and /extract gets an IP cap in case device ids leak.
    registerPerDayPerIp: parseInt(process.env.REGISTER_PER_DAY_PER_IP || '10', 10),
    extractPerDayPerIp: parseInt(process.env.EXTRACT_PER_DAY_PER_IP || '200', 10),
    // Billing circuit breaker: total Gemini calls/day across ALL routes.
    globalDailyGeminiCap: parseInt(process.env.GLOBAL_DAILY_GEMINI_CAP || '2000', 10),
  },

  // Inbound email: shared secret so only your mail provider's webhook can post.
  inboundEmailSecret: process.env.INBOUND_EMAIL_SECRET || '',
  // Forwarding domain shown to users, e.g. inbox.receiptsnap.app
  forwardingDomain: process.env.FORWARDING_DOMAIN || 'inbox.receiptsnap.app',

  // Ephemeral pending-queue TTL (ms). Receipts ingested via email live here
  // only until the app polls them — we never persist user receipts server-side.
  pendingTtlMs: parseInt(process.env.PENDING_TTL_MS || String(72 * 3600 * 1000), 10),
};

export function assertConfigured() {
  if (!config.gemini.apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Add it to .env (repo root) or server/.env.',
    );
  }
}
