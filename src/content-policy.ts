import { Mint } from 'mint-filter';

export const DEFAULT_ALLOWED_LINK_HOSTS = ['aridjaya.eu.org'];

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const MD_LINK_RE = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

type HostCache = { signature: string; hosts: string[] };
let hostCache: HostCache = { signature: '', hosts: DEFAULT_ALLOWED_LINK_HOSTS };

type WordFilterCache = {
	signature: string;
	mint: Mint | null;
};
let wordFilterCache: WordFilterCache = { signature: '', mint: null };

export function normalizeAllowedLinkHosts(raw: unknown): string[] {
	let list: unknown = raw;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return [...DEFAULT_ALLOWED_LINK_HOSTS];
		if (trimmed.startsWith('[')) {
			try {
				list = JSON.parse(trimmed);
			} catch {
				list = trimmed.split(/[\n,]+/);
			}
		} else {
			list = trimmed.split(/[\n,]+/);
		}
	}
	if (!Array.isArray(list)) return [...DEFAULT_ALLOWED_LINK_HOSTS];
	const cleaned = Array.from(
		new Set(
			list
				.map((item) =>
					String(item || '')
						.trim()
						.toLowerCase()
						.replace(/^https?:\/\//, '')
						.replace(/\/.*$/, '')
						.replace(/:\d+$/, '')
						.replace(/^\.+/, '')
						.replace(/\.+$/, '')
				)
				.filter((host) => /^[a-z0-9.-]+$/.test(host) && host.includes('.'))
		)
	);
	return cleaned.length ? cleaned : [...DEFAULT_ALLOWED_LINK_HOSTS];
}

export function serializeAllowedLinkHosts(hosts: string[]): string {
	return JSON.stringify(normalizeAllowedLinkHosts(hosts));
}

export function isAllowedContentHost(hostname: string, suffixes: string[] = DEFAULT_ALLOWED_LINK_HOSTS): boolean {
	const host = hostname.trim().toLowerCase().replace(/\.$/, '');
	if (!host) return false;
	return suffixes.some((suffix) => {
		const s = suffix.trim().toLowerCase().replace(/\.$/, '');
		if (!s) return false;
		return host === s || host.endsWith(`.${s}`);
	});
}

export function isAllowedContentUrl(raw: string, suffixes: string[] = DEFAULT_ALLOWED_LINK_HOSTS): boolean {
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
			return isAllowedContentHost(parsed.hostname, suffixes);
		}
		return true;
	} catch {
		return false;
	}
}

export function findDisallowedContentUrls(text: string, suffixes: string[] = DEFAULT_ALLOWED_LINK_HOSTS): string[] {
	const found = new Set<string>();
	const source = String(text || '');

	for (const match of source.matchAll(MD_LINK_RE)) {
		const href = (match[2] || '').trim();
		if (href && !isAllowedContentUrl(href, suffixes)) found.add(href);
	}

	for (const match of source.matchAll(URL_IN_TEXT_RE)) {
		const href = (match[0] || '').replace(/[.,;:!?)]+$/, '');
		if (href && !isAllowedContentUrl(href, suffixes)) found.add(href);
	}

	return Array.from(found);
}

export function assertAllowedContentUrls(text: string, suffixes: string[] = DEFAULT_ALLOWED_LINK_HOSTS): string | null {
	const bad = findDisallowedContentUrls(text, suffixes);
	if (!bad.length) return null;
	const sample = suffixes.slice(0, 3).join('、') || DEFAULT_ALLOWED_LINK_HOSTS[0];
	return `仅允许白名单域名及其子域名链接（当前：${sample}${suffixes.length > 3 ? '…' : ''}）`;
}

export function invalidateModerationWordCache() {
	wordFilterCache = { signature: '', mint: null };
}

export function invalidateAllowedLinkHostsCache() {
	hostCache = { signature: '', hosts: DEFAULT_ALLOWED_LINK_HOSTS };
}

export async function getAllowedLinkHosts(db: D1Database): Promise<string[]> {
	const row = await db.prepare(`SELECT value FROM settings WHERE key = 'allowed_link_hosts'`).first<{ value: string }>();
	const signature = String(row?.value || '');
	if (signature === hostCache.signature && hostCache.hosts.length) return hostCache.hosts;
	const hosts = normalizeAllowedLinkHosts(signature || DEFAULT_ALLOWED_LINK_HOSTS);
	hostCache = { signature, hosts };
	return hosts;
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

/** 普通用户强制审查；管理员请传 skip: true */
export async function assertContentModeration(
	db: D1Database,
	text: string,
	opts?: { skip?: boolean }
): Promise<string | null> {
	if (opts?.skip) return null;
	const hosts = await getAllowedLinkHosts(db);
	const urlErr = assertAllowedContentUrls(text, hosts);
	if (urlErr) return urlErr;
	const mint = await getModerationMint(db);
	if (!mint) return null;
	const result = mint.filter(String(text || ''), { replace: false });
	const hits = Array.isArray(result.words) ? result.words.filter(Boolean) : [];
	if (!hits.length) return null;
	const unique = Array.from(new Set(hits)).slice(0, 5);
	return `内容包含敏感词：${unique.join('、')}`;
}
