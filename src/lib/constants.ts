export const TESLA_SERVICE_UUID = '00000211-b2d1-43f0-9b88-960cebf8b91e';
export const TESLA_TX_CHAR_UUID = '00000212-b2d1-43f0-9b88-960cebf8b91e';
export const TESLA_RX_CHAR_UUID = '00000213-b2d1-43f0-9b88-960cebf8b91e';
export const TESLA_PAIRING_SERVICE_UUID = 0x1122;
export const DEFAULT_MAX_MESSAGE_SIZE = 1024;
export const DEFAULT_RX_TIMEOUT_MS = 1000;
export const HEADER_SIZE = 2; // leading uint16 big-endian length prefix
export const DEFAULT_TTL_SECONDS = 10;

export const DOMAIN_INFOTAINMENT = 3; // UniversalMessage.Domain.DOMAIN_INFOTAINMENT

export const PERSONALIZATION_TAG_VIN = 2; // Signatures.Tag.TAG_PERSONALIZATION

export const WEB_BLUETOOTH_DEFAULT_BLOCK = 185; // conservative chunk size when MTU unknown

export const SIGNATURE_TYPE_AES_GCM = 0;
export const SIGNATURE_TYPE_AES_GCM_PERSONALIZED = 5;
export const SIGNATURE_TYPE_HMAC = 6;
export const SIGNATURE_TYPE_HMAC_PERSONALIZED = 8;
export const SIGNATURE_TYPE_AES_GCM_RESPONSE = 9;

export const TAG_SIGNATURE_TYPE = 0;
export const TAG_DOMAIN = 1;
export const TAG_PERSONALIZATION = 2;
export const TAG_EPOCH = 3;
export const TAG_EXPIRES_AT = 4;
export const TAG_COUNTER = 5;
export const TAG_CHALLENGE = 6;
export const TAG_FLAGS = 7;
export const TAG_REQUEST_HASH = 8;
export const TAG_FAULT = 9;
export const TAG_END = 0xff;

export const DEFAULT_REQUEST_FLAGS = 1 << 1; // FLAG_ENCRYPT_RESPONSE
