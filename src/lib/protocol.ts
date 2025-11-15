import protobuf from 'protobufjs';
import protos from './protos.json';

const { Root } = protobuf;

const root = Root.fromJSON(protos as any);

const RoutableMessage = root.lookupType('UniversalMessage.RoutableMessage');
const Destination = root.lookupType('UniversalMessage.Destination');
const SessionInfoRequest = root.lookupType('UniversalMessage.SessionInfoRequest');
const SignatureData = root.lookupType('Signatures.SignatureData');
const AesGcmData = root.lookupType('Signatures.AES_GCM_Personalized_Signature_Data');
const SessionInfoType = root.lookupType('Signatures.SessionInfo');
const CarServerAction = root.lookupType('CarServer.Action');
const CarServerResponseType = root.lookupType('CarServer.Response');
const GetVehicleData = root.lookupType('CarServer.GetVehicleData');
const VehicleData = root.lookupType('CarServer.VehicleData');
// VCSEC (Vehicle Security Controller) types
const VCSEC_UnsignedMessage = root.lookupType('VCSEC.UnsignedMessage');
const VCSEC_ToVCSECMessage = root.lookupType('VCSEC.ToVCSECMessage');
const VCSEC_SignedMessage = root.lookupType('VCSEC.SignedMessage');
const VCSEC_PermissionChange = root.lookupType('VCSEC.PermissionChange');
const VCSEC_WhitelistOperation = root.lookupType('VCSEC.WhitelistOperation');
const VCSEC_PublicKey = root.lookupType('VCSEC.PublicKey');
const VCSEC_KeyMetadata = root.lookupType('VCSEC.KeyMetadata');

export const UniversalDomain = {
  DOMAIN_BROADCAST: 0,
  DOMAIN_VEHICLE_SECURITY: 2,
  DOMAIN_INFOTAINMENT: 3,
} as const;

export type UniversalDomain = typeof UniversalDomain[keyof typeof UniversalDomain];

export enum StateCategory {
  Charge = 'charge',
  Climate = 'climate',
  Drive = 'drive',
  Location = 'location',
  Closures = 'closures',
  ChargeSchedule = 'chargeSchedule',
  PreconditioningSchedule = 'preconditioningSchedule',
  TirePressure = 'tirePressure',
  Media = 'media',
  MediaDetail = 'mediaDetail',
  SoftwareUpdate = 'softwareUpdate',
  ParentalControls = 'parentalControls',
}

export const VcsecSignatureType = {
  SIGNATURE_TYPE_NONE: 0,
  SIGNATURE_TYPE_PRESENT_KEY: 2,
} as const;

export const KeyRole = {
  ROLE_NONE: 0,
  ROLE_SERVICE: 1,
  ROLE_OWNER: 2,
  ROLE_DRIVER: 3,
  ROLE_FM: 4,
  ROLE_VEHICLE_MONITOR: 5,
  ROLE_CHARGING_MANAGER: 6,
  ROLE_GUEST: 8,
} as const;

export const KeyFormFactor = {
  KEY_FORM_FACTOR_UNKNOWN: 0,
  KEY_FORM_FACTOR_NFC_CARD: 1,
  KEY_FORM_FACTOR_IOS_DEVICE: 6,
  KEY_FORM_FACTOR_ANDROID_DEVICE: 7,
  KEY_FORM_FACTOR_CLOUD_KEY: 9,
} as const;

export interface SessionInfoData {
  counter: number;
  epoch: Uint8Array;
  clockTime: number;
  publicKey: Uint8Array;
}

export interface EncodedRoutableMessage {
  buffer: Uint8Array;
  object: any;
}

export function encodeSessionInfoRequest(domain: UniversalDomain, publicKey: Uint8Array, routingAddress: Uint8Array, uuid: Uint8Array): EncodedRoutableMessage {
  const request = SessionInfoRequest.create({
    publicKey,
  });
  const message = RoutableMessage.create({
    toDestination: Destination.create({ domain }),
    fromDestination: Destination.create({ routingAddress }),
    sessionInfoRequest: request,
    uuid,
  });
  const buffer = RoutableMessage.encode(message).finish();
  return { buffer, object: message };
}

export function decodeRoutableMessage(buffer: Uint8Array): any {
  return RoutableMessage.decode(buffer);
}

export function decodeSessionInfo(message: any): SessionInfoData {
  const sessionInfoBytes = message.sessionInfo as Uint8Array | undefined;
  if (!sessionInfoBytes) {
    throw new Error('Missing session info payload');
  }
  const infoMessage = SessionInfoType.decode(sessionInfoBytes);
  const info = SessionInfoType.toObject(infoMessage, { longs: Number, enums: Number, bytes: Array }) as any;
  return {
    counter: info.counter ?? 0,
    epoch: new Uint8Array(info.epoch ?? []),
    clockTime: info.clockTime ?? 0,
    publicKey: new Uint8Array(info.publicKey ?? []),
  };
}

export function extractSessionInfoTag(message: any): Uint8Array {
  const signatureData = message.signatureData as any;
  if (!signatureData?.sessionInfoTag?.tag) {
    throw new Error('Missing session info tag');
  }
  return new Uint8Array(signatureData.sessionInfoTag.tag);
}

export interface EncryptedPayload {
  message: any;
  buffer: Uint8Array;
}

export interface EncryptSignatureData {
  signerPublicKey: Uint8Array;
  epoch: Uint8Array;
  nonce: Uint8Array;
  counter: number;
  expiresAt: number;
  tag: Uint8Array;
}

export function encodeEncryptedCommand(opts: {
  domain: UniversalDomain;
  routingAddress: Uint8Array;
  uuid: Uint8Array;
  ciphertext: Uint8Array;
  signature: EncryptSignatureData;
  flags?: number;
}): EncodedRoutableMessage {
  const { domain, routingAddress, uuid, ciphertext, signature, flags = 0 } = opts;
  const sig = SignatureData.create({
    signerIdentity: {
      publicKey: signature.signerPublicKey,
    },
    AES_GCM_PersonalizedData: AesGcmData.create({
      epoch: signature.epoch,
      nonce: signature.nonce,
      counter: signature.counter,
      expiresAt: signature.expiresAt,
      tag: signature.tag,
    }),
  });

  const message = RoutableMessage.create({
    toDestination: { domain },
    fromDestination: { routingAddress },
    protobufMessageAsBytes: ciphertext,
    signatureData: sig,
    uuid,
    flags,
  });
  const buffer = RoutableMessage.encode(message).finish();
  return { buffer, object: message };
}

export function encodeGetVehicleData(category: StateCategory): Uint8Array {
  const field = stateCategoryToProtoField(category);
  const payload = GetVehicleData.create(field);
  const action = CarServerAction.create({ vehicleAction: { getVehicleData: payload } });
  return CarServerAction.encode(action).finish();
}

export function decodeCarServerResponse(buffer: Uint8Array): any {
  return CarServerResponseType.decode(buffer);
}

export function carServerResponseToObject(message: any): any {
  return CarServerResponseType.toObject(message, { longs: Number, enums: Number, bytes: Array });
}

export function decodeVehicleData(buffer: Uint8Array): any {
  const response = decodeCarServerResponse(buffer);
  return VehicleData.toObject(response.vehicleData ?? {}, { longs: Number, enums: Number, bytes: Array });
}

export function encodeVcsecAddKeyRequest(params: { publicKeyRaw: Uint8Array; role: number; formFactor: number }): Uint8Array {
  const op = VCSEC_WhitelistOperation.create({
    addKeyToWhitelistAndAddPermissions: VCSEC_PermissionChange.create({
      key: VCSEC_PublicKey.create({ PublicKeyRaw: params.publicKeyRaw }),
      keyRole: params.role,
    }),
    metadataForKey: VCSEC_KeyMetadata.create({ keyFormFactor: params.formFactor }),
  });

  const unsigned = VCSEC_UnsignedMessage.create({
    WhitelistOperation: op,
  });
  const unsignedBytes = VCSEC_UnsignedMessage.encode(unsigned).finish();

  const envelope = VCSEC_ToVCSECMessage.create({
    signedMessage: VCSEC_SignedMessage.create({
      protobufMessageAsBytes: unsignedBytes,
      signatureType: VcsecSignatureType.SIGNATURE_TYPE_PRESENT_KEY,
    }),
  });
  return VCSEC_ToVCSECMessage.encode(envelope).finish();
}

function stateCategoryToProtoField(category: StateCategory): Record<string, unknown> {
  switch (category) {
    case StateCategory.Charge:
      return { getChargeState: {} };
    case StateCategory.Climate:
      return { getClimateState: {} };
    case StateCategory.Drive:
      return { getDriveState: {} };
    case StateCategory.Location:
      return { getLocationState: {} };
    case StateCategory.Closures:
      return { getClosuresState: {} };
    case StateCategory.ChargeSchedule:
      return { getChargeScheduleState: {} };
    case StateCategory.PreconditioningSchedule:
      return { getPreconditioningScheduleState: {} };
    case StateCategory.TirePressure:
      return { getTirePressureState: {} };
    case StateCategory.Media:
      return { getMediaState: {} };
    case StateCategory.MediaDetail:
      return { getMediaDetailState: {} };
    case StateCategory.SoftwareUpdate:
      return { getSoftwareUpdateState: {} };
    case StateCategory.ParentalControls:
      return { getParentalControlsState: {} };
    default:
      throw new Error(`Unsupported state category: ${category}`);
  }
}
