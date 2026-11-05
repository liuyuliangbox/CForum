/** Fallbacks only; live UI should prefer /api/config site_title / site_tagline. */
export const DEFAULT_SITE_TITLE = 'liuyuliangbox / Project Turn';
export const DEFAULT_SITE_TAGLINE = '由 Cloudflare Workers、Pages、D1、R2 提供服务。';

export function resolveSiteTitle(config?: { site_title?: string | null } | null): string {
	const t = String(config?.site_title || '').trim();
	return t || DEFAULT_SITE_TITLE;
}

export function resolveSiteTagline(config?: { site_tagline?: string | null } | null): string {
	const t = String(config?.site_tagline || '').trim();
	return t || DEFAULT_SITE_TAGLINE;
}

export function formatPageTitle(siteTitle: string, pageLabel?: string | null): string {
	const label = String(pageLabel || '').trim();
	return label ? `${label} - ${siteTitle}` : siteTitle;
}
