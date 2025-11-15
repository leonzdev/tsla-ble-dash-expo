import { useMemo, useState } from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { useVehicleStore } from '@state/vehicleStore';

export function DashboardScreen() {
  const [isLandscape, setIsLandscape] = useState(false);
  const driveState = useVehicleStore((state) => state.driveState);
  const keyLoaded = useVehicleStore((state) => state.keyLoaded);
  const autoRefreshActive = useVehicleStore((state) => state.autoRefreshActive);
  const toggleAutoRefresh = useVehicleStore((state) => state.toggleAutoRefresh);

  const driveData = driveState?.vehicleData?.driveState ?? driveState?.vehicleData?.drive_state ?? null;

  const speed = useMemo(() => parseVehicleSpeed(driveData), [driveData]);
  const gear = useMemo(() => formatShiftState(driveData?.shiftState ?? driveData?.shift_state), [driveData]);

  return (
    <View style={[styles.container, isLandscape && styles.containerLandscape]}>
      <View style={styles.stage}>
        <View style={[styles.display, isLandscape && styles.displayLandscape]}>
          <Text style={[styles.speed, isLandscape && styles.speedLandscape]}>{formatSpeedDisplay(speed)}</Text>
          <Text style={styles.units}>MPH</Text>
          <Text style={styles.gear}>{gear}</Text>
        </View>

        {!keyLoaded && (
          <View style={styles.statusCard}>
            <Text style={styles.statusText}>Key: Not loaded</Text>
          </View>
        )}

        <View style={styles.controls}>
          <DashboardButton
            label={isLandscape ? 'Portrait Layout' : 'Landscape Layout'}
            onPress={() => setIsLandscape((prev) => !prev)}
          />
          <DashboardButton
            label={autoRefreshActive ? 'Stop Auto Refresh' : 'Start Auto Refresh'}
            onPress={toggleAutoRefresh}
            primary
            active={autoRefreshActive}
          />
        </View>
      </View>
    </View>
  );
}

interface DashboardButtonProps {
  label: string;
  onPress: () => void;
  primary?: boolean;
  active?: boolean;
}

function DashboardButton({ label, onPress, primary, active }: DashboardButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[
        styles.button,
        primary && styles.buttonPrimary,
        active && primary && styles.buttonPrimaryActive,
      ]}
    >
      <Text style={[styles.buttonLabel, primary && styles.buttonLabelPrimary]}>{label}</Text>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#030712',
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  containerLandscape: {
    justifyContent: 'center',
  },
  stage: {
    flex: 1,
    borderRadius: 24,
    backgroundColor: '#050b1f',
    padding: 24,
    gap: 24,
    borderWidth: 1,
    borderColor: '#111827',
  },
  display: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 24,
    paddingVertical: 48,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  displayLandscape: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
  },
  speed: {
    fontSize: 92,
    color: '#f8fafc',
    fontWeight: '200',
    letterSpacing: 4,
  },
  speedLandscape: {
    fontSize: 108,
  },
  units: {
    color: '#94a3b8',
    fontSize: 16,
    marginTop: -8,
  },
  gear: {
    fontSize: 48,
    color: '#f8fafc',
    fontWeight: '600',
    marginTop: 12,
  },
  statusCard: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: '#7f1d1d',
  },
  statusText: {
    color: '#fecaca',
    fontSize: 16,
    fontWeight: '500',
  },
  controls: {
    flexDirection: 'row',
    gap: 16,
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: '#0f172a',
    borderWidth: 1,
    borderColor: '#1f2937',
    alignItems: 'center',
  },
  buttonPrimary: {
    backgroundColor: '#047857',
    borderColor: '#059669',
  },
  buttonPrimaryActive: {
    backgroundColor: '#b45309',
    borderColor: '#f97316',
  },
  buttonLabel: {
    color: '#e2e8f0',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  buttonLabelPrimary: {
    color: '#0f172a',
  },
});
