import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  parseWebhookConfigs,
  serializeWebhookConfigsForServer,
  type WebhookConfig,
} from '@/contracts/webhook';

const ALGORITHM = 'aes-256-gcm';
/** 历史与当前 envelope 共用该前缀：旧值 enc:v1:<...>，新值在其后追加 keyId 字段。 */
const ENVELOPE_PREFIX = 'enc:v1:';
/** keyId 以非十六进制的 k 开头，从而与旧的十六进制 iv 字段明确区分。 */
const KEY_ID_PREFIX = 'k';
/**
 * 默认 AAD。单参数调用方（settings.ts / proxy-config.ts 不在本专项所有权内）
 * 读写必须使用同一常量，否则会破坏历史数据与现有调用。
 * 显式传入 settingKey 的两参数调用方获得「按字段绑定」的跨字段搬移防护。
 */
const DEFAULT_AAD = '1-hot:settings:default';

type CodecKind = 'text' | 'webhook';

interface EnvelopeParts {
  keyId?: string;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

function getPreviousSecrets(): string[] {
  return (process.env.SETTINGS_ENCRYPTION_KEY_PREVIOUS?.trim() || '')
    .split(',')
    .map((secret) => secret.trim())
    .filter(Boolean);
}

/** 加密根：主密钥来自 SETTINGS_ENCRYPTION_KEY，可配置旧密钥用于解密轮换残留。 */
function getConfiguredSecrets(): string[] {
  const configured = process.env.SETTINGS_ENCRYPTION_KEY?.trim();
  if (configured) return [configured, ...getPreviousSecrets()];

  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须配置 SETTINGS_ENCRYPTION_KEY');
  }

  // 本地开发使用数据库路径派生的稳定值；生产环境绝不依赖可轮换的登录 Token。
  return [
    `hot2-local-settings:${process.env.DATABASE_URL || 'file:./db/custom.db'}`,
    ...getPreviousSecrets(),
  ];
}

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function keyIdFor(key: Buffer): string {
  return `${KEY_ID_PREFIX}${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

function aadBuffer(settingKey?: string): Buffer {
  const context = settingKey?.trim() ? `1-hot:settings:${settingKey}` : DEFAULT_AAD;
  return Buffer.from(context, 'utf8');
}

function isHex(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value);
}

function isValidEnvelopePart(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && isHex(value);
}

/**
 * 解析通用敏感设置 envelope。
 * 旧格式：enc:v1:<iv>:<authTag>:<ciphertext>
 * 新格式：enc:v1:<keyId>:<iv>:<authTag>:<ciphertext>
 * keyId 以 'k' 开头，与十六进制 iv 不冲突；解析失败显式抛错，不再静默当明文。
 */
function parseTextEnvelope(value: string): EnvelopeParts {
  const payload = value.slice(ENVELOPE_PREFIX.length).split(':');
  const hasKeyId = payload[0]?.startsWith(KEY_ID_PREFIX);
  const keyId = hasKeyId ? payload[0] : undefined;
  const restIndex = hasKeyId ? 1 : 0;
  const [ivHex, authTagHex, ciphertextHex] = payload.slice(restIndex);
  if (payload.length !== restIndex + 3
    || !isValidEnvelopePart(ivHex)
    || !isValidEnvelopePart(authTagHex)
    || !isValidEnvelopePart(ciphertextHex)) {
    throw new Error('敏感设置加密数据格式无效');
  }
  return {
    keyId,
    iv: Buffer.from(ivHex, 'hex'),
    authTag: Buffer.from(authTagHex, 'hex'),
    ciphertext: Buffer.from(ciphertextHex, 'hex'),
  };
}

function decryptEnvelopeParts(
  parts: EnvelopeParts,
  secrets: string[],
  settingKey?: string,
): string {
  // 新格式按 keyId 选密钥；找不到对应密钥时明确报错，绝不回退到任意密钥。
  if (parts.keyId) {
    const keys = new Map<string, Buffer>();
    for (const secret of secrets) {
      const key = deriveKey(secret);
      keys.set(keyIdFor(key), key);
    }
    const key = keys.get(parts.keyId);
    if (!key) {
      throw new Error('敏感设置解密失败：密钥 ID 不匹配，请检查 SETTINGS_ENCRYPTION_KEY 或执行 settings:rotate-key');
    }
    return decryptWithKey(parts, key, aadBuffer(settingKey));
  }

  // 旧格式没有 keyId 也没有 AAD：依次尝试主密钥与已配置旧密钥，取首个成功者。
  let lastError: unknown;
  for (const secret of secrets) {
    try {
      return decryptWithKey(parts, deriveKey(secret), null);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('敏感设置解密失败，请检查 SETTINGS_ENCRYPTION_KEY 是否与保存时一致');
}

function decryptWithKey(parts: EnvelopeParts, key: Buffer, aad: Buffer | null): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, parts.iv);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(parts.authTag);
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('敏感设置解密失败，请检查 SETTINGS_ENCRYPTION_KEY 是否与保存时一致');
  }
}

function encryptTextEnvelope(value: string, secret: string, settingKey?: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aadBuffer(settingKey));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [ENVELOPE_PREFIX.slice(0, -1), keyIdFor(key), iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

function decryptTextEnvelope(value: string, secrets: string[], settingKey?: string): string {
  if (!value.startsWith(ENVELOPE_PREFIX)) return value;
  return decryptEnvelopeParts(parseTextEnvelope(value), secrets, settingKey);
}

function encryptSensitiveText(value: string, settingKey?: string): string {
  const text = value.trim();
  if (!text || text.startsWith(ENVELOPE_PREFIX)) return text;
  return encryptTextEnvelope(text, getConfiguredSecrets()[0], settingKey);
}

function decryptSensitiveText(value: string, settingKey?: string): string {
  return decryptTextEnvelope(value, getConfiguredSecrets(), settingKey);
}

function isEncryptedWebhookUrl(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Webhook URL 的数据库存储格式：
 * 旧：enc:v1:<末6位长度>:<末6位明文>:<iv>:<authTag>:<ciphertext>
 * 新：enc:v1:<末6位长度>:<末6位明文>:<keyId>:<iv>:<authTag>:<ciphertext>
 */
function encryptWebhookUrl(value: string, secret: string, settingKey?: string): string {
  const url = value.trim();
  if (!url || isEncryptedWebhookUrl(url)) return url;

  const suffix = url.slice(-6);
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aadBuffer(settingKey));
  const ciphertext = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENVELOPE_PREFIX.slice(0, -1),
    suffix.length,
    suffix,
    keyIdFor(key),
    iv.toString('hex'),
    authTag.toString('hex'),
    ciphertext.toString('hex'),
  ].join(':');
}

function parseWebhookEnvelope(value: string): { parts: EnvelopeParts; suffix: string } {
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
  const hasKeyId = payload[0]?.startsWith(KEY_ID_PREFIX);
  const keyId = hasKeyId ? payload[0] : undefined;
  const restIndex = hasKeyId ? 1 : 0;
  const [ivHex, authTagHex, ciphertextHex] = payload.slice(restIndex);
  if (payload.length !== restIndex + 3
    || !isValidEnvelopePart(ivHex)
    || !isValidEnvelopePart(authTagHex)
    || !isValidEnvelopePart(ciphertextHex)) {
    throw new Error('Webhook 加密数据载荷无效');
  }
  return {
    suffix,
    parts: {
      keyId,
      iv: Buffer.from(ivHex, 'hex'),
      authTag: Buffer.from(authTagHex, 'hex'),
      ciphertext: Buffer.from(ciphertextHex, 'hex'),
    },
  };
}

function decryptWebhookUrl(value: string, secrets: string[], settingKey?: string): string {
  if (!isEncryptedWebhookUrl(value)) return value;

  const { parts, suffix } = parseWebhookEnvelope(value);
  // decryptEnvelopeParts 已按 keyId 决定旧格式无 AAD / 新格式按 settingKey 绑定 AAD。
  const plaintext = decryptEnvelopeParts(parts, secrets, settingKey);
  if (suffix && !plaintext.endsWith(suffix)) throw new Error('Webhook 标识校验失败');
  return plaintext;
}

/** 将设置页的配置序列化为加密后的数据库值；已加密值保持不变。 */
export function encryptWebhookConfigsForStorage(value: string, settingKey?: string): string {
  const configs = parseWebhookConfigs(value);
  return serializeWebhookConfigsForServer(configs.map((config) => ({
    ...config,
    url: encryptWebhookUrl(config.url, getConfiguredSecrets()[0], settingKey),
  })));
}

/** 将数据库值解密为设置页或推送运行时使用的配置 JSON。 */
export function decryptWebhookConfigsForRuntime(value: string, settingKey?: string): string {
  const configs = parseWebhookConfigs(value);
  return JSON.stringify(configs.map((config) => ({
    ...config,
    url: decryptWebhookUrl(config.url, getConfiguredSecrets(), settingKey),
  } satisfies WebhookConfig)));
}

/** 通用敏感设置的加密存储 codec，例如全局代理 URL。 */
export function encryptSensitiveSetting(value: string, settingKey?: string): string {
  return encryptSensitiveText(value, settingKey);
}

export function decryptSensitiveSetting(value: string, settingKey?: string): string {
  return decryptSensitiveText(value, settingKey);
}

// ── 以下为密钥轮换工具专用接口（scripts/rotate-settings-key.ts） ──

/** 值中是否含有需要轮换的 enc:v1 envelope（webhook 的 JSON 内也可能包含）。 */
export function containsEncryptedSettingValue(value: string): boolean {
  return value.includes(ENVELOPE_PREFIX);
}

/** 取出 envelope 中的 keyId（用于日志，不泄漏密钥/明文）；无 keyId 的历史值返回 null。 */
export function readEnvelopeKeyId(value: string): string | null {
  const match = value.match(/enc:v1:k[0-9a-f]{12}:/i);
  return match ? match[0].slice('enc:v1:'.length, -1) : null;
}

/**
 * 用显式提供的旧/新密钥重加密一个设置值，全程不读取默认密钥，也不输出明文。
 * kind='webhook' 时处理 JSON 数组内的每个 url；kind='text' 时处理整个值。
 */
export function reencryptSettingValueForRotation(
  value: string,
  oldSecret: string,
  newSecret: string,
  kind: CodecKind,
): string {
  if (kind === 'webhook') {
    const configs = parseWebhookConfigs(value);
    return serializeWebhookConfigsForServer(configs.map((config) => ({
      ...config,
      url: isEncryptedWebhookUrl(config.url)
        ? encryptWebhookUrl(
            decryptWebhookUrl(config.url, [oldSecret]),
            newSecret,
          )
        : config.url,
    })));
  }
  return value.startsWith(ENVELOPE_PREFIX)
    ? encryptTextEnvelope(decryptTextEnvelope(value, [oldSecret]), newSecret)
    : value;
}

/** 仅用指定密钥解密校验（轮换后自检，不依赖进程默认密钥）。 */
export function canDecryptWithSecret(
  value: string,
  secret: string,
  kind: CodecKind,
): boolean {
  try {
    if (kind === 'webhook') {
      const configs = parseWebhookConfigs(value);
      for (const config of configs) {
        if (isEncryptedWebhookUrl(config.url)) decryptWebhookUrl(config.url, [secret]);
      }
    } else if (value.startsWith(ENVELOPE_PREFIX)) {
      decryptTextEnvelope(value, [secret]);
    }
    return true;
  } catch {
    return false;
  }
}
