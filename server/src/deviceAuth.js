// Stateless device-token authentication.
//
// The client-supplied X-Device-Id used to be the ONLY rate-limit key, so an
// abuser could rotate random ids and bypass the 50/day and 5000-lifetime caps
// for free. Now a device must first call POST /device/register to obtain
//
//   X-Device-Token = HMAC-SHA256(deviceId, DEVICE_TOKEN_SECRET)  (hex)
//
// and every endpoint that costs money or exposes user data verifies the
// id/token pair with a timing-safe compare. Verification is stateless (no
// token store); minting NEW identities is throttled per IP at /device/register
// instead (see index.js).
//
// This raises the bar from "spoof a header" to "hit a rate-limited registration
// endpoint per identity". The production-grade upgrade path is platform
// attestation (Apple App Attest / Google Play Integrity) — see the README.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/** Mint the token for a device id (what /device/register returns). */
export function deviceTokenFor(deviceId) {
  return createHmac('sha256', config.deviceTokenSecret)
    .update(String(deviceId))
    .digest('hex');
}

/** Constant-time check that `token` is the valid token for `deviceId`. */
export function verifyDeviceToken(deviceId, token) {
  if (!deviceId || !token || typeof token !== 'string') return false;
  const expected = Buffer.from(deviceTokenFor(deviceId), 'utf8');
  const provided = Buffer.from(token, 'utf8');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * Express middleware: require a valid X-Device-Id + X-Device-Token pair.
 * On success, exposes the authenticated id as `req.deviceId`.
 */
export function requireDeviceAuth(req, res, next) {
  const deviceId = req.headers['x-device-id'];
  const token = req.headers['x-device-token'];
  if (!verifyDeviceToken(deviceId, token)) {
    return res.status(401).json({
      error: 'unauthorized',
      message:
        'A valid X-Device-Id + X-Device-Token pair is required. Obtain a token via POST /device/register.',
    });
  }
  req.deviceId = String(deviceId);
  next();
}
