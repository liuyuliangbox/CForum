/** Session-scoped guest interest tracking for soft→hard conversion gate. */

export type GuestGateThresholds = {
	enabled: boolean;
	softPosts: number;
	softLists: number;
	hardPosts: number;
	hardLists: number;
};

export const DEFAULT_GUEST_GATE: GuestGateThresholds = {
	enabled: true,
	softPosts: 3,
	softLists: 2,
	hardPosts: 5,
	hardLists: 4
};

const KEYS = {
	views: 'cforum_guest_post_views',
	lists: 'cforum_guest_list_fetches',
	softShown: 'cforum_guest_soft_shown',
	hard: 'cforum_guest_hard',
	unlocked: 'cforum_guest_unlocked_posts'
} as const;

export type GatePrompt = 'none' | 'soft' | 'hard';

function readJsonArray(key: string): string[] {
	try {
		const raw = sessionStorage.getItem(key);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
	} catch {
		return [];
	}
}

function writeJsonArray(key: string, value: string[]) {
	try {
		sessionStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* ignore quota */
	}
}

function readInt(key: string): number {
	try {
		const n = parseInt(sessionStorage.getItem(key) || '0', 10);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0;
	}
}

function writeInt(key: string, value: number) {
	try {
		sessionStorage.setItem(key, String(Math.max(0, value)));
	} catch {
		/* ignore */
	}
}

function readFlag(key: string): boolean {
	try {
		return sessionStorage.getItem(key) === '1';
	} catch {
		return false;
	}
}

function writeFlag(key: string, on: boolean) {
	try {
		if (on) sessionStorage.setItem(key, '1');
		else sessionStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

export function parseGuestGateFromConfig(config: any | null | undefined): GuestGateThresholds {
	if (!config) return { ...DEFAULT_GUEST_GATE };
	const num = (v: unknown, fallback: number) => {
		const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
		return Number.isFinite(n) && n >= 1 ? Math.min(n, 50) : fallback;
	};
	return {
		enabled: config.guest_gate_enabled !== false && config.guest_gate_enabled !== 0 && config.guest_gate_enabled !== '0',
		softPosts: num(config.guest_gate_soft_posts, DEFAULT_GUEST_GATE.softPosts),
		softLists: num(config.guest_gate_soft_lists, DEFAULT_GUEST_GATE.softLists),
		hardPosts: num(config.guest_gate_hard_posts, DEFAULT_GUEST_GATE.hardPosts),
		hardLists: num(config.guest_gate_hard_lists, DEFAULT_GUEST_GATE.hardLists)
	};
}

export function getViewedPostIds(): string[] {
	return readJsonArray(KEYS.views);
}

export function getListFetchCount(): number {
	return readInt(KEYS.lists);
}

export function isSoftShown(): boolean {
	return readFlag(KEYS.softShown);
}

export function isHardGated(): boolean {
	return readFlag(KEYS.hard);
}

export function markSoftShown() {
	writeFlag(KEYS.softShown, true);
}

export function markHardGated() {
	writeFlag(KEYS.hard, true);
}

export function unlockPost(postId: string | number) {
	const id = String(postId);
	const list = readJsonArray(KEYS.unlocked);
	if (!list.includes(id)) {
		list.push(id);
		writeJsonArray(KEYS.unlocked, list.slice(-100));
	}
}

export function isPostUnlocked(postId: string | number): boolean {
	return readJsonArray(KEYS.unlocked).includes(String(postId));
}

/** Record a unique post view; returns whether thresholds suggest a prompt. */
export function recordPostView(postId: string | number, thresholds: GuestGateThresholds): GatePrompt {
	if (!thresholds.enabled) return 'none';
	const id = String(postId);
	unlockPost(id);
	const views = readJsonArray(KEYS.views);
	if (!views.includes(id)) {
		views.push(id);
		writeJsonArray(KEYS.views, views.slice(-100));
	}
	return evaluateGate(thresholds);
}

/** Record a successful list fetch. */
export function recordListFetch(thresholds: GuestGateThresholds): GatePrompt {
	if (!thresholds.enabled) return 'none';
	const next = Math.min(readInt(KEYS.lists) + 1, 100);
	writeInt(KEYS.lists, next);
	return evaluateGate(thresholds);
}

export function evaluateGate(thresholds: GuestGateThresholds): GatePrompt {
	if (!thresholds.enabled) return 'none';
	if (readFlag(KEYS.hard)) return 'hard';

	const views = readJsonArray(KEYS.views).length;
	const lists = readInt(KEYS.lists);
	const softShown = readFlag(KEYS.softShown);

	if (softShown && (views >= thresholds.hardPosts || lists >= thresholds.hardLists)) {
		writeFlag(KEYS.hard, true);
		return 'hard';
	}

	if (!softShown && (views >= thresholds.softPosts || lists >= thresholds.softLists)) {
		return 'soft';
	}

	return 'none';
}

/** Safe same-origin path for post-auth redirect. */
export function sanitizeNextPath(raw: string | null | undefined, fallback = '/'): string {
	if (!raw) return fallback;
	const next = String(raw).trim();
	if (!next.startsWith('/') || next.startsWith('//') || next.includes('://')) return fallback;
	if (next.length > 500) return fallback;
	return next;
}

export function currentPageAsNext(): string {
	const path = `${window.location.pathname}${window.location.search}`;
	return sanitizeNextPath(path, '/');
}

export function authUrl(kind: 'login' | 'register', nextPath?: string): string {
	const next = sanitizeNextPath(nextPath || currentPageAsNext());
	const q = new URLSearchParams({ next });
	return `/${kind}?${q.toString()}`;
}
