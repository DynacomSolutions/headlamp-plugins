/** Returns the url when it is http(s), otherwise null. */
export function safeUrl(url: string, protocols: string[] = ['http:', 'https:']): string | null {
  try {
    const u = new URL(url);
    return protocols.includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
