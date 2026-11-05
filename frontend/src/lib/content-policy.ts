const ALLOWED_HOST_SUFFIX = 'aridjaya.eu.org';

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const MD_LINK_RE = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function isAllowedContentHost(hostname: string): boolean {
	const host = hostname.trim().toLowerCase().replace(/\.$/, '');
	if (!host) return false;
	return host === ALLOWED_HOST_SUFFIX || host.endsWith(`.${ALLOWED_HOST_SUFFIX}`);
}

export function isAllowedContentUrl(raw: string): boolean {
	const value = String(raw || '').trim();
	if (!value) return true;
	if (value.startsWith('/') && !value.startsWith('//')) return true;
	if (value.startsWith('#')) return true;
	if (value.startsWith('mailto:') || value.startsWith('tel:') || value.startsWith('javascript:') || value.startsWith('data:')) {
		return false;
	}
	try {
		const parsed = new URL(value, 'https://bbs.aridjaya.eu.org');
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
		// Relative resolved against base still ok if path-only was intended — absolute check:
		if (/^https?:\/\//i.test(value)) {
			return isAllowedContentHost(parsed.hostname);
		}
		return true;
	} catch {
		return false;
	}
}

export function findDisallowedContentUrls(text: string): string[] {
	const found = new Set<string>();
	const source = String(text || '');

	for (const match of source.matchAll(MD_LINK_RE)) {
		const href = (match[2] || '').trim();
		if (href && !isAllowedContentUrl(href)) found.add(href);
	}

	for (const match of source.matchAll(URL_IN_TEXT_RE)) {
		const href = (match[0] || '').replace(/[.,;:!?)]+$/, '');
		if (href && !isAllowedContentUrl(href)) found.add(href);
	}

	return Array.from(found);
}

export function assertAllowedContentUrls(text: string): string | null {
	const bad = findDisallowedContentUrls(text);
	if (!bad.length) return null;
	return '仅允许 aridjaya.eu.org 及其子域名链接';
}
