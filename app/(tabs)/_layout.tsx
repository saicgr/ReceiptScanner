/**
 * Bottom tab navigator: Home, History, Statistics, Protections, Mileage.
 * Rendered as a floating, translucent "glass" pill that sits above the content
 * rather than a solid docked bar — part of the VAULT visual language.
 */
import { Tabs } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, fonts } from '../../src/theme';
import { useSettings } from '../../src/store/settings';

export default function TabsLayout() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  // Mileage is opt-in: hidden from the tab bar when disabled in Settings.
  const mileageEnabled = useSettings((s) => s.settings.mileage_enabled);
  const bottom = Math.max(insets.bottom, 12);
  // Translucent fill so the content scrolling underneath stays subtly visible.
  const glass = t.isDark ? 'rgba(11,19,16,0.82)' : 'rgba(255,255,255,0.82)';
  const hairline = t.isDark ? 'rgba(255,255,255,0.07)' : 'rgba(9,61,47,0.08)';

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.colors.brand,
        tabBarInactiveTintColor: t.colors.textFaint,
        tabBarLabelStyle: { fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 0.2 },
        tabBarItemStyle: { paddingTop: 8 },
        tabBarBackground: () => (
          <View
            style={[
              {
                flex: 1,
                backgroundColor: glass,
                borderRadius: 26,
                borderWidth: 1,
                borderColor: hairline,
                overflow: 'hidden',
              },
              t.shadow(3),
            ]}
          />
        ),
        tabBarStyle: {
          position: 'absolute',
          left: 14,
          right: 14,
          bottom,
          height: 64,
          paddingBottom: 0,
          borderTopWidth: 0,
          backgroundColor: 'transparent',
          elevation: 0,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ color, size }) => <Ionicons name="receipt" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="statistics"
        options={{
          title: 'Stats',
          tabBarIcon: ({ color, size }) => <Ionicons name="stats-chart" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="protections"
        options={{
          title: 'Protections',
          tabBarIcon: ({ color, size }) => <Ionicons name="shield-checkmark" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="mileage"
        options={{
          title: 'Mileage',
          tabBarIcon: ({ color, size }) => <Ionicons name="car-sport" size={size} color={color} />,
          // `href: null` removes it from the tab bar (and disables its route)
          // when the user has turned Mileage off in Settings.
          href: mileageEnabled ? undefined : null,
        }}
      />
    </Tabs>
  );
}
