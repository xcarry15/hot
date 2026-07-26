import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  parseWebhookConfigs,
  serializeWebhookConfigsForServer,
  type WebhookConfig,
} from '@/contracts/webhook';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_PREFIX = 'enc:v1:';

/**
 * Webhook URL 的数据库存储格式：
 * enc:v1:<末 6 位长度>:<末 6 位明文>:<iv>:<authTag>:<ciphertext>
 *
 * 末 6 位只用于人工识别，真正的 URL 使用 AES-256-GCM 加密。
 */
function getEncryptionKey(): Buffer {
  const configuredSecret = process.env.SETTINGS_ENCRYPTION_KEY?.trim()
    || process.env.API_TOKEN?.trim();
  if (configuredSecret) return createHash('sha256').update(configuredSecret).digest();

  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 SETTINGS_ENCRYPTION_KEY 或 API_TOKEN');
  }

  // 本地无 API_TOKEN 时仍保持重启后可解密；生产环境不会使用这个回退值。
  return createHash('sha256')
    .update(`hot2-local-settings:${process.env.DATABASE_URL || 'file:./db/custom.db'}`)
    .digest();
}

function isEncryptedWebhookUrl(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

function encryptWebhookUrl(value: string): string {
  const url = value.trim();
  if (!url || isEncryptedWebhookUrl(url)) return url;

  const suffix = url.slice(-6);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENVELOPE_PREFIX.slice(0, -1),
    suffix.length,
    suffix,
    iv.toString('hex'),
    authTag.toString('hex'),
    ciphertext.toString('hex'),
  ].join(':');
}

function decryptWebhookUrl(value: string): string {
  if (!isEncryptedWebhookUrl(value)) return value;

  const rest = value.slice(ENVELOPE_PREFIX.length);
  const lengthEnd = rest.indexOf(':');
  if (lengthEnd <= 0) throw new Error('Webhook 加密数据格式无效');
  const suffixLength = Number(rest.slice(0, lengthEnd));
  if (!Number.isInteger(suffixLength) || suffixLength < 0 || suffixLength > 6) {
    throw new Error('Webhook 加密数据标识无效');
  }

  const suffixStart = lengthEnd + 1;
  const suffix = rest.slice(suffixStart, suffixStart + suffixLength);
  const payload = rest.slice(suffixStart + suffixLength + 1).split(':');
  if (payload.length !== 3) throw new Error('Webhook 加密数据载荷无效');
  const [ivHex, authTagHex, ciphertextHex] = payload;
  if (!/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(authTagHex) || !/^[0-9a-f]+$/i.test(ciphertextHex)) {
    throw new Error('Webhook 加密数据编码无效');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
    if (suffix && !plaintext.endsWith(suffix)) throw new Error('Webhook 标识校验失败');
    return plaintext;
  } catch {
    throw new Error('Webhook 解密失败，请检查 SETTINGS_ENCRYPTION_KEY 是否与保存时一致');
  }
}

/** 将设置页的配置序列化为加密后的数据库值；已加密值保持不变。 */
export function encryptWebhookConfigsForStorage(value: string): string {
  const configs = parseWebhookConfigs(value);
  return serializeWebhookConfigsForServer(configs.map((config) => ({
    ...config,
    url: encryptWebhookUrl(config.url),
  })));
}

/** 将数据库值解密为设置页或推送运行时使用的配置 JSON。 */
export function decryptWebhookConfigsForRuntime(value: string): string {
  const configs = parseWebhookConfigs(value);
  return JSON.stringify(configs.map((config) => ({
    ...config,
    url: decryptWebhookUrl(config.url),
  } satisfies WebhookConfig)));
}

