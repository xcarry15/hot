export function isKnownUndiciAbortRace(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  if (!/^Cannot read properties of null \(reading '(?:port|host)'\)$/.test(error.message)) return false;

  const stack = error.stack?.replaceAll('\\', '/') || '';
  return stack.includes('/undici/lib/interceptor/dns.js')
    || /DNSInstance\.(?:runLookup|pick)/.test(stack);
}
