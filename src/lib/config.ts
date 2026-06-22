/** Reads build-time config from app.json `extra`. Central place for endpoints. */
import Constants from 'expo-constants';

interface Extra {
  extractApiBaseUrl: string;
  googleOAuthClientIdIos: string;
  googleOAuthClientIdAndroid: string;
  googleOAuthClientIdWeb: string;
  microsoftOAuthClientId: string;
  iapProductId: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;

export const appConfig = {
  apiBaseUrl: extra.extractApiBaseUrl ?? 'http://localhost:8787',
  google: {
    iosClientId: extra.googleOAuthClientIdIos ?? '',
    androidClientId: extra.googleOAuthClientIdAndroid ?? '',
    webClientId: extra.googleOAuthClientIdWeb ?? '',
  },
  microsoftClientId: extra.microsoftOAuthClientId ?? '',
  iapProductId: extra.iapProductId ?? 'receiptsnap_unlock',
  iapPriceLabel: '$9.99',
};
