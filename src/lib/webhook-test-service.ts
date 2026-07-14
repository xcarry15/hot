import { db } from '@/lib/db';
import { SETTING_KEYS } from '@/lib/settings';

export async function testWebhook(inputUrl?: string) {
  let url = inputUrl;
  if (!url) {
    const setting = await db.setting.findUnique({ where: { key: SETTING_KEYS.FEISHU_WEBHOOK_URL } });
    if (!setting?.value) return { success: false, error: 'Webhook URL not configured', status: 400 };
    url = setting.value;
  }
  if (!url.startsWith('https://open.feishu.cn/open-apis/bot/v2/hook/')) {
    return { success: false, error: 'URL格式不正确，应以 https://open.feishu.cn/open-apis/bot/v2/hook/ 开头', status: 400 };
  }
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: '🧪 测试消息' }, template: 'blue' }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**这是一条测试消息**\\n如果你看到了这条消息，说明飞书 Webhook 配置正确！' } }] } }),
  });
  if (response.ok) return { success: true };
  return { success: false, error: `HTTP ${response.status}: ${await response.text()}` };
}
