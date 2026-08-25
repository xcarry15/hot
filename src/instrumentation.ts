/**
 * Next.js instrumentation hook — runs once at server boot.
 *
 * The Node-only implementation is loaded only from the Node.js runtime branch.
 * This keeps process APIs and the outbound proxy out of the Edge bundle.
 */

export { isKnownUndiciAbortRace } from './lib/undici-abort-race';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeInstrumentation } = await import('./instrumentation-node');
    await registerNodeInstrumentation();
  }
}
