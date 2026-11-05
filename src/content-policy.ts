import { Mint } from 'mint-filter';

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

type WordFilterCache = {
	signature: string;
	mint: Mint | null;
};

let wordFilterCache: WordFilterCache = { signature: '', mint: null };

export function invalidateModerationWordCache() {
	wordFilterCache = { signature: '', mint: null };
}

export async function getModerationMint(db: D1Database): Promise<Mint | null> {
	const { results } = await db
		.prepare(`SELECT word FROM moderation_words WHERE enabled = 1 ORDER BY id ASC`)
		.all<{ word: string }>();
	const words = (results || []).map((r) => String(r.word || '').trim()).filter(Boolean);
	const signature = words.join('\n');
	if (signature === wordFilterCache.signature) return wordFilterCache.mint;
	const mint = words.length ? new Mint(words) : null;
	wordFilterCache = { signature, mint };
	return mint;
}

export async function assertContentModeration(db: D1Database, text: string): Promise<string | null> {
	const urlErr = assertAllowedContentUrls(text);
	if (urlErr) return urlErr;
	const mint = await getModerationMint(db);
	if (!mint) return null;
	const result = mint.filter(String(text || ''), { replace: false });
	const hits = Array.isArray(result.words) ? result.words.filter(Boolean) : [];
	if (!hits.length) return null;
	const unique = Array.from(new Set(hits)).slice(0, 5);
	return `内容包含敏感词：${unique.join('、')}`;
}
