import type { ProjectBackupPayload } from '@/contracts/backup';

export const PROJECT_BACKUP_ENVELOPE_TYPE = 'hot2-encrypted-project-backup' as const;
export const PROJECT_BACKUP_ENVELOPE_VERSION = 1 as const;

const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ENVELOPE_AAD = `${PROJECT_BACKUP_ENVELOPE_TYPE}:v${PROJECT_BACKUP_ENVELOPE_VERSION}`;

export interface EncryptedProjectBackup {
  type: typeof PROJECT_BACKUP_ENVELOPE_TYPE;
  version: typeof PROJECT_BACKUP_ENVELOPE_VERSION;
  kdf: {
    algorithm: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    salt: string;
  };
  encryption: {
    algorithm: 'AES-GCM';
    iv: string;
  };
  ciphertext: string;
}

function getCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持加密备份，请使用现代浏览器');
  return globalThis.crypto;
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < 12 || !passphrase.trim()) {
    throw new Error('备份保护密码至少需要 12 个字符');
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<CryptoKey> {
  const crypto = getCrypto();
  const material = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(new TextEncoder().encode(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function parseEnvelope(value: unknown): EncryptedProjectBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('不是当前项目的加密备份文件');
  const envelope = value as Partial<EncryptedProjectBackup>;
  if (
    envelope.type !== PROJECT_BACKUP_ENVELOPE_TYPE
    || envelope.version !== PROJECT_BACKUP_ENVELOPE_VERSION
    || envelope.kdf?.algorithm !== 'PBKDF2'
    || envelope.kdf.hash !== 'SHA-256'
    || envelope.kdf.iterations !== PBKDF2_ITERATIONS
    || typeof envelope.kdf.salt !== 'string'
    || envelope.encryption?.algorithm !== 'AES-GCM'
    || typeof envelope.encryption.iv !== 'string'
    || typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('不是当前项目的加密备份文件');
  }
  return envelope as EncryptedProjectBackup;
}

export function isEncryptedProjectBackup(value: unknown): value is EncryptedProjectBackup {
  try {
    parseEnvelope(value);
    return true;
  } catch {
    return false;
  }
}

export async function encryptProjectBackup(
  payload: ProjectBackupPayload,
  passphrase: string,
): Promise<EncryptedProjectBackup> {
  assertPassphrase(passphrase);
  const crypto = getCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const plaintext = toArrayBuffer(new TextEncoder().encode(JSON.stringify(payload)));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(new TextEncoder().encode(ENVELOPE_AAD)) },
    key,
    plaintext,
  );
  return {
    type: PROJECT_BACKUP_ENVELOPE_TYPE,
    version: PROJECT_BACKUP_ENVELOPE_VERSION,
    kdf: {
      algorithm: 'PBKDF2',
      hash: 'SHA-256',
      iterations: PBKDF2_ITERATIONS,
      salt: encodeBase64(salt),
    },
    encryption: { algorithm: 'AES-GCM', iv: encodeBase64(iv) },
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptProjectBackup(
  value: unknown,
  passphrase: string,
): Promise<ProjectBackupPayload> {
  assertPassphrase(passphrase);
  const envelope = parseEnvelope(value);
  try {
    const salt = decodeBase64(envelope.kdf.salt);
    const iv = decodeBase64(envelope.encryption.iv);
    if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) throw new Error('invalid encryption parameters');
    const key = await deriveKey(passphrase, salt, envelope.kdf.iterations);
    const plaintext = await getCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(new TextEncoder().encode(ENVELOPE_AAD)) },
      key,
      toArrayBuffer(decodeBase64(envelope.ciphertext)),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as ProjectBackupPayload;
  } catch {
    throw new Error('备份密码错误或文件已损坏');
  }
}
