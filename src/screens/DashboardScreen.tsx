import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentProps } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { AccessibilityState } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useVehicleStore } from '@state/vehicleStore';

export function DashboardScreen() {
  const [isLandscape, setIsLandscape] = useState(false);
  const orientationSupported = Platform.OS === 'ios' || Platform.OS === 'android';
  const { width, height } = useWindowDimensions();
  const driveState = useVehicleStore((state) => state.driveState);
  const keyLoaded = useVehicleStore((state) => state.keyLoaded);
  const autoRefreshActive = useVehicleStore((state) => state.autoRefreshActive);
  const toggleAutoRefresh = useVehicleStore((state) => state.toggleAutoRefresh);
  const latencyMs = useVehicleStore((state) => state.lastLatencyMs);

  const driveData = driveState?.vehicleData?.driveState ?? driveState?.vehicleData?.drive_state ?? null;

  const shortestSide = Math.min(width, height);
  const speed = useMemo(() => parseVehicleSpeed(driveData), [driveData]);
  const gear = useMemo(() => formatShiftState(driveData?.shiftState ?? driveData?.shift_state), [driveData]);
  const latencyText = useMemo(() => formatLatencyDisplay(latencyMs), [latencyMs]);
  const latencyColor = useMemo(() => latencyColorForValue(latencyMs), [latencyMs]);
  const speedText = formatSpeedDisplay(speed);
  const speedFontSize = shortestSide * 0.9;

  useEffect(() => {
    if (!orientationSupported) {
      return;
    }
    let cancelled = false;
    const enforcePortrait = async () => {
      try {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
        if (!cancelled) {
          setIsLandscape(false);
        }
      } catch (error) {
        console.warn('Failed to enforce portrait orientation', error);
      }
    };
    void enforcePortrait();
    return () => {
      cancelled = true;
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch((error) => {
        console.warn('Failed to reset orientation lock', error);
      });
    };
  }, [orientationSupported]);

  const handleOrientationToggle = useCallback(async () => {
    const next = !isLandscape;
    setIsLandscape(next);
    if (!orientationSupported) {
      return;
    }
    const targetLock = next
      ? ScreenOrientation.OrientationLock.LANDSCAPE
      : ScreenOrientation.OrientationLock.PORTRAIT_UP;
    try {
      await ScreenOrientation.lockAsync(targetLock);
    } catch (error) {
      console.warn('Failed to toggle orientation', error);
      setIsLandscape(!next);
    }
  }, [isLandscape, orientationSupported]);

  return (
    <View style={styles.container}>
      <View style={styles.screen}>
        <View style={styles.frame}>
          <View style={styles.readoutRow}>
            <View style={styles.speedWrapper}>
              <Text
                style={[styles.speed, { fontSize: speedFontSize }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.2}
              >
                {speedText}
              </Text>
            </View>

            <View style={styles.metaColumn}>
              <Text style={styles.gear}>{gear}</Text>
              <View style={styles.controls}>
                <IconButton
                  icon={autoRefreshActive ? 'stop' : 'play-arrow'}
                  color={autoRefreshActive ? '#dc2626' : '#16a34a'}
                  outlineColor={autoRefreshActive ? '#dc2626' : '#16a34a'}
                  onPress={toggleAutoRefresh}
                  accessibilityLabel={autoRefreshActive ? 'Stop auto refresh' : 'Start auto refresh'}
                  accessibilityState={{ checked: autoRefreshActive }}
                />
                <IconButton
                  icon={isLandscape ? 'stay-primary-portrait' : 'stay-primary-landscape'}
                  color={isLandscape ? '#0ea5e9' : '#0f172a'}
                  outlineColor={isLandscape ? '#0ea5e9' : undefined}
                  onPress={handleOrientationToggle}
                  accessibilityLabel={isLandscape ? 'Switch to portrait layout' : 'Switch to landscape layout'}
                  accessibilityState={{ checked: isLandscape }}
                />
              </View>
            </View>
          </View>

          <Text style={[styles.latency, { color: latencyColor }]}>{latencyText}</Text>

          {!keyLoaded && <Text style={styles.keyStatus}>Key not loaded</Text>}
        </View>
      </View>
    </View>
  );
}

type MaterialIconName = ComponentProps<typeof MaterialIcons>['name'];

interface IconButtonProps {
  icon: MaterialIconName;
  color: string;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityState?: AccessibilityState;
  outlineColor?: string;
}

function IconButton({
  icon,
  color,
  onPress,
  accessibilityLabel,
  accessibilityState,
  outlineColor,
}: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      hitSlop={12}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        {
          borderColor: outlineColor ?? '#e4e4e7',
          backgroundColor: pressed ? '#f4f4f5' : '#ffffff',
        },
      ]}
    >
      <MaterialIcons name={icon} size={28} color={color} />
    </Pressable>
  );
}

function parseVehicleSpeed(driveState: any): number | null {
  if (!driveState || typeof driveState !== 'object') {
    return null;
  }
  const candidates = [
    driveState.speedFloat,
    driveState.speed_float,
    driveState.speed,
    driveState.optionalSpeedFloat,
    driveState.optional_speed_float,
    driveState.optionalSpeed,
    driveState.optional_speed,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
    if (candidate && typeof candidate === 'object') {
      const nested = candidate.speedFloat ?? candidate.speed_float ?? candidate.speed;
      if (typeof nested === 'number' && Number.isFinite(nested)) {
        return nested;
      }
    }
  }
  return null;
}

function formatSpeedDisplay(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return '--';
  }
  const rounded = Math.max(0, Math.round(value));
  return String(rounded).padStart(2, '0');
}

function formatShiftState(raw: any): string {
  if (!raw) {
    return '—';
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return '—';
    }
    if (trimmed.length === 1) {
      return trimmed.toUpperCase();
    }
    const match = trimmed.match(/[PRND]/i);
    if (match) {
      return match[0].toUpperCase();
    }
    return trimmed.toUpperCase();
  }
  if (typeof raw === 'object') {
    for (const key of ['P', 'R', 'N', 'D']) {
      if (raw[key] != null || raw[key.toLowerCase()] != null) {
        return key;
      }
    }
    if (raw.Invalid != null || raw.invalid != null) {
      return '—';
    }
    if (typeof raw.type === 'string') {
      return formatShiftState(raw.type);
    }
  }
  return '—';
}

function formatLatencyDisplay(latency: number | null): string {
  if (latency == null || Number.isNaN(latency)) {
    return 'Latency --';
  }
  return `Latency ${Math.round(latency)} ms`;
}

function latencyColorForValue(latency: number | null): string {
  if (latency == null || Number.isNaN(latency)) {
    return '#94a3b8';
  }
  if (latency < 300) {
    return '#22c55e';
  }
  if (latency < 800) {
    return '#facc15';
  }
  return '#f87171';
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  screen: {
    flex: 1,
    paddingHorizontal: 24,
    paddingVertical: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    width: '100%',
    maxWidth: 760,
    alignItems: 'center',
    gap: 32,
  },
  readoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  speedWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
  },
  speed: {
    fontWeight: '200',
    color: '#111827',
    letterSpacing: -6,
    textAlign: 'right',
  },
  metaColumn: {
    marginLeft: 16,
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 16,
  },
  gear: {
    fontSize: 40,
    fontWeight: '700',
    color: '#111827',
    letterSpacing: 6,
  },
  controls: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  latency: {
    fontSize: 16,
    letterSpacing: 1.25,
    textTransform: 'uppercase',
  },
  keyStatus: {
    fontSize: 15,
    color: '#b91c1c',
    letterSpacing: 0.5,
  },
  iconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
});
