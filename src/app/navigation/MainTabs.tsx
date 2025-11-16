import { ReactNode, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DashboardScreen } from '@screens/DashboardScreen';
import { DebugScreen } from '@screens/DebugScreen';

type TabKey = 'dashboard' | 'debug';

interface TabConfig {
  key: TabKey;
  label: string;
  render: () => ReactNode;
}

const TAB_CONFIG: TabConfig[] = [
  { key: 'dashboard', label: 'Dashboard', render: () => <DashboardScreen /> },
  { key: 'debug', label: 'Debug', render: () => <DebugScreen /> },
];

export function MainTabs() {
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.container}>
      <View style={styles.body}>
        {TAB_CONFIG.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <View
              key={tab.key}
              style={[styles.screen, !isActive && styles.screenHidden]}
              pointerEvents={isActive ? 'auto' : 'none'}
            >
              {tab.render()}
            </View>
          );
        })}
      </View>
      <View style={[styles.nav, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {TAB_CONFIG.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              onPress={() => setActiveTab(tab.key)}
              style={[styles.navButton, isActive && styles.navButtonActive]}
            >
              <Text style={[styles.navLabel, isActive && styles.navLabelActive]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  body: {
    flex: 1,
  },
  screen: {
    flex: 1,
  },
  screenHidden: {
    display: 'none',
  },
  nav: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#111',
    backgroundColor: '#050505',
  },
  navButton: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navButtonActive: {
    backgroundColor: '#111',
  },
  navLabel: {
    color: '#888',
    fontSize: 15,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  navLabelActive: {
    color: '#f5f5f5',
  },
});
