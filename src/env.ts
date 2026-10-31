/** Resolve the relay destination before replacing the child's URL with loopback. */
export function claudeUpstreamUrl(env: Record<string, string | undefined>, explicit?: string): string {
  const value = explicit ?? (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Claude Code upstream must be an HTTP(S) base URL without credentials, query, or fragment");
  }
  return value;
}

/** Whether an environment flag is set to something other than an explicit "off" value. */
export function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && !["0", "false", "no", "off"].includes(normalized);
}
