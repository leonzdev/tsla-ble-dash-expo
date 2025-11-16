import {
  DEFAULT_REQUEST_FLAGS,
  DOMAIN_INFOTAINMENT,
  SIGNATURE_TYPE_AES_GCM_PERSONALIZED,
  SIGNATURE_TYPE_AES_GCM_RESPONSE,
  SIGNATURE_TYPE_HMAC,
  TAG_CHALLENGE,
  TAG_COUNTER,
  TAG_DOMAIN,
  TAG_EPOCH,
  TAG_EXPIRES_AT,
  TAG_FAULT,
  TAG_FLAGS,
  TAG_PERSONALIZATION,
  TAG_REQUEST_HASH,
  TAG_SIGNATURE_TYPE,
  TAG_END,
} from './constants';
import {
  TeslaBleTransport,
  MESSAGE_EVENT,
  DISCONNECT_EVENT,
  TransportMessageEvent,
  DeviceDiscoveryMode,
  BleDevice,
} from './bluetooth';
export { DeviceDiscoveryMode } from './bluetooth';
export { StateCategory, KeyRole, KeyFormFactor } from './protocol';
import {
  randomBytes,
  deriveSessionKeys,
  exportPublicKeyFromPrivate,
  encryptAesGcm,
  decryptAesGcm,
  concat,
  verifyHmacSha256,
  sha256,
  defaultExpiry,
  TeslaPrivateKey,
} from './crypto';
import {
  encodeSessionInfoRequest,
  decodeRoutableMessage,
  decodeSessionInfo,
  extractSessionInfoTag,
  encodeEncryptedCommand,
  encodeGetVehicleData,
  decodeVehicleData,
  decodeCarServerResponse,
  carServerResponseToObject,
  StateCategory,
  UniversalDomain,
  encodeVcsecAddKeyRequest,
  KeyRole,
  KeyFormFactor,
} from './protocol';

const REQUEST_TIMEOUT_MS = 10_000;
const GCM_TAG_SIZE = 16;
const AES_GCM_NONCE_SIZE = 12;

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timeout: number;
  handler?: (message: any, raw: Uint8Array) => Promise<void>;
}

interface DomainSessionState {
  keys: Awaited<ReturnType<typeof deriveSessionKeys>>;
  counter: number;
  epoch: Uint8Array;
  vehiclePublicKey: Uint8Array;
  clientPublicKey: Uint8Array;
  timeZeroMs: number;
}

export interface TeslaBleSessionOptions {
  vin: string;
  transport?: TeslaBleTransport;
  domain?: UniversalDomain;
  flags?: number;
  deviceDiscoveryMode?: DeviceDiscoveryMode;
}

export interface VehicleStateResult {
  category: StateCategory;
  rawResponse: Uint8Array;
  response: any;
  vehicleData: any;
}

export interface SelectedDeviceInfo {
  name: string | null;
  id: string;
  serviceUUIDs?: string[] | null;
  mtu?: number;
  isConnected: boolean;
}

const textEncoder = new TextEncoder();

export class TeslaBleSession {
  private readonly transport: TeslaBleTransport;
  private readonly vin: string;
  private readonly domain: UniversalDomain;
  private readonly flags: number;
  private readonly routingAddress: Uint8Array;

  private pending = new Map<string, PendingRequest>();
  private sessionState: DomainSessionState | null = null;
  private connected = false;

  constructor(options: TeslaBleSessionOptions) {
    this.vin = options.vin;
    this.domain = options.domain ?? DOMAIN_INFOTAINMENT;
    this.flags = options.flags ?? DEFAULT_REQUEST_FLAGS;
    this.transport = options.transport
      ?? new TeslaBleTransport({
        vin: options.vin,
        deviceDiscoveryMode: options.deviceDiscoveryMode,
        preferredBlockLength: 1024,
      });
    this.routingAddress = randomBytes(16);
  }

  async connect(device?: BleDevice): Promise<void> {
    if (this.connected) return;
    await this.transport.connect(device);
    this.transport.addMessageListener(this.onMessage as (event: TransportMessageEvent) => void);
    this.transport.addDisconnectListener(this.onDisconnect);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.transport.removeMessageListener(this.onMessage as (event: TransportMessageEvent) => void);
    this.transport.removeDisconnectListener(this.onDisconnect);
    await this.transport.disconnect();
    this.connected = false;
    this.sessionState = null;
    this.failPending(new Error('Disconnected'));
  }

  async sendAddKeyRequest(publicKeyRaw: Uint8Array, role: number, formFactor: number): Promise<void> {
    // BLE-only flow; no authenticated session required. The vehicle will prompt for NFC tap.
    if (!this.connected) {
      await this.connect();
    }
    const payload = encodeVcsecAddKeyRequest({ publicKeyRaw, role, formFactor });
    await this.transport.send(payload);
  }

  getSelectedDeviceInfo(): SelectedDeviceInfo | null {
    const device = this.transport.bluetoothDevice;
    if (!device) {
      return null;
    }
    return {
      name: device.name ?? null,
      id: device.id,
      serviceUUIDs: device.serviceUUIDs ?? null,
      mtu: device.mtu,
      isConnected: this.connected,
    } satisfies SelectedDeviceInfo;
  }

  async ensureSession(privateKey: TeslaPrivateKey): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
    if (this.sessionState) {
      return;
    }
    await this.performHandshake(privateKey);
  }

  async getState(category: StateCategory, privateKey: TeslaPrivateKey): Promise<VehicleStateResult> {
    await this.ensureSession(privateKey);
    if (!this.sessionState) {
      throw new Error('Session not established');
    }
    const payload = encodeGetVehicleData(category);
    const responseBytes = await this.sendEncryptedCommand(payload);
    const response = decodeCarServerResponse(responseBytes);
    if (response.actionStatus?.result === 1) {
      const reason = response.actionStatus?.resultReason?.plainText ?? 'unknown error';
      throw new Error(`Vehicle reported error: ${reason}`);
    }
    const vehicleData = decodeVehicleData(responseBytes);
    return {
      category,
      rawResponse: responseBytes,
      response: carServerResponseToObject(response),
      vehicleData,
    };
  }

  private async performHandshake(privateKey: TeslaPrivateKey): Promise<void> {
    const clientPublicKey = await exportPublicKeyFromPrivate(privateKey);
    const uuid = randomBytes(16);
    const { buffer } = encodeSessionInfoRequest(this.domain, clientPublicKey, this.routingAddress, uuid);
    const message = await this.sendAndAwait(buffer, uuid);
    const sessionInfoBytes = message.sessionInfo as Uint8Array | undefined;
    if (!sessionInfoBytes) {
      throw new Error('Vehicle response missing session info');
    }
    const sessionInfo = decodeSessionInfo(message);
    const tag = extractSessionInfoTag(message);
    const keys = await deriveSessionKeys({ privateKey, peerPublicKey: sessionInfo.publicKey });

    const metadata = serializeMetadata([
      { tag: TAG_SIGNATURE_TYPE, value: new Uint8Array([SIGNATURE_TYPE_HMAC]) },
      { tag: TAG_PERSONALIZATION, value: textEncoder.encode(this.vin) },
      { tag: TAG_CHALLENGE, value: uuid },
    ]);
    if (!(await verifyHmacSha256(keys.sessionInfoKey, concat(metadata, sessionInfoBytes), tag))) {
      throw new Error('Session info authentication failed');
    }

    const timeZeroMs = Date.now() - sessionInfo.clockTime * 1000;
    this.sessionState = {
      keys,
      counter: sessionInfo.counter,
      epoch: sessionInfo.epoch,
      vehiclePublicKey: sessionInfo.publicKey,
      clientPublicKey,
      timeZeroMs,
    };
  }

  private async sendEncryptedCommand(plaintext: Uint8Array): Promise<Uint8Array> {
    if (!this.sessionState) {
      throw new Error('Session not established');
    }
    const session = this.sessionState;
    session.counter += 1;
    const counter = session.counter;
    const vehicleNow = this.vehicleTimeSeconds();
    const expires = defaultExpiry(vehicleNow);

    const metadataItems = [
      { tag: TAG_SIGNATURE_TYPE, value: new Uint8Array([SIGNATURE_TYPE_AES_GCM_PERSONALIZED]) },
      { tag: TAG_DOMAIN, value: new Uint8Array([this.domain]) },
      { tag: TAG_PERSONALIZATION, value: textEncoder.encode(this.vin) },
      { tag: TAG_EPOCH, value: session.epoch },
      { tag: TAG_EXPIRES_AT, value: uint32ToBytes(expires) },
      { tag: TAG_COUNTER, value: uint32ToBytes(counter) },
    ];
    if (this.flags !== 0) {
      metadataItems.push({ tag: TAG_FLAGS, value: uint32ToBytes(this.flags) });
    }
    const metadata = serializeMetadata(metadataItems);
    const aad = await sha256(metadata);

    const nonce = randomBytes(AES_GCM_NONCE_SIZE);
    const encrypted = await encryptAesGcm(session.keys.aesKeyBytes, nonce, plaintext, aad);
    if (encrypted.length < GCM_TAG_SIZE) {
      throw new Error('Ciphertext too short');
    }
    const ciphertext = encrypted.slice(0, encrypted.length - GCM_TAG_SIZE);
    const tag = encrypted.slice(encrypted.length - GCM_TAG_SIZE);

    const uuid = randomBytes(16);
    const requestId = new Uint8Array(1 + tag.length);
    requestId[0] = SIGNATURE_TYPE_AES_GCM_PERSONALIZED;
    requestId.set(tag, 1);

    const { buffer } = encodeEncryptedCommand({
      domain: this.domain,
      routingAddress: this.routingAddress,
      uuid,
      ciphertext,
      flags: this.flags,
      signature: {
        signerPublicKey: session.clientPublicKey,
        epoch: session.epoch,
        nonce,
        counter,
        expiresAt: expires,
        tag,
      },
    });

    return this.sendAndAwait(buffer, uuid, {
      handler: async (message, raw) => this.handleEncryptedResponse(message, raw, requestId),
    });
  }

  private async handleEncryptedResponse(message: any, raw: Uint8Array, requestId: Uint8Array): Promise<void> {
    if (!this.sessionState) {
      throw new Error('Session not established');
    }
    const session = this.sessionState;
    const signatureData = message.signatureData?.AES_GCM_ResponseData;
    if (!signatureData) {
      throw new Error('Missing AES-GCM response metadata');
    }
    const nonce = new Uint8Array(signatureData.nonce ?? new Uint8Array());
    const counter = signatureData.counter ?? 0;
    const tag = new Uint8Array(signatureData.tag ?? new Uint8Array());
    const ciphertext = new Uint8Array(message.protobufMessageAsBytes ?? new Uint8Array());
    const combined = concat(ciphertext, tag);

    const flags = message.flags ?? 0;
    const metadataItems = [
      { tag: TAG_SIGNATURE_TYPE, value: new Uint8Array([SIGNATURE_TYPE_AES_GCM_RESPONSE]) },
      { tag: TAG_DOMAIN, value: new Uint8Array([message.fromDestination?.domain ?? this.domain]) },
      { tag: TAG_PERSONALIZATION, value: textEncoder.encode(this.vin) },
      { tag: TAG_COUNTER, value: uint32ToBytes(counter) },
    ];
    metadataItems.push({ tag: TAG_FLAGS, value: uint32ToBytes(flags) });
    metadataItems.push({ tag: TAG_REQUEST_HASH, value: requestId });
    const faultCode = message.signedMessageStatus?.signedMessageFault ?? 0;
    metadataItems.push({ tag: TAG_FAULT, value: uint32ToBytes(faultCode) });

    const metadata = serializeMetadata(metadataItems);
    const aad = await sha256(metadata);
    const plaintext = await decryptAesGcm(session.keys.aesKeyBytes, nonce, combined, aad);
    (message as any).__plaintext = plaintext;
  }

  private async sendAndAwait(buffer: Uint8Array, uuid: Uint8Array, options: { handler?: (message: any, raw: Uint8Array) => Promise<void> } = {}): Promise<any> {
    if (!this.connected) {
      throw new Error('Transport not connected');
    }
    const uuidHex = toHex(uuid);
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(uuidHex);
        reject(new Error('Request timed out'));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(uuidHex, {
        resolve: (message) => {
          window.clearTimeout(timeout);
          resolve(message);
        },
        reject: (err) => {
          window.clearTimeout(timeout);
          reject(err);
        },
        timeout,
        handler: options.handler,
      });

      void this.transport.send(buffer).catch((error) => {
        window.clearTimeout(timeout);
        this.pending.delete(uuidHex);
        reject(error);
      });
    }).then(async (message: any) => {
      if (options.handler) {
        const raw = message.__raw as Uint8Array | undefined;
        await options.handler(message, raw ?? new Uint8Array());
        if ((message as any).__plaintext) {
          return (message as any).__plaintext;
        }
      }
      return message;
    });
  }

  private onMessage = (event: CustomEvent<Uint8Array>) => {
    const payload = event.detail;
    let message: any;
    try {
      message = decodeRoutableMessage(payload);
    } catch (err) {
      console.error('Failed to decode RoutableMessage', err);
      return;
    }
    (message as any).__raw = payload;
    const requestUuid = message.requestUuid ?? message.uuid;
    if (!requestUuid) {
      console.warn('Received message without request UUID');
      return;
    }
    const key = toHex(new Uint8Array(requestUuid));
    const pending = this.pending.get(key);
    if (!pending) {
      console.warn('No pending request for UUID', key);
      return;
    }
    this.pending.delete(key);
    pending.resolve(message);
  };

  private onDisconnect = () => {
    this.connected = false;
    this.failPending(new Error('BLE disconnected'));
  };

  private vehicleTimeSeconds(): number {
    if (!this.sessionState) {
      return Math.floor(Date.now() / 1000);
    }
    return Math.floor((Date.now() - this.sessionState.timeZeroMs) / 1000);
  }

  private failPending(err: Error) {
    for (const [key, pending] of this.pending) {
      window.clearTimeout(pending.timeout);
      pending.reject(err);
      this.pending.delete(key);
    }
  }
}

function serializeMetadata(items: Array<{ tag: number; value?: Uint8Array | null }>): Uint8Array {
  let lastTag = -1;
  const chunks: Uint8Array[] = [];
  for (const { tag, value } of items) {
    if (tag < lastTag) {
      throw new Error('Metadata tags must be appended in ascending order');
    }
    lastTag = tag;
    if (!value) {
      continue;
    }
    if (value.length > 255) {
      throw new Error('Metadata value too large');
    }
    const chunk = new Uint8Array(2 + value.length);
    chunk[0] = tag & 0xff;
    chunk[1] = value.length & 0xff;
    chunk.set(value, 2);
    chunks.push(chunk);
  }
  chunks.push(new Uint8Array([TAG_END]));
  return concat(...chunks);
}

function uint32ToBytes(value: number): Uint8Array {
  const buffer = new Uint8Array(4);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, value >>> 0, false);
  return buffer;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
