import { getToken, logout } from '@/lib/auth';

export type ForumConfig = {
	turnstile_enabled: boolean;
	turnstile_site_key: string;
	user_count?: number;
	jwt_secret_configured?: boolean; // indicates whether JWT_SECRET is set in backend
	site_title?: string;
	site_tagline?: string;
};

export type Category = {
	id: number;
	name: string;
	/** 官网副标题（仅 show_on_site 时使用，可选） */
	subtitle?: string;
	admin_only?: number | boolean;
	show_on_site?: number | boolean;
	show_on_forum?: number | boolean;
	created_at: string;
};

export type Post = {
	id: number;
	author_id: number;
	title: string;
	content: string;
	category_id: number | null;
	category_name?: string | null;
	is_pinned?: number;
	/** 1=可见（默认），0=隐藏；作者仅可隐藏且不可再显示；官网同步仅取可见帖 */
	is_visible?: number;
	/** 发帖时未勾选可见时写入；到期前作者可设为可见，到期或已发布后清空 */
	author_publish_until?: string | null;
	/** 1=官网精选（仅 admin）；精选后作者不可隐藏/删除 */
	site_featured?: number;
	view_count?: number;
	created_at: string;
	author_name?: string;
	author_avatar?: string | null;
	author_role?: 'admin' | 'user';
	like_count?: number;
	comment_count?: number;
	liked?: boolean;
};

export type Comment = {
	id: number;
	post_id: number;
	parent_id: number | null;
	author_id: number;
	username: string;
	avatar_url?: string | null;
	role?: 'admin' | 'user';
	content: string;
	/** 1=评论精选（仅一级评论，admin） */
	is_featured?: number;
	created_at: string;
};

const API_BASE = '/api';

export function getSecurityHeaders(method: string, contentType: string | null = 'application/json') {
	const headers: Record<string, string> = {};
	const token = getToken();
	if (token) headers.Authorization = `Bearer ${token}`;
	if (['POST', 'PUT', 'DELETE'].includes(method.toUpperCase())) {
		headers['X-Timestamp'] = Math.floor(Date.now() / 1000).toString();
		headers['X-Nonce'] = crypto.randomUUID();
	}
	if (contentType) headers['Content-Type'] = contentType;
	return headers;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, init);
	if (res.status === 401) {
		logout();
		throw new Error('登录已过期，请重新登录');
	}
	const text = await res.text();
	const data = text ? (JSON.parse(text) as any) : null;
	if (!res.ok) {
		throw new Error(data?.error || `请求失败 (${res.status})`);
	}
	return data as T;
}

export function formatDate(dateString: string | null | undefined) {
	if (!dateString) return '';
	const date = new Date(dateString.endsWith('Z') ? dateString : `${dateString}Z`);
	return date.toLocaleString('zh-CN', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

export function parseApiTimestamp(dateString: string | null | undefined): number | null {
	if (!dateString) return null;
	const ms = Date.parse(dateString.endsWith('Z') ? dateString : `${dateString}Z`);
	return Number.isNaN(ms) ? null : ms;
}

/** Remaining ms for author to first-publish a draft (is_visible=0 with author_publish_until). */
export function getAuthorPublishRemainingMs(
	post: Pick<Post, 'is_visible' | 'author_publish_until'>,
	nowMs = Date.now()
): number {
	if (Number(post.is_visible ?? 1) === 1) return 0;
	const until = parseApiTimestamp(post.author_publish_until);
	if (until == null) return 0;
	return Math.max(0, until - nowMs);
}

export function formatCountdown(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, '0')}`;
}
