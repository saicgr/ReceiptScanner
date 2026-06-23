/**
 * Root layout. Wraps the app in gesture + safe-area providers, runs bootstrap
 * (DB migrations, settings, lookups), holds the splash until ready, then renders
 * the navigation stack. Tabs live under (tabs); everything else is a pushed or
 * modal route.
 */
import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useColorScheme, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { useAppInit } from '../src/hooks/useAppInit';
import { useTheme } from '../src/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const { ready } = useAppInit();
  const scheme = useColorScheme();
  const t = useTheme();

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) {
    return <View style={{ flex: 1, backgroundColor: '#0E7C66' }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: t.colors.bg },
            headerTintColor: t.colors.text,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: t.colors.bg },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="scan" options={{ presentation: 'modal', title: 'New Scan' }} />
          <Stack.Screen name="review" options={{ headerShown: false }} />
          <Stack.Screen name="multi-scan" options={{ title: 'Multi Scan' }} />
          <Stack.Screen name="split-review" options={{ title: 'Split Receipts' }} />
          <Stack.Screen name="receipt/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="folder/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="image-viewer" options={{ presentation: 'fullScreenModal', headerShown: false }} />
          <Stack.Screen name="statement" options={{ title: 'Statement Matching' }} />
          <Stack.Screen name="tax-report" options={{ title: 'Tax Report' }} />
          <Stack.Screen name="paywall" options={{ presentation: 'modal', title: 'Unlock ReceiptSnap' }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false, presentation: 'fullScreenModal' }} />
          <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
          <Stack.Screen name="settings/categories" options={{ title: 'Categories' }} />
          <Stack.Screen name="settings/payment-methods" options={{ title: 'Payment Methods' }} />
          <Stack.Screen name="settings/tags" options={{ title: 'Tags & Jobs' }} />
          <Stack.Screen name="settings/tax-categories" options={{ title: 'Tax Categories' }} />
          <Stack.Screen name="settings/budgets" options={{ title: 'Budgets' }} />
          <Stack.Screen name="budget-report" options={{ title: 'Budget vs Actual' }} />
          <Stack.Screen name="settings/filename" options={{ title: 'Filename Template' }} />
          <Stack.Screen name="settings/backup" options={{ title: 'Backup & Restore' }} />
          <Stack.Screen name="settings/about" options={{ title: 'About' }} />
          <Stack.Screen name="settings/roadmap" options={{ title: 'Roadmap' }} />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
