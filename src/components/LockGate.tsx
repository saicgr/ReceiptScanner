/**
 * LockGate — wraps a screen's content and, when the user has enabled App Lock
 * in Settings (settings.app_lock), requires a successful biometric/PIN auth
 * before revealing it. Used to protect History & Statistics (a competitor
 * privacy feature). Fails open if the device has no biometrics enrolled.
 */
import { ReactNode, useCallback, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen, Button, Text, Icon, useTheme } from './ui';
import { useSettings } from '../store/settings';
import { authenticate } from '../services/appLock';

export function LockGate({ label, children }: { label: string; children: ReactNode }) {
  const t = useTheme();
  const appLock = useSettings((s) => s.settings.app_lock);
  const [unlocked, setUnlocked] = useState(!appLock);

  const tryUnlock = useCallback(async () => {
    const ok = await authenticate(`Unlock ${label}`);
    setUnlocked(ok);
  }, [label]);

  useFocusEffect(
    useCallback(() => {
      if (!appLock) {
        setUnlocked(true);
        return;
      }
      // Re-lock whenever the screen regains focus, then prompt.
      setUnlocked(false);
      tryUnlock();
    }, [appLock, tryUnlock]),
  );

  if (unlocked) return <>{children}</>;

  return (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.spacing.lg }}>
        <Icon name="lock-closed" size={56} color={t.colors.textMuted} />
        <Text variant="subheading">{label} is locked</Text>
        <Text variant="body" color={t.colors.textMuted} align="center">
          App Lock is on. Authenticate to view your {label.toLowerCase()}.
        </Text>
        <Button title="Unlock" icon="finger-print" onPress={tryUnlock} />
      </View>
    </Screen>
  );
}
