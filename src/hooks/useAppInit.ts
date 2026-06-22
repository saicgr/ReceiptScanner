/**
 * One-time app bootstrap: open/migrate the DB, load settings + lookup lists,
 * register notification handlers, and reconcile the forwarding address with the
 * backend. Returns { ready } so the root layout can hold the splash screen.
 */
import { useEffect, useState } from 'react';
import { getDb } from '../db/database';
import { useSettings } from '../store/settings';
import { useLookups } from '../store/lookups';
import { loadAppFonts } from './useFonts';
import { seedDemoReceipts } from '../db/demoSeed';

export function useAppInit(): { ready: boolean; error: string | null } {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSettings = useSettings((s) => s.load);
  const refreshLookups = useLookups((s) => s.refresh);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await loadAppFonts(); // VAULT type families (resolves even on failure)
        await getDb(); // runs migrations + seed (sql.js on web, native otherwise)
        await Promise.all([loadSettings(), refreshLookups()]);
        // Dev-only: a console hook to populate demo receipts for previewing the
        // UI with content. No-ops if any receipts already exist. Never shipped
        // behaviour — guarded by __DEV__.
        if (__DEV__) {
          (globalThis as any).__seedDemo = () => seedDemoReceipts();
        }
        if (mounted) setReady(true);
      } catch (e: any) {
        console.error('App init failed', e);
        if (mounted) {
          setError(String(e?.message ?? e));
          setReady(true); // fail open so the user isn't stuck on splash
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [loadSettings, refreshLookups]);

  return { ready, error };
}
