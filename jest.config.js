/**
 * Jest configuration for ReceiptSnap.
 *
 * Uses the `jest-expo` preset so the Expo/React Native module map and Babel
 * transform are applied. Tests live under `src/lib/__tests__` and exercise the
 * PURE logic modules (no native RN imports), so they run fast and deterministically.
 *
 * `transformIgnorePatterns` is widened to let Jest transpile the ESM published
 * by RN / Expo / @react-navigation / zustand packages (node_modules ships ESM
 * that Jest cannot otherwise parse).
 */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@react-navigation/.*|zustand))',
  ],
};
