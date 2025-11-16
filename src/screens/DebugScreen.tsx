import AsyncStorage from '@react-native-async-storage/async-storage';
import { Picker } from '@react-native-picker/picker';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  TeslaBleSession,
  StateCategory,
  DeviceDiscoveryMode,
  VehicleStateResult,
  SelectedDeviceInfo,
  KeyRole,
  KeyFormFactor,
} from '@lib/session';
import {
  generatePrivateKey,
  importPrivateKeyPem,
  exportPrivateKeyPem,
  exportPublicKeyFromPrivate,
  exportPublicKeyPem,
  exportPublicKeyPemFromPrivate,
  publicKeyPemToRaw,
  TeslaPrivateKey,
} from '@lib/crypto';
import { AppButton } from '@components/AppButton';
import { useVehicleStore } from '@state/vehicleStore';

const PROFILE_STORAGE_KEY = 'tsla.profiles';
const VIN_STORAGE_KEY = 'tsla.vin';
const REFRESH_INTERVAL_STORAGE_KEY = 'tsla.stateRefreshIntervalMs';
const DEFAULT_REFRESH_INTERVAL_MS = 1000;
const MIN_REFRESH_INTERVAL_MS = 0;
const MAX_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_DISCOVERY_MODE = DeviceDiscoveryMode.VinPrefixPromptFilter;

interface StoredProfile {
  id: string;
  name: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

type AutoRefreshMode = 'manual' | 'auto';

export function DebugScreen() {
  const [vin, setVin] = useState('');
  const [profileName, setProfileName] = useState('');
  const [profiles, setProfiles] = useState<StoredProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [hasAppliedInitialProfile, setHasAppliedInitialProfile] = useState(false);
  const [privateKeyPem, setPrivateKeyPem] = useState('');
  const [publicKeyPem, setPublicKeyPem] = useState('');
  const [privateKey, setPrivateKey] = useState<TeslaPrivateKey | null>(null);
  const [logOutput, setLogOutput] = useState('Welcome to the Tesla BLE debug console.\n');
  const [stateOutput, setStateOutput] = useState('Vehicle state output will appear here.');
  const [stateCategory, setStateCategory] = useState<StateCategory>(StateCategory.Drive);
  const [refreshInterval, setRefreshInterval] = useState(DEFAULT_REFRESH_INTERVAL_MS);
  const [deviceInfo, setDeviceInfo] = useState<SelectedDeviceInfo | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const autoRefreshTimer = useRef<NodeJS.Timeout | null>(null);
  const sessionRef = useRef<TeslaBleSession | null>(null);
  const sessionConfigRef = useRef<{ vin: string } | null>(null);
  const stateCategoryOptions = useMemo(() => Object.values(StateCategory) as StateCategory[], []);

  const setStoreVin = useVehicleStore((state) => state.setVin);
  const setStoreKeyLoaded = useVehicleStore((state) => state.setKeyLoaded);
  const setStoreDriveState = useVehicleStore((state) => state.setDriveState);
  const autoRefreshActive = useVehicleStore((state) => state.autoRefreshActive);
  const setStoreAutoRefreshActive = useVehicleStore((state) => state.setAutoRefreshActive);

  useEffect(() => {
    setStoreVin(vin ? vin : null);
  }, [vin, setStoreVin]);

  useEffect(() => {
    setStoreKeyLoaded(Boolean(privateKey));
  }, [privateKey, setStoreKeyLoaded]);

  useEffect(() => {
    AsyncStorage.getItem(VIN_STORAGE_KEY)
      .then((stored) => {
        if (stored) {
          setVin(normalizeVin(stored));
        }
      })
      .catch((error) => console.warn('Failed to load VIN', error));
    AsyncStorage.getItem(PROFILE_STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw) as StoredProfile[];
        if (Array.isArray(parsed)) {
          setProfiles(parsed);
        }
      })
      .catch((error) => console.warn('Failed to load profiles', error));
    AsyncStorage.getItem(REFRESH_INTERVAL_STORAGE_KEY)
      .then((stored) => {
        if (!stored) return;
        setRefreshInterval(sanitizeRefreshInterval(stored));
      })
      .catch((error) => console.warn('Failed to load refresh interval', error));
  }, []);

  useEffect(() => {
    return () => {
      if (autoRefreshTimer.current) {
        clearTimeout(autoRefreshTimer.current);
      }
      sessionRef.current?.disconnect().catch(() => {});
    };
  }, []);

  const appendLog = useCallback((message: string) => {
    setLogOutput((prev) => `${prev}${message}\n`);
  }, []);

  const reportError = useCallback(
    (prefix: string, error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      appendLog(`${prefix}: ${detail}`);
      console.error(prefix, error);
    },
    [appendLog],
  );

  const getSession = useCallback((): TeslaBleSession => {
    const normalizedVin = normalizeVin(vin);
    if (!normalizedVin) {
      throw new Error('VIN is required');
    }
    const current = sessionConfigRef.current;
    if (!sessionRef.current || !current || current.vin !== normalizedVin) {
      sessionRef.current?.disconnect().catch(() => {});
      sessionRef.current = new TeslaBleSession({
        vin: normalizedVin,
        deviceDiscoveryMode: DEFAULT_DISCOVERY_MODE,
      });
      sessionConfigRef.current = { vin: normalizedVin };
    }
    return sessionRef.current;
  }, [vin]);

  const ensurePrivateKeyValue = useCallback(async (): Promise<TeslaPrivateKey> => {
    if (privateKey) {
      return privateKey;
    }
    if (!privateKeyPem.trim()) {
      throw new Error('Provide a private key first');
    }
    const imported = await importPrivateKeyPem(privateKeyPem);
    setPrivateKey(imported);
    return imported;
  }, [privateKey, privateKeyPem]);

  const handleGenerateKey = useCallback(async () => {
    try {
      setBusyAction('generate-key');
      appendLog('Generating new private key…');
      const pair = await generatePrivateKey();
      const pem = await exportPrivateKeyPem(pair.privateKey);
      const pubPem = await exportPublicKeyPem(pair.publicKey);
      setPrivateKey(pair.privateKey);
      setPrivateKeyPem(pem);
      setPublicKeyPem(pubPem);
      setSelectedProfileId(null);
      setProfileName('');
      appendLog('Generated key pair. Remember to enroll the public key using NFC.');
    } catch (error) {
      reportError('Failed to generate key', error);
    } finally {
      setBusyAction(null);
    }
  }, [appendLog, reportError]);

  const handleProfileChange = useCallback(
    async (profileId: string | null) => {
      setSelectedProfileId(profileId);
      if (!profileId) {
        setProfileName('');
        setPrivateKeyPem('');
        setPublicKeyPem('');
        setPrivateKey(null);
        return;
      }
      const profile = profiles.find((item) => item.id === profileId);
      if (!profile) {
        appendLog('Profile not found.');
        return;
      }
      setProfileName(profile.name);
      setPrivateKeyPem(profile.privateKeyPem);
      setPublicKeyPem(profile.publicKeyPem);
      try {
        const imported = await importPrivateKeyPem(profile.privateKeyPem);
        setPrivateKey(imported);
        const refreshedPublic = await exportPublicKeyPemFromPrivate(imported);
        if (!pemEquals(refreshedPublic, profile.publicKeyPem)) {
          const updated = profiles.map((item) =>
            item.id === profile.id ? { ...item, publicKeyPem: refreshedPublic } : item,
          );
          setProfiles(updated);
          persistProfiles(updated).catch(() => {});
          setPublicKeyPem(refreshedPublic);
          appendLog(`Profile "${profile.name}" public key refreshed.`);
        } else {
          appendLog(`Loaded profile "${profile.name}".`);
        }
      } catch (error) {
        setPrivateKey(null);
        reportError(`Failed to load profile "${profile.name}"`, error);
      }
    },
    [appendLog, reportError, profiles],
  );

  useEffect(() => {
    if (!profiles.length) {
      if (hasAppliedInitialProfile) {
        setHasAppliedInitialProfile(false);
      }
      return;
    }
    if (!hasAppliedInitialProfile && !selectedProfileId) {
      setHasAppliedInitialProfile(true);
      void handleProfileChange(profiles[0].id);
    }
  }, [handleProfileChange, hasAppliedInitialProfile, profiles, selectedProfileId]);

  const handleSaveProfile = useCallback(async () => {
    try {
      const name = profileName.trim();
      if (!name) {
        throw new Error('Profile name is required');
      }
      const pem = privateKeyPem.trim();
      if (!pem) {
        throw new Error('Provide a private key before saving');
      }
      const imported = await importPrivateKeyPem(pem);
      setPrivateKey(imported);
      const publicKey = await exportPublicKeyPemFromPrivate(imported);
      setPublicKeyPem(publicKey);
      let updatedProfiles = [...profiles];
      let profileId = selectedProfileId;
      if (profileId && updatedProfiles.some((item) => item.id === profileId)) {
        updatedProfiles = updatedProfiles.map((item) =>
          item.id === profileId ? { ...item, name, privateKeyPem: pem, publicKeyPem: publicKey } : item,
        );
        appendLog(`Updated profile "${name}".`);
      } else {
        const newProfile: StoredProfile = {
          id: createProfileId(),
          name,
          privateKeyPem: pem,
          publicKeyPem: publicKey,
        };
        updatedProfiles = [...updatedProfiles, newProfile];
        profileId = newProfile.id;
        appendLog(`Saved new profile "${name}".`);
      }
      setProfiles(updatedProfiles);
      setSelectedProfileId(profileId);
      await persistProfiles(updatedProfiles);
    } catch (error) {
      reportError('Failed to save profile', error);
    }
  }, [appendLog, privateKeyPem, profileName, profiles, reportError, selectedProfileId]);

  const handleDeleteProfile = useCallback(async () => {
    if (!selectedProfileId) {
      return;
    }
    const profile = profiles.find((item) => item.id === selectedProfileId);
    const updated = profiles.filter((item) => item.id !== selectedProfileId);
    setProfiles(updated);
    setSelectedProfileId(null);
    setProfileName('');
    setPrivateKeyPem('');
    setPublicKeyPem('');
    setPrivateKey(null);
    await persistProfiles(updated);
    if (profile) {
      appendLog(`Deleted profile "${profile.name}".`);
    }
  }, [appendLog, profiles, selectedProfileId]);

  const handleSelectVehicle = useCallback(async () => {
    try {
      setBusyAction('select-vehicle');
      const normalizedVin = normalizeVin(vin);
      if (!normalizedVin) {
        throw new Error('VIN is required');
      }
      setVin(normalizedVin);
      await AsyncStorage.setItem(VIN_STORAGE_KEY, normalizedVin);
      appendLog('Selecting Tesla BLE device…');
      const session = getSession();
      await session.connect();
      const info = session.getSelectedDeviceInfo();
      setDeviceInfo(info);
      appendLog('Bluetooth device selected and connected.');
      if (info) {
        appendLog(`Connected to ${info.name ?? info.id}.`);
      }
    } catch (error) {
      reportError('Failed to select device', error);
    } finally {
      setBusyAction(null);
    }
  }, [appendLog, getSession, reportError, vin]);

  const handleEnsureSession = useCallback(async () => {
    try {
      setBusyAction('connect-session');
      const key = await ensurePrivateKeyValue();
      const session = getSession();
      await session.ensureSession(key);
      appendLog('Session established successfully.');
      setDeviceInfo(session.getSelectedDeviceInfo());
    } catch (error) {
      reportError('Handshake failed', error);
    } finally {
      setBusyAction(null);
    }
  }, [appendLog, ensurePrivateKeyValue, getSession, reportError]);

  const handleVehicleStateResult = useCallback(
    (category: StateCategory, result: VehicleStateResult, latencyMs: number) => {
      if (category === StateCategory.Drive) {
        setStoreDriveState(result);
      }
      const timestamp = formatTimestamp(new Date());
      const payload = JSON.stringify(result.vehicleData, null, 2);
      setStateOutput(`Last update (${timestamp}) — Category: ${category} — Latency: ${latencyMs} ms\n${payload}`);
    },
    [setStoreDriveState],
  );

  const fetchCategory = useCallback(
    async (session: TeslaBleSession, key: TeslaPrivateKey, category: StateCategory, logEvents: boolean) => {
      if (logEvents) {
        appendLog(`Requesting vehicle state: ${prettyLabel(category)}…`);
      }
      const startedAt = performance.now();
      const result = await session.getState(category, key);
      const latencyMs = Math.round(performance.now() - startedAt);
      handleVehicleStateResult(category, result, latencyMs);
      if (logEvents) {
        appendLog(`Vehicle state updated at ${formatTimestamp(new Date())} (latency ${latencyMs} ms).`);
      }
    },
    [appendLog, handleVehicleStateResult],
  );

  const performVehicleStateFetch = useCallback(
    async (mode: AutoRefreshMode) => {
      const session = getSession();
      const key = await ensurePrivateKeyValue();
      await fetchCategory(session, key, stateCategory, mode === 'manual');
      if (mode === 'auto' && stateCategory !== StateCategory.Drive) {
        await fetchCategory(session, key, StateCategory.Drive, false);
      }
    },
    [ensurePrivateKeyValue, fetchCategory, getSession, stateCategory],
  );

  useEffect(() => {
    if (!autoRefreshActive) {
      if (autoRefreshTimer.current) {
        clearTimeout(autoRefreshTimer.current);
        autoRefreshTimer.current = null;
        appendLog('Auto refresh disabled.');
      }
      return;
    }

    let cancelled = false;
    appendLog('Auto refresh enabled.');

    const run = async () => {
      if (cancelled) {
        return;
      }
      try {
        await performVehicleStateFetch('auto');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        appendLog(`Auto refresh failed: ${detail}`);
        console.error('Auto refresh error', error);
        setStoreAutoRefreshActive(false);
        appendLog('Auto refresh stopped due to error.');
        return;
      }
      if (cancelled || !autoRefreshActive) {
        return;
      }
      const delay = getCurrentRefreshInterval(String(refreshInterval));
      autoRefreshTimer.current = setTimeout(run, delay);
    };

    run();

    return () => {
      cancelled = true;
      if (autoRefreshTimer.current) {
        clearTimeout(autoRefreshTimer.current);
        autoRefreshTimer.current = null;
      }
    };
  }, [appendLog, autoRefreshActive, performVehicleStateFetch, refreshInterval, setStoreAutoRefreshActive]);

  const handleManualFetch = useCallback(async () => {
    try {
      setBusyAction('fetch-state');
      await performVehicleStateFetch('manual');
    } catch (error) {
      reportError('Failed to fetch state', error);
    } finally {
      setBusyAction(null);
    }
  }, [performVehicleStateFetch, reportError]);

  const handleRefreshIntervalBlur = useCallback(
    (value: string) => {
      const sanitized = sanitizeRefreshInterval(value);
      setRefreshInterval(sanitized);
      AsyncStorage.setItem(REFRESH_INTERVAL_STORAGE_KEY, String(sanitized)).catch(() => {});
    },
    [],
  );

  const handleEnrollKey = useCallback(async () => {
    try {
      setBusyAction('enroll');
      const session = getSession();
      await session.connect();
      const publicKeyRaw = await resolvePublicKeyRaw(privateKey, publicKeyPem, ensurePrivateKeyValue);
      appendLog('Sending add-key request over BLE…');
      await session.sendAddKeyRequest(
        publicKeyRaw,
        KeyRole.ROLE_VEHICLE_MONITOR,
        KeyFormFactor.KEY_FORM_FACTOR_CLOUD_KEY,
      );
      appendLog('Request sent. Complete the approval on the vehicle UI.');
    } catch (error) {
      reportError('Failed to enroll key', error);
    } finally {
      setBusyAction(null);
    }
  }, [appendLog, ensurePrivateKeyValue, getSession, privateKey, publicKeyPem, reportError]);

  const isBusy = useCallback((action: string) => busyAction === action, [busyAction]);

  const deviceInfoText = useMemo(() => {
    if (!deviceInfo) {
      return 'Not connected.';
    }
    const parts = [
      `Name: ${deviceInfo.name ?? '(none)'}`,
      `ID: ${deviceInfo.id}`,
    ];
    if (deviceInfo.mtu) {
      parts.push(`MTU: ${deviceInfo.mtu}`);
    }
    if (deviceInfo.serviceUUIDs?.length) {
      parts.push(`Services: ${deviceInfo.serviceUUIDs.join(', ')}`);
    }
    parts.push(`Connected: ${deviceInfo.isConnected ? 'Yes' : 'No'}`);
    return parts.join('\n');
  }, [deviceInfo]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Vehicle</Text>
      <View style={styles.fieldGroup}>
        <Field label="VIN">
          <TextInput
            value={vin}
            onChangeText={(value) => setVin(normalizeVin(value))}
            placeholder="5YJ3E1EA7JF000000"
            placeholderTextColor="#64748b"
            style={styles.input}
            autoCapitalize="characters"
          />
        </Field>
        <Text style={styles.deviceInfoLabel}>Connected Device</Text>
        <Text style={styles.deviceInfo}>{deviceInfoText}</Text>
        <View style={styles.row}>
          <AppButton
            label="Select Vehicle"
            onPress={handleSelectVehicle}
            variant="primary"
            disabled={isBusy('select-vehicle')}
            fullWidth
          />
          <AppButton
            label="Connect"
            onPress={handleEnsureSession}
            disabled={isBusy('connect-session')}
            fullWidth
          />
        </View>
      </View>

      <Text style={styles.heading}>Keys</Text>
      <View style={styles.fieldGroup}>
        <Field label="Profile">
          <Picker
            selectedValue={selectedProfileId ?? ''}
            onValueChange={(value) => handleProfileChange(value || null)}
            dropdownIconColor="#94a3b8"
            style={styles.picker}
          >
            <Picker.Item label="New profile…" value="" />
            {profiles.map((profile) => (
              <Picker.Item key={profile.id} label={profile.name} value={profile.id} />
            ))}
          </Picker>
        </Field>
        <Field label="Profile Name">
          <TextInput
            value={profileName}
            onChangeText={setProfileName}
            placeholder="Driver Profile"
            placeholderTextColor="#64748b"
            style={styles.input}
          />
        </Field>
        <Field label="Private key (PEM)">
          <TextInput
            value={privateKeyPem}
            onChangeText={(value) => {
              setPrivateKeyPem(value);
              setPrivateKey(null);
            }}
            placeholder="Paste EC PRIVATE KEY generated via tesla-keygen…"
            placeholderTextColor="#64748b"
            style={[styles.input, styles.multiline]}
            multiline
          />
        </Field>
        <Field label="Public key (share with vehicle)">
          <TextInput
            value={publicKeyPem}
            editable={false}
            placeholder="Generate or import a key first"
            placeholderTextColor="#64748b"
            style={[styles.input, styles.multiline, styles.readonlyInput]}
            multiline
          />
        </Field>
        <View style={styles.row}>
          <AppButton
            label="Generate Key"
            onPress={handleGenerateKey}
            variant="primary"
            disabled={isBusy('generate-key')}
            fullWidth
          />
          <AppButton label="Save Profile" onPress={handleSaveProfile} fullWidth />
        </View>
        <View style={styles.row}>
          <AppButton label="New Profile" onPress={() => handleProfileChange(null)} fullWidth />
          <AppButton label="Delete Profile" onPress={handleDeleteProfile} variant="danger" fullWidth />
        </View>
        <View style={styles.row}>
          <AppButton
            label="Enroll Key"
            onPress={handleEnrollKey}
            disabled={isBusy('enroll')}
            fullWidth
          />
          <AppButton
            label={autoRefreshActive ? 'Stop Auto Refresh' : 'Start Auto Refresh'}
            onPress={() => setStoreAutoRefreshActive(!autoRefreshActive)}
            variant="primary"
            fullWidth
          />
        </View>
      </View>

      <Text style={styles.heading}>Vehicle State</Text>
      <View style={styles.fieldGroup}>
        <Field label="State Category">
          <Picker
            selectedValue={stateCategory}
            onValueChange={(value) => setStateCategory(value as StateCategory)}
            dropdownIconColor="#94a3b8"
            style={styles.picker}
          >
            {stateCategoryOptions.map((value) => (
              <Picker.Item key={value} label={prettyLabel(value)} value={value} />
            ))}
          </Picker>
        </Field>
        <Field label="Auto Refresh Interval (ms)">
          <TextInput
            value={String(refreshInterval)}
            onChangeText={(value) => setRefreshInterval(Number(value))}
            onEndEditing={(event) => handleRefreshIntervalBlur(event.nativeEvent.text)}
            keyboardType="numeric"
            style={styles.input}
          />
        </Field>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Auto Refresh</Text>
          <Switch
            value={autoRefreshActive}
            onValueChange={(value) => setStoreAutoRefreshActive(value)}
          />
        </View>
        <View style={styles.row}>
          <AppButton
            label="Fetch State"
            onPress={handleManualFetch}
            disabled={isBusy('fetch-state')}
            variant="primary"
            fullWidth
          />
        </View>
        <Text style={styles.logOutput}>{stateOutput}</Text>
      </View>

      <Text style={styles.heading}>Log</Text>
      <View style={styles.fieldGroup}>
        <Text style={styles.logOutput}>{logOutput}</Text>
      </View>
    </ScrollView>
  );
}

interface FieldProps {
  label: string;
  children: React.ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

async function persistProfiles(items: StoredProfile[]): Promise<void> {
  await AsyncStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(items));
}

function createProfileId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

function normalizeVin(value: string): string {
  return value.trim().toUpperCase();
}

function formatTimestamp(date: Date): string {
  return date.toLocaleString();
}

function sanitizeRefreshInterval(value: string | number): number {
  const numeric = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_REFRESH_INTERVAL_MS;
  }
  const rounded = Math.round(numeric);
  return Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(MIN_REFRESH_INTERVAL_MS, rounded));
}

function getCurrentRefreshInterval(value: string): number {
  const sanitized = sanitizeRefreshInterval(value);
  return sanitized;
}

function prettyLabel(value: string): string {
  return value.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function pemEquals(a: string, b: string): boolean {
  return normalizePem(a) === normalizePem(b);
}

function normalizePem(value: string): string {
  return value.trim().replace(/\r\n/g, '\n');
}

async function resolvePublicKeyRaw(
  privateKey: TeslaPrivateKey | null,
  publicKeyText: string,
  ensurePrivateKeyValue: () => Promise<TeslaPrivateKey>,
): Promise<Uint8Array> {
  if (publicKeyText.trim()) {
    return publicKeyPemToRaw(publicKeyText.trim());
  }
  const key = privateKey ?? (await ensurePrivateKeyValue());
  return exportPublicKeyFromPrivate(key);
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    gap: 16,
    backgroundColor: '#020617',
  },
  heading: {
    fontSize: 18,
    fontWeight: '700',
    color: '#f8fafc',
    marginBottom: 8,
  },
  fieldGroup: {
    backgroundColor: '#0f172a',
    borderRadius: 16,
    padding: 16,
    gap: 16,
    borderWidth: 1,
    borderColor: '#1f2937',
  },
  field: {
    gap: 8,
  },
  label: {
    color: '#c7d2fe',
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderColor: '#1e293b',
    borderRadius: 10,
    padding: 12,
    color: '#f8fafc',
    fontSize: 15,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  readonlyInput: {
    backgroundColor: '#111827',
  },
  picker: {
    color: '#f8fafc',
    backgroundColor: '#111827',
    borderRadius: 10,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toggleLabel: {
    color: '#e2e8f0',
    fontSize: 16,
    fontWeight: '600',
  },
  logOutput: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'Courier' }),
    fontSize: 13,
    color: '#e2e8f0',
    backgroundColor: '#020617',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  deviceInfoLabel: {
    color: '#c7d2fe',
    fontWeight: '600',
    fontSize: 14,
  },
  deviceInfo: {
    color: '#94a3b8',
    fontSize: 12,
    lineHeight: 18,
    backgroundColor: '#020617',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
});
