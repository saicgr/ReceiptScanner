/**
 * Global settings store. Loads AppSettings from SQLite on init and persists any
 * change back. Screens read settings reactively (filename template, date format,
 * unlock state, mileage rate, etc.).
 */
import { create } from 'zustand';
import { DEFAULT_SETTINGS, type AppSettings } from '../types';
import { getAllSettings, updateSettings } from '../db/settings';

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  /** Convenience: is the app feature-unlocked (purchased OR under free limit). */
  canScan: () => boolean;
  scansRemaining: () => number;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    const settings = await getAllSettings();
    set({ settings, loaded: true });
  },

  update: async (patch) => {
    set({ settings: { ...get().settings, ...patch } });
    await updateSettings(patch);
  },

  canScan: () => {
    const s = get().settings;
    return s.is_unlocked || s.scan_count < s.free_scan_limit;
  },

  scansRemaining: () => {
    const s = get().settings;
    if (s.is_unlocked) return Infinity;
    return Math.max(0, s.free_scan_limit - s.scan_count);
  },
}));
