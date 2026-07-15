export function getPublicSiteUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured);
    } catch {
      // Fall back to a local URL so metadata generation never breaks the page.
    }
  }
  return new URL('http://localhost:3011');
}
