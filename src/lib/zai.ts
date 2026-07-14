import ZAI from 'z-ai-web-dev-sdk';

let zaiPromise: Promise<ZAI> | null = null;

export function getZAI(): Promise<ZAI> {
  if (!zaiPromise) {
    zaiPromise = ZAI.create().catch((err) => {
      zaiPromise = null;
      throw err;
    });
  }
  return zaiPromise;
}
