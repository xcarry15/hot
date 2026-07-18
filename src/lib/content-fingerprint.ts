import crypto from 'crypto';

function cleanTextForFingerprint(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-zA-Z0-9#]+;/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function computeContentFingerprint(title: string, content: string): string {
  const cleanedContent = cleanTextForFingerprint(content);
  // 媒体可能改写标题；完全相同的正文仍应作为同事件的强证据。
  void title;
  return crypto.createHash('sha256').update(cleanedContent, 'utf8').digest('hex');
}
