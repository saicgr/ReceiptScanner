/**
 * React Native autolinking config.
 *
 * Google ML Kit (pulled in by `@react-native-ml-kit/text-recognition`, our
 * on-device OCR engine) does NOT ship an arm64 *simulator* slice. On an Apple
 * Silicon Mac the iOS simulator is arm64-only, so as long as the ML Kit pod is
 * linked, the app can only be built x86_64 and therefore cannot be installed on
 * the simulator.
 *
 * To run the app on the iOS simulator during development we exclude the ML Kit
 * native module from iOS autolinking. This is OPT-IN via an env flag so that
 * real device / production builds keep full on-device OCR:
 *
 *   # Simulator dev build (OCR disabled, scanning falls back to the backend):
 *   EXCLUDE_MLKIT_IOS=1 npx pod-install ios   # then build for the simulator
 *
 *   # Device / production build (OCR enabled — the default):
 *   npx pod-install ios
 *
 * The OCR service (src/services/ocr.ts) already loads ML Kit lazily inside a
 * try/catch and degrades to an empty result when the native module is absent,
 * so unlinking it here is safe: the scan flow simply proceeds straight to the
 * Gemini /extract backend.
 */
const excludeMlKitIos = process.env.EXCLUDE_MLKIT_IOS === '1';

module.exports = {
  dependencies: excludeMlKitIos
    ? {
        '@react-native-ml-kit/text-recognition': {
          platforms: { ios: null },
        },
      }
    : {},
};
