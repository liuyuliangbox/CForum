export type PublishKind = 'post' | 'comment';

export type RateLimitResult = { ok: true } | { ok: false; status: 429; error: string };

type UserGateRow = {
	created_at: string | null;
	posting_cooldown_until: string | null;
};

function parseDbTimeMs(raw: string | null | undefined): number | null {
	if (!raw) return null;
	const s = String(raw).trim();
	if (!s) return null;
	const ms = Date.parse(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
	return Number.isNaN(ms) ? null : ms;
}

function formatDbTime(ms: number): string {
	return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

async function countSince(db: D1Database, sql: string, userId: number, sinceSql: string): Promise<number> {
	const row = await db.prepare(sql).bind(userId, sinceSql).first<{ c: number }>();
	return Number(row?.c || 0);
}

export async function assertPublishAllowed(
	db: D1Database,
	user: { id: number; role?: string },
	kind: PublishKind
): Promise<RateLimitResult> {
	if (user.role === 'admin') return { ok: true };

	const row = await db
		.prepare(`SELECT created_at, posting_cooldown_until FROM users WHERE id = ?`)
		.bind(user.id)
		.first<UserGateRow>();

	const now = Date.now();
	const cooldownMs = parseDbTimeMs(row?.posting_cooldown_until);
	if (cooldownMs && cooldownMs > now) {
		const mins = Math.max(1, Math.ceil((cooldownMs - now) / 60000));
		return { ok: false, status: 429, error: `发言冷却中，约 ${mins} 分钟后可再试` };
	}

	const createdMs = parseDbTimeMs(row?.created_at);
	const isNew = createdMs != null && now - createdMs < 24 * 60 * 60 * 1000;

	if (kind === 'post') {
		const last10m = await countSince(
			db,
			`SELECT COUNT(*) AS c FROM posts WHERE author_id = ? AND created_at >= datetime('now', ?)`,
			user.id,
			'-10 minutes'
		);
		if (last10m >= 3) {
			return { ok: false, status: 429, error: '发帖过于频繁，请 10 分钟后再试' };
		}
		const last24h = await countSince(
			db,
			`SELECT COUNT(*) AS c FROM posts WHERE author_id = ? AND created_at >= datetime('now', ?)`,
			user.id,
			'-1 day'
		);
		if (last24h >= 20) {
			return { ok: false, status: 429, error: '今日发帖已达上限，请明天再试' };
		}
		if (isNew) {
			const last1h = await countSince(
				db,
				`SELECT COUNT(*) AS c FROM posts WHERE author_id = ? AND created_at >= datetime('now', ?)`,
				user.id,
				'-1 hour'
			);
			if (last1h >= 2) {
				return { ok: false, status: 429, error: '新账号发帖受限：每小时最多 2 篇' };
			}
			if (last24h >= 5) {
				return { ok: false, status: 429, error: '新账号发帖受限：24 小时内最多 5 篇' };
			}
		}
		return { ok: true };
	}

	// comment
	const last1m = await countSince(
		db,
		`SELECT COUNT(*) AS c FROM comments WHERE author_id = ? AND created_at >= datetime('now', ?)`,
		user.id,
		'-1 minute'
	);
	if (last1m >= 5) {
		return { ok: false, status: 429, error: '评论过于频繁，请稍后再试' };
	}
	const last10m = await countSince(
		db,
		`SELECT COUNT(*) AS c FROM comments WHERE author_id = ? AND created_at >= datetime('now', ?)`,
		user.id,
		'-10 minutes'
	);
	if (last10m >= 20) {
		return { ok: false, status: 429, error: '评论过于频繁，请 10 分钟后再试' };
	}
	if (isNew && last10m >= 8) {
		return { ok: false, status: 429, error: '新账号评论受限：10 分钟内最多 8 条' };
	}
	return { ok: true };
}

/** 改帖只检查冷却，不占发帖配额 */
export async function assertNotInCooldown(
	db: D1Database,
	user: { id: number; role?: string }
): Promise<RateLimitResult> {
	if (user.role === 'admin') return { ok: true };
	const row = await db
		.prepare(`SELECT posting_cooldown_until FROM users WHERE id = ?`)
		.bind(user.id)
		.first<{ posting_cooldown_until: string | null }>();
	const cooldownMs = parseDbTimeMs(row?.posting_cooldown_until);
	const now = Date.now();
	if (cooldownMs && cooldownMs > now) {
		const mins = Math.max(1, Math.ceil((cooldownMs - now) / 60000));
		return { ok: false, status: 429, error: `发言冷却中，约 ${mins} 分钟后可再试` };
	}
	return { ok: true };
}

export async function recordModerationReject(
	db: D1Database,
	opts: {
		userId: number;
		reason: string;
		path: 'post' | 'comment' | 'edit';
		ip?: string;
	}
): Promise<{ cooldownUntil: string | null }> {
	const kind = /敏感词/.test(opts.reason) ? 'word' : /白名单|链接|域名/.test(opts.reason) ? 'link' : 'other';
	await db
		.prepare(
			`INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, ip_address)
			 VALUES (?, 'MODERATION_REJECTED', ?, ?, ?, ?)`
		)
		.bind(
			opts.userId,
			opts.path,
			String(opts.userId),
			JSON.stringify({ reason: opts.reason, kind, path: opts.path }),
			opts.ip || 'unknown'
		)
		.run();

	const hourHits = await countSince(
		db,
		`SELECT COUNT(*) AS c FROM audit_logs
		 WHERE user_id = ? AND action = 'MODERATION_REJECTED' AND created_at >= datetime('now', ?)`,
		opts.userId,
		'-1 hour'
	);
	const dayHits = await countSince(
		db,
		`SELECT COUNT(*) AS c FROM audit_logs
		 WHERE user_id = ? AND action = 'MODERATION_REJECTED' AND created_at >= datetime('now', ?)`,
		opts.userId,
		'-1 day'
	);

	const now = Date.now();
	let untilMs: number | null = null;
	if (dayHits >= 8) {
		untilMs = now + 24 * 60 * 60 * 1000;
	} else if (hourHits >= 3) {
		untilMs = now + 15 * 60 * 1000;
	}

	if (!untilMs) return { cooldownUntil: null };

	const existing = await db
		.prepare(`SELECT posting_cooldown_until FROM users WHERE id = ?`)
		.bind(opts.userId)
		.first<{ posting_cooldown_until: string | null }>();
	const existingMs = parseDbTimeMs(existing?.posting_cooldown_until);
	if (existingMs && existingMs > untilMs) {
		return { cooldownUntil: existing?.posting_cooldown_until || null };
	}

	const until = formatDbTime(untilMs);
	await db.prepare(`UPDATE users SET posting_cooldown_until = ? WHERE id = ?`).bind(until, opts.userId).run();
	return { cooldownUntil: until };
}

export async function clearPostingCooldown(db: D1Database, userId: number): Promise<void> {
	await db.prepare(`UPDATE users SET posting_cooldown_until = NULL WHERE id = ?`).bind(userId).run();
}
