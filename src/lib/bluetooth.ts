import { BleManager, Characteristic, Device, Subscription } from 'react-native-ble-plx';
import { fromByteArray, toByteArray } from 'base64-js';
import { Platform } from 'react-native';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import {
  TESLA_SERVICE_UUID,
  TESLA_TX_CHAR_UUID,
  TESLA_RX_CHAR_UUID,
  HEADER_SIZE,
  DEFAULT_MAX_MESSAGE_SIZE,
  DEFAULT_RX_TIMEOUT_MS,
  WEB_BLUETOOTH_DEFAULT_BLOCK,
  TESLA_PAIRING_SERVICE_UUID,
} from './constants';

const MIN_BLOCK_LENGTH = 20;
type WriteMode = 'with-response' | 'without-response';

export const MESSAGE_EVENT = 'message';
export const DISCONNECT_EVENT = 'disconnect';

export enum DeviceDiscoveryMode {
  VinPrefixPromptFilter = 'vin-prefix-prompt-filter',
  VinPrefixValidation = 'vin-prefix-validation',
  Unfiltered = 'unfiltered',
}

export interface TransportMessageEvent {
  detail: Uint8Array;
}

export interface TeslaBleTransportOptions {
  vin?: string;
  preferredBlockLength?: number;
  deviceDiscoveryMode?: DeviceDiscoveryMode;
  scanTimeoutMs?: number;
}

type Listener<T> = (payload: T) => void;

class SimpleEventEmitter {
  private listeners = new Map<string, Set<Listener<any>>>();

  on<T>(event: string, listener: Listener<T>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  off<T>(event: string, listener: Listener<T>): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit<T>(event: string, payload: T): void {
    const listeners = this.listeners.get(event);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`[BLE] Listener for "${event}" failed`, error);
      }
    }
  }
}

export class TeslaBleTransport {
  private readonly options: TeslaBleTransportOptions;
  private readonly ble = new BleManager();
  private readonly events = new SimpleEventEmitter();

  private device: Device | null = null;
  private txChar: Characteristic | null = null;
  private rxChar: Characteristic | null = null;
  private rxSubscription: Subscription | null = null;
  private disconnectSubscription: Subscription | null = null;
  private buffer = new Uint8Array(0);
  private lastNotification = 0;
  private blockLength = WEB_BLUETOOTH_DEFAULT_BLOCK;
  private writeMode: WriteMode = 'with-response';
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: TeslaBleTransportOptions = {}) {
    this.options = options;
  }

  get connected(): boolean {
    return Boolean(this.device && this.txChar && this.rxChar);
  }

  get bluetoothDevice(): Device | null {
    return this.device;
  }

  async connect(existing?: Device): Promise<void> {
    if (this.connected) {
      return;
    }
    if (Platform.OS === 'android') {
      await ensureAndroidBlePermissions();
    }
    const target = existing ?? (await this.requestDevice());
    const connectedDevice = await target.connect();
    this.disconnectSubscription?.remove();
    this.disconnectSubscription = connectedDevice.onDisconnected(() => {
      this.handleExternalDisconnect();
    });

    const discovered = await connectedDevice.discoverAllServicesAndCharacteristics();
    let preparedDevice: Device = discovered;
    if (Platform.OS === 'android') {
      try {
        preparedDevice = await discovered.requestMTU(247);
      } catch (error) {
        console.warn('Failed to request MTU, continuing with default.', error);
      }
    }

    const services = await preparedDevice.services();
    const teslaService = services.find((service) => matchesUuid(service.uuid, TESLA_SERVICE_UUID));
    if (!teslaService) {
      throw new Error('Tesla BLE service not available on device');
    }

    const characteristics = await teslaService.characteristics();
    const tx = characteristics.find((char) => matchesUuid(char.uuid, TESLA_TX_CHAR_UUID));
    const rx = characteristics.find((char) => matchesUuid(char.uuid, TESLA_RX_CHAR_UUID));
    if (!tx || !rx) {
      throw new Error('Tesla BLE characteristics missing');
    }

    this.txChar = tx;
    this.rxChar = rx;
    this.device = preparedDevice;
    this.writeMode = tx.isWritableWithResponse ? 'with-response' : 'without-response';
    this.blockLength = determineBlockLength(preparedDevice.mtu ?? 23, this.options.preferredBlockLength);
    console.log('[BLE] MTU resolved to', preparedDevice.mtu ?? 23, '=> block length', this.blockLength);

    await this.startNotifications();
  }

  async disconnect(): Promise<void> {
    try {
      await this.rxSubscription?.remove();
    } catch (err) {
      console.warn('Failed to stop notifications', err);
    }
    this.rxSubscription = null;
    try {
      await this.disconnectSubscription?.remove();
    } catch (err) {
      console.warn('Failed to remove disconnect listener', err);
    }
    this.disconnectSubscription = null;
    if (this.device) {
      try {
        await this.ble.cancelDeviceConnection(this.device.id);
      } catch (err) {
        console.warn('Error cancelling BLE connection', err);
      }
    }
    this.cleanupConnectionState();
    this.writeMode = 'with-response';
  }

  async send(payload: Uint8Array): Promise<void> {
    if (!this.txChar) {
      throw new Error('TX characteristic not ready');
    }
    if (payload.length > DEFAULT_MAX_MESSAGE_SIZE) {
      throw new Error(`Payload too large (${payload.length})`);
    }
    const packet = new Uint8Array(HEADER_SIZE + payload.length);
    packet[0] = (payload.length >> 8) & 0xff;
    packet[1] = payload.length & 0xff;
    packet.set(payload, HEADER_SIZE);

    const task = this.writeChain.then(() => this.writePacket(packet));
    this.writeChain = task.catch(() => {
      // Swallow to keep the chain alive.
    });
    await task;
  }

  addMessageListener(listener: (event: TransportMessageEvent) => void): void {
    this.events.on(MESSAGE_EVENT, listener);
  }

  removeMessageListener(listener: (event: TransportMessageEvent) => void): void {
    this.events.off(MESSAGE_EVENT, listener);
  }

  addDisconnectListener(listener: () => void): void {
    this.events.on(DISCONNECT_EVENT, listener);
  }

  removeDisconnectListener(listener: () => void): void {
    this.events.off(DISCONNECT_EVENT, listener);
  }

  private async requestDevice(): Promise<Device> {
    const filters = [TESLA_PAIRING_SERVICE_UUID, TESLA_SERVICE_UUID].map((uuid) => normalizeUuid(uuid));
    const expectedPrefix = this.options.vin ? await vinToLocalName(this.options.vin) : null;
    const mode = this.options.deviceDiscoveryMode ?? DeviceDiscoveryMode.VinPrefixValidation;
    const scanTimeout = this.options.scanTimeoutMs ?? 20000;

    return new Promise<Device>((resolve, reject) => {
      let resolved = false;
      const stopScan = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        try {
          this.ble.stopDeviceScan();
        } catch (error) {
          console.warn('Failed stopping device scan', error);
        }
      };
      const timer = setTimeout(() => {
        stopScan();
        reject(new Error('Timed out while scanning for Tesla vehicle. Is it awake and nearby?'));
      }, scanTimeout);

      const acceptDevice = (device: Device) => {
        clearTimeout(timer);
        stopScan();
        resolve(device);
      };

      this.ble.startDeviceScan(filters, { allowDuplicates: false }, (error, device) => {
        if (error) {
          clearTimeout(timer);
          stopScan();
          reject(error);
          return;
        }
        if (!device) {
          return;
        }
        console.log(`Discovered device: ${device.name ?? device.localName ?? 'Unnamed'} (${device.id})`);
        if (!expectedPrefix || mode === DeviceDiscoveryMode.Unfiltered) {
          acceptDevice(device);
          return;
        }
        const name = device.name ?? device.localName ?? '';
        if (name.startsWith(expectedPrefix)) {
          acceptDevice(device);
        }
      });
    });
  }

  private async startNotifications(): Promise<void> {
    if (!this.rxChar) {
      throw new Error('RX characteristic not ready');
    }
    this.rxSubscription = this.rxChar.monitor((error, characteristic) => {
      if (error) {
        console.warn('RX notification error', error);
        return;
      }
      const value = characteristic?.value;
      if (!value) {
        return;
      }
      try {
        const chunk = toByteArray(value);
        this.handleNotification(chunk);
      } catch (err) {
        console.error('Failed to process BLE notification', err);
      }
    });
  }

  private async writePacket(packet: Uint8Array): Promise<void> {
    for (let offset = 0; offset < packet.length; offset += this.blockLength) {
      const block = packet.subarray(offset, Math.min(offset + this.blockLength, packet.length));
      console.log(
        '[BLE] Writing chunk',
        `${block.length} bytes`,
        `mode=${this.writeMode}`,
        `mtuBlock=${this.blockLength}`,
        `remaining=${packet.length - (offset + block.length)}`,
      );
      await this.writeChunk(block);
    }
  }

  private async writeChunk(block: Uint8Array): Promise<void> {
    if (!this.txChar) {
      throw new Error('TX characteristic not ready');
    }
    const encoded = fromByteArray(block);
    while (true) {
      try {
        if (this.writeMode === 'with-response' && this.txChar.isWritableWithResponse) {
          await this.txChar.writeWithResponse(encoded);
          return;
        }
        if (this.writeMode === 'without-response' && this.txChar.isWritableWithoutResponse) {
          await this.txChar.writeWithoutResponse(encoded);
          return;
        }
        throw new Error('TX characteristic write mode unsupported');
      } catch (error) {
        if (!this.tryFallbackWriteMode(error)) {
          throw error;
        }
      }
    }
  }

  private tryFallbackWriteMode(error: unknown): boolean {
    const asError = error instanceof Error ? error : null;
    if (asError) {
      console.warn('BLE write error, attempting fallback', asError.message);
    }
    if (this.writeMode === 'with-response' && this.txChar?.isWritableWithoutResponse) {
      this.writeMode = 'without-response';
      console.warn('[BLE] Falling back to writeWithoutResponse');
      return true;
    }
    if (this.writeMode === 'without-response' && this.txChar?.isWritableWithResponse) {
      this.writeMode = 'with-response';
      console.warn('[BLE] Falling back to writeWithResponse');
      return true;
    }
    if (this.blockLength > MIN_BLOCK_LENGTH) {
      this.blockLength = Math.max(MIN_BLOCK_LENGTH, Math.floor(this.blockLength / 2));
      console.warn('[BLE] Reducing block size due to repeated errors', this.blockLength);
      return true;
    }
    return false;
  }

  private handleNotification(chunk: Uint8Array) {
    if (!chunk.length) {
      return;
    }
    const now = Date.now();
    if (now - this.lastNotification > DEFAULT_RX_TIMEOUT_MS) {
      this.buffer = new Uint8Array(0);
    }
    this.lastNotification = now;
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    this.flush();
  }

  private flush(): void {
    while (this.buffer.length >= HEADER_SIZE) {
      const length = (this.buffer[0] << 8) | this.buffer[1];
      if (length > DEFAULT_MAX_MESSAGE_SIZE) {
        console.error('Received oversized BLE packet, resetting buffer');
        this.buffer = new Uint8Array(0);
        return;
      }
      if (this.buffer.length < HEADER_SIZE + length) {
        return;
      }
      const message = this.buffer.slice(HEADER_SIZE, HEADER_SIZE + length);
      this.buffer = this.buffer.slice(HEADER_SIZE + length);
      this.events.emit<TransportMessageEvent>(MESSAGE_EVENT, { detail: message });
    }
  }

  private handleExternalDisconnect(): void {
    this.cleanupConnectionState();
    this.events.emit(DISCONNECT_EVENT, undefined);
  }

  private cleanupConnectionState(): void {
    try {
      this.rxSubscription?.remove();
    } catch {
      // ignore
    }
    this.rxSubscription = null;
    this.device = null;
    this.txChar = null;
    this.rxChar = null;
    this.buffer = new Uint8Array(0);
  }
}

function matchesUuid(value: string, target: string): boolean {
  return normalizeUuid(value) === normalizeUuid(target);
}

function normalizeUuid(value: string | number): string {
  if (typeof value === 'number') {
    return `0000${value.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
  }
  return value.toLowerCase();
}

function determineBlockLength(mtu: number, preferred?: number): number {
  const maxPayload = Math.max(MIN_BLOCK_LENGTH, mtu - 3);
  if (preferred) {
    return Math.min(maxPayload, preferred);
  }
  return Math.min(maxPayload, WEB_BLUETOOTH_DEFAULT_BLOCK);
}

async function vinToLocalName(vin: string): Promise<string> {
  const digestHex = (await digestStringAsync(CryptoDigestAlgorithm.SHA1, vin)).toLowerCase();
  const hashHex = digestHex.slice(0, 16);
  return `S${hashHex}C`;
}

async function ensureAndroidBlePermissions(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  // Use dynamic require to avoid type-level issues and keep this logic
  // Android-only at runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { PermissionsAndroid } = require('react-native') as typeof import('react-native');

  const androidVersion =
    typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version) || 0;

  const requiredPermissions = new Set<string>();
  if (PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION) {
    requiredPermissions.add(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  }
  if (PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION) {
    requiredPermissions.add(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION);
  }
  if (androidVersion >= 31) {
    if (PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN) {
      requiredPermissions.add(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
    }
    if (PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT) {
      requiredPermissions.add(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
    }
  }

  const missing: string[] = [];
  for (const permission of requiredPermissions) {
    const granted = await PermissionsAndroid.check(permission as any);
    if (!granted) {
      missing.push(permission);
    }
  }

  if (!missing.length) {
    return;
  }

  const result = await PermissionsAndroid.requestMultiple(missing as any);
  const denied = Object.entries(result).filter(
    ([, status]) => status !== PermissionsAndroid.RESULTS.GRANTED,
  );

  if (denied.length > 0) {
    const deniedList = denied.map(([name]) => name).join(', ');
    throw new Error(
      `Bluetooth permissions not granted (${deniedList}). Enable Bluetooth and location permissions in system settings and try again.`,
    );
  }
}
export type BleDevice = Device;
