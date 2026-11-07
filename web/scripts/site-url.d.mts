export class SiteUrlError extends Error {}
export function isLocalHost(hostname: string): boolean;
export function resolveSiteUrl(env: Record<string, string | undefined>, production: boolean): URL;
