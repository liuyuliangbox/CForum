
import { sendEmail } from './smtp';
import { generateIdenticonSvg } from './identicon';
import { uploadImage, deleteImage, listAllKeys, getPublicUrl, getKeyFromUrl, uploadAvatarBytes, uploadAvatarDataUri, S3Env } from './s3';
import * as OTPAuth from 'otpauth';
import { Security, UserPayload } from './security';
import {
	assertContentModeration,
	DEFAULT_ALLOWED_LINK_HOSTS,
	invalidateAllowedLinkHostsCache,
	invalidateModerationWordCache,
	serializeAllowedLinkHosts
} from './content-policy';
import {
	assertNotInCooldown,
	assertPublishAllowed,
	clearPostingCooldown,
	isAdminCooldownHours,
	recordModerationReject,
	setPostingCooldownHours
} from './rate-limit';
import {
	DEFAULT_OPS_PLAYBOOK,
	LEGACY_OPS_PLAYBOOK,
	defaultStatusForOptions,
	isValidStatusForOptions,
	parseStatusOptions,
	serializeStatusOptions
} from './category-status';
import { adminPanelHref, getAdminPanelPath } from '../shared/admin-panel-path';

/** Validate cited_post_id for create/update. Returns error message or null. */
async function validateCitedPostId(
	db: D1Database,
	opts: {
		citedPostId: number | null;
		sourcePostId?: number | null;
		sourceCategoryId: number;
	}
): Promise<string | null> {
	const citedId = opts.citedPostId;
	if (citedId == null) return null;
	if (!Number.isFinite(citedId) || citedId <= 0) return '引用帖无效';
	if (opts.sourcePostId != null && citedId === opts.sourcePostId) return '不能引用自己';
	const sourceCat = await db
		.prepare(`SELECT IFNULL(enable_cite, 0) AS enable_cite FROM categories WHERE id = ?`)
		.bind(opts.sourceCategoryId)
		.first<{ enable_cite: number }>();
	if (!sourceCat || Number(sourceCat.enable_cite) !== 1) return '该分类未启用引用他人';
	const target = await db
		.prepare(
			`SELECT posts.id, IFNULL(posts.is_visible, 1) AS is_visible,
				IFNULL(categories.enable_cited_from, 0) AS enable_cited_from
			 FROM posts
			 LEFT JOIN categories ON posts.category_id = categories.id
			 WHERE posts.id = ?`
		)
		.bind(citedId)
		.first<{ id: number; is_visible: number; enable_cited_from: number }>();
	if (!target) return '引用的帖子不存在';
	if (Number(target.is_visible) !== 1) return '引用的帖子不可见';
	if (Number(target.enable_cited_from) !== 1) return '目标帖分类未启用被引用';
	return null;
}

const RELATION_CARD_SQL = `SELECT
		posts.id, posts.title, posts.status, posts.category_id, posts.created_at,
		categories.name AS category_name,
		users.username AS author_name,
		users.avatar_url AS author_avatar
	 FROM posts
	 JOIN users ON posts.author_id = users.id
	 LEFT JOIN categories ON posts.category_id = categories.id`;

interface DBUser {
    id: number;
    email: string;
    username: string;
    password: string;
    verified: number;
    role?: string;
    avatar_url?: string;
    totp_secret?: string;
    totp_enabled?: number;
    email_notifications?: number;
    reset_token?: string;
    reset_token_expires?: number;
    pending_email?: string;
    verification_token?: string;
    email_change_token?: string;
}

interface PostAuthorInfo {
    title: string;
    author_id: number;
    email: string;
    email_notifications: number;
    username: string;
}

interface DBUserEmail { email: string; }
interface DBUserTotp { totp_secret: string; }
interface DBCount { count: number; }
interface DBSetting { value: string; }

// Utility to extract image URLs from Markdown content
function extractImageUrls(content: string): string[] {
	if (!content) return [];
	const urls: string[] = [];
	const regex = /!\[.*?\]\((.*?)\)/g;
	let match;
	while ((match = regex.exec(content)) !== null) {
		urls.push(match[1]);
	}
	return urls;
}

function extractCoverUrl(content: string): string | null {
	const md = String(content || '').match(/!\[[^\]]*\]\(([^)\s]+)\)/i);
	const html = String(content || '').match(/<img[^>]+src=["']([^"']+)["']/i);
	const raw = md?.[1] || html?.[1] || '';
	if (!raw) return null;
	if (/^https?:\/\//i.test(raw) || raw.startsWith('/') || raw.startsWith('data:')) return raw;
	return `/r2/${raw.replace(/^\/+/, '')}`;
}

/** Run heavy schema/seed work once per Worker isolate — was the main cause of multi-second API latency. */
let schemaEnsurePromise: Promise<void> | null = null;

/** Bumped when admin changes categories/settings; returned by /api/posts for client cache invalidation. */
let metaCacheVersion = 1;
function bumpMetaCacheVersion() {
	metaCacheVersion += 1;
	return metaCacheVersion;
}

// Utility to hash password
async function hashPassword(password: string): Promise<string> {
	const myText = new TextEncoder().encode(password);
	const myDigest = await crypto.subtle.digest(
		{
			name: 'SHA-256',
		},
		myText
	);
	const hashArray = Array.from(new Uint8Array(myDigest));
	const hashHex = hashArray
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return hashHex;
}

function generateToken(): string {
	return crypto.randomUUID();
}

function hasControlCharacters(str: string): boolean {
	return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(str);
}

function isVisuallyEmpty(str: string): boolean {
	if (!str) return true;
	const stripped = str.replace(/[\s\u200B-\u200F\uFEFF\u2028\u2029\u180E\u3164\u115F\u1160\x00-\x1F\x7F]+/g, '');
	return stripped.length === 0;
}

function hasInvisibleCharacters(str: string): boolean {
	return /[\u200B-\u200F\uFEFF\u2028\u2029\u180E\u3164\u115F\u1160]/.test(str);
}

function hasRestrictedKeywords(username: string): boolean {
	const restricted = ['管理', 'admin', 'sudo', 'test'];
	return restricted.some(keyword => username.toLowerCase().includes(keyword.toLowerCase()));
}

async function verifyTurnstile(token: string, ip: string, secretKey: string): Promise<boolean> {
	const formData = new FormData();
	formData.append('secret', secretKey);
	formData.append('response', token);
	formData.append('remoteip', ip);

	const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
	const result = await fetch(url, {
		body: formData,
		method: 'POST',
	});

	const outcome = await result.json() as any;
	return outcome.success;
}

/** Isolate-local: skip D1 schema_version reads after first success in this Worker instance. */
const SCHEMA_VERSION = 23;

const DEFAULT_AVATAR_PRESET_COUNT = 12;
const DEFAULT_AVATAR_PRESETS = Array.from(
	{ length: DEFAULT_AVATAR_PRESET_COUNT },
	(_, i) => `/api/preset-avatars/${i + 1}`
);

function parseAvatarPresets(raw: unknown): string[] {
	let list: unknown = raw;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return [...DEFAULT_AVATAR_PRESETS];
		if (trimmed.startsWith('[')) {
			try {
				list = JSON.parse(trimmed);
			} catch {
				list = trimmed.split(/\r?\n/);
			}
		} else {
			list = trimmed.split(/\r?\n/);
		}
	}
	if (!Array.isArray(list)) return [...DEFAULT_AVATAR_PRESETS];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		const s = String(item || '').trim();
		if (!s || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out.length ? out.slice(0, 48) : [...DEFAULT_AVATAR_PRESETS];
}
let schemaReadyInIsolate = false;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method;

		// Helper function to get base URL
		const getBaseUrl = () => {
			// Priority: 1. Env var 2. X-Original-URL header (from Pages Functions) 3. Request origin
			if (env.BASE_URL) {
				console.log(`✅ Using BASE_URL from env: ${env.BASE_URL}`);
				return env.BASE_URL;
			}
			
			const xOriginalUrl = request.headers.get('X-Original-URL');
			if (xOriginalUrl) {
				console.log(`✅ Using X-Original-URL from Pages Functions: ${xOriginalUrl}`);
				return xOriginalUrl;
			}
			
			console.warn(`⚠️ BASE_URL not configured and no X-Original-URL header, falling back to request origin: ${url.origin}`);
			return url.origin;
		};

		const r2PublicBase = () => ((env as any).BUCKET ? `${getBaseUrl()}/r2` : undefined);

		const createDefaultAvatarUrl = async (userId: string | number, _seed?: string) => {
			const n = Math.abs(Number(userId) || 0) % DEFAULT_AVATAR_PRESET_COUNT;
			return `/api/preset-avatars/${n + 1}`;
		};

		const getConfiguredAvatarPresets = async () => {
			const row = await env.cforum_db
				.prepare(`SELECT value FROM settings WHERE key = 'avatar_presets'`)
				.first<{ value: string }>();
			return parseAvatarPresets(row?.value);
		};

		const normalizeAvatarUrl = async (
			userId: string | number,
			avatarUrl: string,
			opts?: { allowUpload?: boolean; presetsOnly?: boolean }
		) => {
			const value = String(avatarUrl || '').trim();
			if (!value) return createDefaultAvatarUrl(userId);
			if (opts?.presetsOnly) {
				const presets = await getConfiguredAvatarPresets();
				if (!presets.includes(value)) throw new Error('请从预设头像中选择');
				return value;
			}
			if (value.startsWith('/api/preset-avatars/')) return value;
			if (value.startsWith('data:image/')) {
				if (!opts?.allowUpload) throw new Error('不支持自定义上传头像，请选择预设头像');
				return uploadAvatarDataUri(env as unknown as S3Env, userId, value, r2PublicBase());
			}
			if (value.startsWith('/r2/')) return value;
			if (/^https?:\/\//i.test(value)) {
				if (value.length > 500) throw new Error('Avatar URL too long (Max 500 chars)');
				return value;
			}
			throw new Error('Invalid Avatar URL');
		};

		// CORS headers helper
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS, DELETE, PUT',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Timestamp, X-Nonce',
		};

		// Handle OPTIONS (CORS preflight)
		if (method === 'OPTIONS') {
			return new Response(null, {
				headers: corsHeaders,
			});
		}

		// Helper to return JSON response with CORS
		const jsonResponse = (data: any, status = 200, extraHeaders?: Record<string, string>) => {
			return Response.json(data, {
				status,
				headers: { ...corsHeaders, ...(extraHeaders || {}) },
			});
		};

		// Serve R2 objects through Worker when using bucket binding
		if (url.pathname.startsWith('/r2/') && (method === 'GET' || method === 'HEAD')) {
			const bucket = (env as any).BUCKET as R2Bucket | undefined;
			if (!bucket) return new Response('R2 bucket not configured', { status: 404 });
			const key = decodeURIComponent(url.pathname.slice('/r2/'.length));
			if (!key) return new Response('Not Found', { status: 404 });
			const object = await bucket.get(key);
			if (!object) return new Response('Not Found', { status: 404 });
			const headers = new Headers();
			object.writeHttpMetadata(headers);
			if (object.httpEtag) headers.set('etag', object.httpEtag);
			headers.set('Cache-Control', 'public, max-age=3600');
			return new Response(method === 'HEAD' ? null : object.body, { headers });
		}

		// Ensure the database schema exists before anything else.
		// Hot path: isolate memory → else one settings read → else full CREATE/ALTER/seed.
		const ensureSchema = async () => {
			if (schemaReadyInIsolate) return;
			try {
				const ver = await env.cforum_db
					.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`)
					.first<{ value: string }>();
				if (ver && Number(ver.value) === SCHEMA_VERSION) {
					schemaReadyInIsolate = true;
					return;
				}
			} catch {
				// settings/posts may not exist yet — fall through to init
			}

			let schemaReady = false;
			try {
				await env.cforum_db.prepare('SELECT 1 FROM posts LIMIT 1').first();
				schemaReady = true;
			} catch (err: any) {
				console.warn('Database schema missing, initializing', err);
			}

			if (!schemaReady) {
				// using prepare().run() instead of exec ensures each statement is committed
				const stmts = [
					`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  verified INTEGER DEFAULT 0,
  verification_token TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER DEFAULT 0,
  reset_token TEXT,
  reset_token_expires INTEGER,
  pending_email TEXT,
  email_change_token TEXT,
  avatar_url TEXT,
  nickname TEXT,
  email_notifications INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`,
					`CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  subtitle TEXT NOT NULL DEFAULT '',
  admin_only INTEGER NOT NULL DEFAULT 0,
  show_on_site INTEGER NOT NULL DEFAULT 0,
  show_on_forum INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`,
					`CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category_id INTEGER,
  is_pinned INTEGER DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1,
  author_publish_until TIMESTAMP,
  site_featured INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (author_id) REFERENCES users(id),
  FOREIGN KEY (category_id) REFERENCES categories(id)
);`,
					`CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  parent_id INTEGER,
  author_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  is_featured INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id),
  FOREIGN KEY (parent_id) REFERENCES comments(id),
  FOREIGN KEY (author_id) REFERENCES users(id)
);`,
					`CREATE TABLE IF NOT EXISTS likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_id, user_id),
  FOREIGN KEY (post_id) REFERENCES posts(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);`,
					`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);`,
					`CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);`,
					`CREATE TABLE IF NOT EXISTS sessions (
  jti TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);`,
					`CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  details TEXT,
  ip_address TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`,
					`CREATE TABLE IF NOT EXISTS moderation_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`,
					`INSERT OR IGNORE INTO settings (key, value) VALUES ('turnstile_enabled', '0');`,
					`INSERT OR IGNORE INTO settings (key, value) VALUES ('site_title', 'liuyuliangbox / Project Turn');`,
					`INSERT OR IGNORE INTO settings (key, value) VALUES ('site_tagline', '由 Cloudflare Workers、Pages、D1、R2 提供服务。');`,
					`INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_on_post_status_change', '1');`,
					`INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_on_site_feature', '1');`,
					`INSERT OR IGNORE INTO settings (key, value) VALUES ('guest_gate_enabled', '1');`,
					`INSERT OR IGNORE INTO settings (key, value) VALUES ('guest_gate_soft_posts', '3');`,
					`INSERT OR IGNORE INTO settings (key, value) VALUES ('guest_gate_soft_lists', '2');`,
					`INSERT OR IGNORE INTO settings (key, value) VALUES ('guest_gate_hard_posts', '5');`,
					`INSERT OR IGNORE INTO settings (key, value) VALUES ('guest_gate_hard_lists', '4');`,
					`INSERT OR IGNORE INTO users (email, username, password, role, verified, nickname) VALUES 
('admin@adysec.com', 'Admin', 'e86f78a8a3caf0b60d8e74e5942aa6d86dc150cd3c03338aef25b7d2d7e3acc7', 'admin', 1, 'System Admin');`
				];
				for (const stmt of stmts) {
					try {
						await env.cforum_db.prepare(stmt).run();
					} catch (e) {
						console.error('Error running schema statement', e, stmt);
					}
				}
				try {
					await env.cforum_db.prepare('SELECT 1 FROM posts LIMIT 1').first();
				} catch (e) {
					console.error('Failed to verify posts table after init', e);
				}
			}

			// Compat migrations + seeds — must run even when base tables already exist
			try {
				await env.cforum_db.prepare(
					'ALTER TABLE categories ADD COLUMN admin_only INTEGER NOT NULL DEFAULT 0'
				).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db.prepare(
					'ALTER TABLE categories ADD COLUMN show_on_site INTEGER NOT NULL DEFAULT 0'
				).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db.prepare(
					'ALTER TABLE categories ADD COLUMN show_on_forum INTEGER NOT NULL DEFAULT 1'
				).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db.prepare(
					'ALTER TABLE posts ADD COLUMN is_visible INTEGER NOT NULL DEFAULT 1'
				).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db.prepare(
					'ALTER TABLE posts ADD COLUMN site_featured INTEGER NOT NULL DEFAULT 0'
				).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db.prepare(
					'ALTER TABLE posts ADD COLUMN author_publish_until TIMESTAMP'
				).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db.prepare(
					'ALTER TABLE comments ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0'
				).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db.prepare(
					`ALTER TABLE categories ADD COLUMN subtitle TEXT NOT NULL DEFAULT ''`
				).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db.prepare(
					'ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0'
				).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db.prepare(
					`CREATE TABLE IF NOT EXISTS moderation_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`
				).run();
			} catch (e) {
				console.error('Failed to ensure moderation_words table', e);
			}
			try {
				await env.cforum_db.prepare(`ALTER TABLE users ADD COLUMN posting_cooldown_until TIMESTAMP`).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db
					.prepare(`ALTER TABLE categories ADD COLUMN status_options TEXT NOT NULL DEFAULT '[]'`)
					.run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db
					.prepare(`ALTER TABLE categories ADD COLUMN author_can_set_status INTEGER NOT NULL DEFAULT 0`)
					.run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db
					.prepare(`ALTER TABLE categories ADD COLUMN enable_relate_others INTEGER NOT NULL DEFAULT 0`)
					.run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db
					.prepare(`ALTER TABLE categories ADD COLUMN enable_linked_from INTEGER NOT NULL DEFAULT 0`)
					.run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db
					.prepare(`ALTER TABLE categories ADD COLUMN enable_cite INTEGER NOT NULL DEFAULT 0`)
					.run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db
					.prepare(`ALTER TABLE categories ADD COLUMN enable_cited_from INTEGER NOT NULL DEFAULT 0`)
					.run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db
					.prepare(`ALTER TABLE categories ADD COLUMN enable_relate INTEGER NOT NULL DEFAULT 0`)
					.run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db
					.prepare(
						`UPDATE categories SET enable_relate = 1
						 WHERE IFNULL(enable_relate_others, 0) = 1 AND IFNULL(enable_relate, 0) = 0`
					)
					.run();
				await env.cforum_db
					.prepare(
						`UPDATE categories SET enable_cited_from = 1
						 WHERE IFNULL(enable_linked_from, 0) = 1 AND IFNULL(enable_cited_from, 0) = 0`
					)
					.run();
			} catch (e) {
				console.error('Failed to migrate category cite/relate flags', e);
			}
			try {
				await env.cforum_db.prepare(`ALTER TABLE posts ADD COLUMN status TEXT`).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db.prepare(`ALTER TABLE posts ADD COLUMN cited_post_id INTEGER`).run();
			} catch {
				// column already exists
			}
			try {
				await env.cforum_db
					.prepare(
						`CREATE TABLE IF NOT EXISTS post_relations (
  from_post_id INTEGER NOT NULL,
  to_post_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (from_post_id, to_post_id),
  CHECK (from_post_id != to_post_id)
)`
					)
					.run();
				await env.cforum_db
					.prepare(`CREATE INDEX IF NOT EXISTS idx_post_relations_to ON post_relations(to_post_id)`)
					.run();
			} catch (e) {
				console.error('Failed to ensure post_relations table', e);
			}
			try {
				await env.cforum_db
					.prepare(
						`CREATE TABLE IF NOT EXISTS post_relations_undirected (
  post_low_id INTEGER NOT NULL,
  post_high_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_low_id, post_high_id),
  CHECK (post_low_id < post_high_id)
)`
					)
					.run();
				await env.cforum_db
					.prepare(
						`INSERT OR IGNORE INTO post_relations_undirected (post_low_id, post_high_id, created_by, created_at)
						 SELECT CASE WHEN from_post_id < to_post_id THEN from_post_id ELSE to_post_id END,
						        CASE WHEN from_post_id < to_post_id THEN to_post_id ELSE from_post_id END,
						        created_by, created_at
						 FROM post_relations`
					)
					.run();
			} catch (e) {
				console.error('Failed to migrate undirected post_relations', e);
			}
			try {
				await env.cforum_db
					.prepare(
						`CREATE TABLE IF NOT EXISTS post_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`
					)
					.run();
				await env.cforum_db
					.prepare(
						`CREATE TABLE IF NOT EXISTS post_template_categories (
  template_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  PRIMARY KEY (template_id, category_id),
  FOREIGN KEY (template_id) REFERENCES post_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
)`
					)
					.run();
			} catch (e) {
				console.error('Failed to ensure post_templates tables', e);
			}
			try {
				await env.cforum_db
					.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('ops_playbook', ?)`)
					.bind(DEFAULT_OPS_PLAYBOOK)
					.run();
				await env.cforum_db
					.prepare(`UPDATE settings SET value = ? WHERE key = 'ops_playbook' AND value = ?`)
					.bind(DEFAULT_OPS_PLAYBOOK, LEGACY_OPS_PLAYBOOK)
					.run();
			} catch (e) {
				console.error('Failed to seed ops_playbook', e);
			}
			try {
				await env.cforum_db
					.prepare(
						`INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_on_post_status_change', '1')`
					)
					.run();
				await env.cforum_db
					.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('notify_on_site_feature', '1')`)
					.run();
				await env.cforum_db
					.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('guest_gate_enabled', '1')`)
					.run();
				await env.cforum_db
					.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('guest_gate_soft_posts', '3')`)
					.run();
				await env.cforum_db
					.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('guest_gate_soft_lists', '2')`)
					.run();
				await env.cforum_db
					.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('guest_gate_hard_posts', '5')`)
					.run();
				await env.cforum_db
					.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('guest_gate_hard_lists', '4')`)
					.run();
			} catch (e) {
				console.error('Failed to seed notify / guest_gate settings', e);
			}
			try {
				await env.cforum_db
					.prepare(
						`UPDATE categories SET status_options = ?
						 WHERE name = 'Bug/体验'
						   AND (status_options IS NULL OR status_options = '' OR status_options = '[]')`
					)
					.bind(JSON.stringify(['待处理', '确认中', '已排期', '已修复', '不予采纳']))
					.run();
				await env.cforum_db
					.prepare(
						`UPDATE categories SET status_options = ?
						 WHERE name = '玩法建议'
						   AND (status_options IS NULL OR status_options = '' OR status_options = '[]')`
					)
					.bind(JSON.stringify(['收集中', '已排期', '已采纳', '暂不采纳']))
					.run();
			} catch (e) {
				console.error('Failed to seed category status_options', e);
			}
			try {
				const needsSortBackfill = await env.cforum_db
					.prepare(
						`SELECT COUNT(*) AS c FROM categories
						 WHERE IFNULL(sort_order, 0) = 0
						 HAVING COUNT(*) > 1 AND COUNT(*) = SUM(CASE WHEN IFNULL(sort_order, 0) = 0 THEN 1 ELSE 0 END)`
					)
					.first<{ c: number }>();
				if (needsSortBackfill && Number(needsSortBackfill.c) > 0) {
					const { results: cats } = await env.cforum_db
						.prepare('SELECT id FROM categories ORDER BY id ASC')
						.all<{ id: number }>();
					let i = 0;
					for (const cat of cats || []) {
						i += 1;
						await env.cforum_db
							.prepare('UPDATE categories SET sort_order = ? WHERE id = ?')
							.bind(i, cat.id)
							.run();
					}
				}
			} catch (e) {
				console.error('Failed to backfill category sort_order', e);
			}
			try {
				await env.cforum_db
					.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('site_title', 'liuyuliangbox / Project Turn')`)
					.run();
				await env.cforum_db
					.prepare(
						`INSERT OR IGNORE INTO settings (key, value) VALUES ('site_tagline', '由 Cloudflare Workers、Pages、D1、R2 提供服务。')`
					)
					.run();
				const siteBrandDefaults: Array<[string, string]> = [
					['site_brand', 'liuyuliangbox'],
					['project_codename', 'Project Turn'],
					['working_title_note', '正式名称待定 / Working Title'],
					['product_tagline', '单人修道，一回合定势。江湖未定，先把战斗打通。'],
					[
						'site_description',
						'单人优先的回合制 RPG。开发日志、社区反馈与内测资讯。正式名称待定。'
					],
					['community_home_url', 'https://bbs.aridjaya.eu.org'],
					['footer_rights', '保留所有权利。'],
					[
						'friend_links',
						JSON.stringify([{ label: '社区 bbs.aridjaya.eu.org', url: 'https://bbs.aridjaya.eu.org' }])
					],
					['allowed_link_hosts', JSON.stringify(['aridjaya.eu.org'])],
					['avatar_presets', JSON.stringify(DEFAULT_AVATAR_PRESETS)]
				];
				for (const [key, value] of siteBrandDefaults) {
					await env.cforum_db
						.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
						.bind(key, value)
						.run();
				}
			} catch (e) {
				console.error('Failed to seed brand settings', e);
			}
			try {
				const existingGame = await env.cforum_db
					.prepare(`SELECT id FROM categories WHERE name = '开发进度' LIMIT 1`)
					.first();
				if (!existingGame) {
					const seedCats: Array<{ name: string; admin_only: number; show_on_site: number; show_on_forum: number }> = [
						{ name: '开发进度', admin_only: 1, show_on_site: 1, show_on_forum: 1 },
						{ name: '玩法建议', admin_only: 0, show_on_site: 0, show_on_forum: 1 },
						{ name: 'Bug/体验', admin_only: 0, show_on_site: 0, show_on_forum: 1 },
						{ name: '美术氛围', admin_only: 0, show_on_site: 0, show_on_forum: 1 },
						{ name: '闲聊/招募', admin_only: 0, show_on_site: 0, show_on_forum: 1 }
					];
					for (const cat of seedCats) {
						await env.cforum_db
							.prepare(
								'INSERT OR IGNORE INTO categories (name, admin_only, show_on_site, show_on_forum) VALUES (?, ?, ?, ?)'
							)
							.bind(cat.name, cat.admin_only, cat.show_on_site, cat.show_on_forum)
							.run();
					}
				} else {
					await env.cforum_db
						.prepare(`UPDATE categories SET admin_only = 1 WHERE name = '开发进度' AND IFNULL(admin_only, 0) = 0`)
						.run();
					await env.cforum_db
						.prepare(`UPDATE categories SET show_on_site = 1 WHERE name = '开发进度'`)
						.run();
				}
				await env.cforum_db
					.prepare(
						`UPDATE categories SET subtitle = '进度同步自社区公开栏目，构建时生成静态页。'
						 WHERE name = '开发进度' AND IFNULL(subtitle, '') = ''`
					)
					.run();
				await env.cforum_db
					.prepare(
						`UPDATE categories SET subtitle = '进度同步自社区公开栏目，构建时生成静态页。'
						 WHERE name = '开发进度' AND subtitle LIKE '%论坛%'`
					)
					.run();
			} catch (e) {
				console.error('Failed to seed game categories', e);
			}
			// One-shot: migrate former Gaming-Community Markdown 开发日志 into「开发进度」
			try {
				const progressCat = await env.cforum_db
					.prepare(`SELECT id FROM categories WHERE name = '开发进度' LIMIT 1`)
					.first<{ id: number }>();
				const admin = await env.cforum_db
					.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`)
					.first<{ id: number }>();
				if (progressCat && admin) {
					const legacyLogs: Array<{ title: string; content: string; created_at: string }> = [
						{
							title: '官网与社区脚手架上线',
							created_at: '2026-11-03 12:00:00',
							content:
								'> 用独立社区仓库搭好 Astro 静态站，开发期以日志为主，讨论走 GitHub Discussions。\n\n本周把社区官网的第一版骨架推上了线。\n\n## 做了什么\n\n- 使用 Astro 搭建中文社区站，部署目标为 Cloudflare Pages\n- 对外品牌暂用工作室名 **liuyuliangbox**，项目代号 **Project Turn**（正式游戏名待定）\n- 页面包括：首页、开发日志、关于、社区规则、下载占位\n- 社区计划使用 GitHub Discussions，文章评论后续接入 Giscus\n\n## 为什么先做官网\n\n游戏还在开发中，完整的新手指南和下载页很容易过时。先把**开发日志**和**反馈入口**立住，方便同步进度、收集想法。\n\n## 想听你的反馈\n\n如果你希望日志里优先看到哪一类内容（战斗原型、世界观、UI、网络架构），可以在 Discussions 里投票或直接留言。'
						},
						{
							title: '单人优先：回合战斗的设计起点',
							created_at: '2026-10-20 12:00:00',
							content:
								'> 先把单人回合战斗的信息可读性与节奏跑通，再考虑联网扩展。\n\nProject Turn 的定位是**单人优先**的回合制 RPG。联网能力会服务体验，但不会在早期绑架核心战斗循环。\n\n## 本阶段目标\n\n1. 玩家能在一屏内看懂敌我状态与关键选项\n2. 回合节奏可预期：思考时间留给玩家，演出不拖沓\n3. 构筑有差异，但避免前期数值爆炸\n\n## 下一周计划\n\n- 打磨一局「教学遭遇」的节奏\n- 整理技能描述规范，减少模糊用语\n- 继续把可公开的进度写进开发日志\n\n如果你玩过喜欢的单人回合制作品，欢迎在社区分享「哪一点让你愿意反复开一局」。'
						}
					];
					for (const log of legacyLogs) {
						const exists = await env.cforum_db
							.prepare(`SELECT id FROM posts WHERE title = ? AND category_id = ? LIMIT 1`)
							.bind(log.title, progressCat.id)
							.first();
						if (exists) continue;
						const inserted = await env.cforum_db
							.prepare(
								`INSERT INTO posts (author_id, title, content, category_id, created_at) VALUES (?, ?, ?, ?, ?)`
							)
							.bind(admin.id, log.title, log.content, progressCat.id, log.created_at)
							.run();
						console.log('Seeded legacy log post', log.title, inserted.meta?.last_row_id);
					}
				}
			} catch (e) {
				console.error('Failed to seed legacy site logs', e);
			}

			// One-shot: seed 关于 / 社区规则 / 下载 as site-only single-post categories
			try {
				const admin = await env.cforum_db
					.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`)
					.first<{ id: number }>();
				if (admin) {
					const maxOrder =
						(
							await env.cforum_db
								.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories')
								.first<{ m: number }>()
						)?.m ?? 0;
					let nextOrder = maxOrder;
					const cmsPages: Array<{
						name: string;
						subtitle: string;
						title: string;
						content: string;
					}> = [
						{
							name: '关于',
							subtitle: '工作室与项目介绍',
							title: '关于 liuyuliangbox',
							content:
								'我们正在开发一款**单人优先**的回合制 RPG。当前对外代号为 **Project Turn**，正式名称待定 / Working Title。\n\n## 我们在做什么\n\n希望玩家可以按自己的节奏慢慢推进：清晰的回合策略、可读的战斗信息、以及值得反复尝试的构筑空间。多人与联网能力会服务于单人体感，而不是反过来。\n\n## 当前阶段\n\n项目仍在开发中。官网先用于发布开发日志、收集反馈与建立社区习惯。内测与下载通道开放时，会在「下载」栏目与日志中同步说明。\n\n## 技术方向\n\n客户端基于 Unity；在线与账号相关能力规划使用 Nakama。具体功能会随开发日志逐步公开，不会在未就绪时提前承诺上线日期。'
						},
						{
							name: '社区规则',
							subtitle: '发言约定与讨论入口',
							title: '社区规则',
							content:
								'正式社区托管在 Cloudflare（CForum）。请先阅读规则，再参与讨论、反馈与建议。\n\n## 发言约定\n\n- 尊重他人：禁止人身攻击、歧视与骚扰。\n- 对事不对人：反馈尽量附带复现步骤、截图或期望行为。\n- 不剧透未公开内容：开发者未发布的剧情与数值请勿外传。\n- 不发布盗版、外挂、破解或恶意链接。\n- 标题写清楚：例如「建议 / Bug / 提问」，方便分类与检索。\n\n## 推荐分类\n\n- 开发进度：官方日志摘要与征集反馈\n- 玩法建议：设计讨论\n- Bug / 体验反馈\n- 美术与氛围讨论\n- 闲聊 / 招募测试\n\n进入社区：https://bbs.aridjaya.eu.org'
						},
						{
							name: '下载',
							subtitle: '内测与试玩入口',
							title: '内测尚未开放',
							content:
								'liuyuliangbox / Project Turn 仍在开发中。公开试玩包与内测资格会通过开发日志与社区通知发布。\n\n## 想第一时间知道开放消息？\n\n- 关注官网「开发进度」栏目\n- 加入社区 https://bbs.aridjaya.eu.org 的「闲聊 / 招募测试」分类'
						}
					];
					for (const page of cmsPages) {
						let cat = await env.cforum_db
							.prepare('SELECT id FROM categories WHERE name = ? LIMIT 1')
							.bind(page.name)
							.first<{ id: number }>();
						if (!cat) {
							nextOrder += 1;
							const inserted = await env.cforum_db
								.prepare(
									`INSERT INTO categories (name, subtitle, admin_only, show_on_site, show_on_forum, sort_order)
									 VALUES (?, ?, 1, 1, 0, ?)`
								)
								.bind(page.name, page.subtitle, nextOrder)
								.run();
							cat = { id: Number(inserted.meta?.last_row_id) };
						} else {
							await env.cforum_db
								.prepare(
									`UPDATE categories
									 SET show_on_site = 1, admin_only = 1, show_on_forum = 0,
									     subtitle = CASE WHEN IFNULL(subtitle,'') = '' THEN ? ELSE subtitle END
									 WHERE id = ?`
								)
								.bind(page.subtitle, cat.id)
								.run();
						}
						const exists = await env.cforum_db
							.prepare('SELECT id FROM posts WHERE category_id = ? LIMIT 1')
							.bind(cat.id)
							.first();
						if (!exists) {
							await env.cforum_db
								.prepare(
									`INSERT INTO posts (author_id, title, content, category_id, is_visible)
									 VALUES (?, ?, ?, ?, 1)`
								)
								.bind(admin.id, page.title, page.content, cat.id)
								.run();
						} else {
							await env.cforum_db
								.prepare(
									`UPDATE posts SET content = REPLACE(content, '论坛', '社区')
									 WHERE category_id = ? AND content LIKE '%论坛%'`
								)
								.bind(cat.id)
								.run();
						}
					}
				}
			} catch (e) {
				console.error('Failed to seed CMS site pages', e);
			}

			// One-shot: user-facing copy 论坛 → 社区（历史开发进度帖等）
			try {
				await env.cforum_db
					.prepare(
						`UPDATE posts SET content = REPLACE(content, '论坛', '社区')
						 WHERE content LIKE '%论坛%'`
					)
					.run();
			} catch (e) {
				console.error('Failed to rewrite 论坛→社区 in posts', e);
			}

			try {
				await env.cforum_db
					.prepare(
						`INSERT INTO settings (key, value) VALUES ('schema_version', ?)
						 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
					)
					.bind(String(SCHEMA_VERSION))
					.run();
				schemaReadyInIsolate = true;
			} catch (e) {
				console.error('Failed to persist schema_version', e);
			}
		};

		// perform initialization before security setup
		await ensureSchema();

		let security: Security;
		try {
			security = new Security(env);
		} catch (e) {
			console.error('Security initialization failed:', e);
			return Response.json(
				{ error: 'Server misconfigured' },
				{ status: 500, headers: corsHeaders }
			);
		}

		// authentication helper - throws on failure
		const authenticate = async (req: Request) => {
			const authHeader = req.headers.get('Authorization');
			if (!authHeader || !authHeader.startsWith('Bearer ')) {
				throw new Error('Unauthorized');
			}
			const token = authHeader.split(' ')[1];
			const payload = await security.verifyToken(token);
			if (!payload) {
				throw new Error('Unauthorized');
			}
			return payload;
		};

		const tryAuthenticate = async (req: Request): Promise<UserPayload | null> => {
			try {
				return await authenticate(req);
			} catch {
				return null;
			}
		};

		// Helper to handle errors
		const handleError = (e: any) => {
			const errString = String(e);
			if (errString.includes('Unauthorized') || errString.includes('Invalid Token')) {
				return jsonResponse({ error: 'Unauthorized' }, 401);
			}
			return jsonResponse({ error: errString }, 500);
		};


        const publicPaths = [
            '/api/config', '/api/login', '/api/register', '/api/verify', 
            '/api/auth/forgot-password', '/api/auth/reset-password', '/api/verify-email-change',
             // Static/Public GETs
            '/api/posts', '/api/categories', '/api/users', '/api/preset-avatars',
			'/api/export/site-categories', '/api/export/site-posts', '/api/export/site-meta'
        ];
        
        // Relax check for public GETs that don't need nonce
        const isPublicGet = method === 'GET' && (
            publicPaths.includes(url.pathname) || 
            url.pathname.match(/^\/api\/posts\/\d+$/) || 
            url.pathname.match(/^\/api\/posts\/\d+\/comments$/) ||
			url.pathname.match(/^\/api\/export\/site-posts\/\d+$/) ||
			url.pathname.match(/^\/api\/preset-avatars\/\d+$/)
        );

        // However, user specifically asked for "Replay protection for sensitive operations".
        // We will apply strict checks for mutation methods (POST, PUT, DELETE)
        if (['POST', 'PUT', 'DELETE'].includes(method)) {
             const validation = await security.validateRequest(request);
             if (!validation.valid) {
                 return jsonResponse({ error: validation.error || 'Security check failed' }, 400);
             }
        }

		const BOOL_SETTING_KEYS = new Set([
			'turnstile_enabled',
			'notify_on_user_delete',
			'notify_on_username_change',
			'notify_on_avatar_change',
			'notify_on_manual_verify',
			'notify_on_post_status_change',
			'notify_on_site_feature',
			'guest_gate_enabled'
		]);
		const INT_SETTING_KEYS = new Set([
			'guest_gate_soft_posts',
			'guest_gate_soft_lists',
			'guest_gate_hard_posts',
			'guest_gate_hard_lists'
		]);
		const STRING_SETTING_KEYS = new Set([
			'site_title',
			'site_tagline',
			'site_brand',
			'project_codename',
			'working_title_note',
			'product_tagline',
			'site_description',
			'community_home_url',
			'footer_rights',
			'friend_links',
			'allowed_link_hosts',
			'ops_playbook',
			'avatar_presets'
		]);
		const clampGuestGateInt = (raw: unknown, fallback: number) => {
			const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
			if (!Number.isFinite(n)) return fallback;
			return Math.min(50, Math.max(1, Math.floor(n)));
		};
		const DEFAULT_FRIEND_LINKS_JSON = JSON.stringify([
			{ label: '社区 bbs.aridjaya.eu.org', url: 'https://bbs.aridjaya.eu.org' }
		]);
		const DEFAULT_ALLOWED_LINK_HOSTS_JSON = serializeAllowedLinkHosts(DEFAULT_ALLOWED_LINK_HOSTS);
		const DEFAULT_AVATAR_PRESETS_JSON = JSON.stringify(DEFAULT_AVATAR_PRESETS);
		const SITE_META_DEFAULTS: Record<string, string> = {
			site_brand: 'liuyuliangbox',
			project_codename: 'Project Turn',
			working_title_note: '正式名称待定 / Working Title',
			product_tagline: '单人修道，一回合定势。江湖未定，先把战斗打通。',
			site_description: '单人优先的回合制 RPG。开发日志、社区反馈与内测资讯。正式名称待定。',
			community_home_url: 'https://bbs.aridjaya.eu.org',
			footer_rights: '保留所有权利。',
			friend_links: DEFAULT_FRIEND_LINKS_JSON,
			allowed_link_hosts: DEFAULT_ALLOWED_LINK_HOSTS_JSON,
			ops_playbook: DEFAULT_OPS_PLAYBOOK,
			avatar_presets: DEFAULT_AVATAR_PRESETS_JSON
		};

		const normalizeFriendLinksJson = (raw: unknown): string => {
			let list: unknown = raw;
			if (typeof raw === 'string') {
				try {
					list = JSON.parse(raw);
				} catch {
					return DEFAULT_FRIEND_LINKS_JSON;
				}
			}
			if (!Array.isArray(list)) return DEFAULT_FRIEND_LINKS_JSON;
			const cleaned = list
				.map((item) => {
					if (!item || typeof item !== 'object') return null;
					const label = String((item as any).label || '').trim().slice(0, 80);
					const url = String((item as any).url || '').trim().slice(0, 300);
					if (!label || !url) return null;
					return { label, url };
				})
				.filter(Boolean)
				.slice(0, 20);
			return cleaned.length > 0 ? JSON.stringify(cleaned) : DEFAULT_FRIEND_LINKS_JSON;
		};

		// GET /api/config
		if (url.pathname === '/api/config' && method === 'GET') {
			try {
				const [setting, userCount, titleRow, taglineRow, gateRows] = await Promise.all([
					env.cforum_db.prepare("SELECT value FROM settings WHERE key = 'turnstile_enabled'").first<DBSetting>(),
					env.cforum_db.prepare('SELECT COUNT(*) as count FROM users').first('count'),
					env.cforum_db.prepare("SELECT value FROM settings WHERE key = 'site_title'").first<DBSetting>(),
					env.cforum_db.prepare("SELECT value FROM settings WHERE key = 'site_tagline'").first<DBSetting>(),
					env.cforum_db
						.prepare(
							`SELECT key, value FROM settings WHERE key IN (
								'guest_gate_enabled',
								'guest_gate_soft_posts',
								'guest_gate_soft_lists',
								'guest_gate_hard_posts',
								'guest_gate_hard_lists'
							)`
						)
						.all<DBSetting & { key: string }>()
				]);
				
				// 只有数据库设置为启用，且两个环境变量都配置时，才启用 Turnstile
				const dbEnabled = setting ? setting.value === '1' : false;
				const siteKey = (env as any).TURNSTILE_SITE_KEY || '';
				const secretKey = (env as any).TURNSTILE_SECRET_KEY || '';
				const turnstileFullyConfigured = !!(dbEnabled && siteKey && secretKey);

				const gateMap = new Map<string, string>();
				for (const row of gateRows.results || []) {
					gateMap.set(String((row as any).key), String((row as any).value));
				}
				const gateEnabled = !gateMap.has('guest_gate_enabled') || gateMap.get('guest_gate_enabled') === '1';
				
				return jsonResponse({
					turnstile_enabled: turnstileFullyConfigured,
					turnstile_site_key: siteKey,
					user_count: userCount || 0,
					jwt_secret_configured: !!env.JWT_SECRET && String(env.JWT_SECRET).length >= 32,
					site_title: titleRow?.value || 'liuyuliangbox / Project Turn',
					site_tagline: taglineRow?.value || '由 Cloudflare Workers、Pages、D1、R2 提供服务。',
					guest_gate_enabled: gateEnabled,
					guest_gate_soft_posts: clampGuestGateInt(gateMap.get('guest_gate_soft_posts'), 3),
					guest_gate_soft_lists: clampGuestGateInt(gateMap.get('guest_gate_soft_lists'), 2),
					guest_gate_hard_posts: clampGuestGateInt(gateMap.get('guest_gate_hard_posts'), 5),
					guest_gate_hard_lists: clampGuestGateInt(gateMap.get('guest_gate_hard_lists'), 4)
				});
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/admin/settings
		if (url.pathname === '/api/admin/settings' && method === 'GET') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const settings = await env.cforum_db.prepare("SELECT key, value FROM settings").all();
				const config: any = {
					turnstile_enabled: false,
					notify_on_user_delete: false,
					notify_on_username_change: false,
					notify_on_avatar_change: false,
					notify_on_manual_verify: false,
					notify_on_post_status_change: true,
					notify_on_site_feature: true,
					guest_gate_enabled: true,
					guest_gate_soft_posts: 3,
					guest_gate_soft_lists: 2,
					guest_gate_hard_posts: 5,
					guest_gate_hard_lists: 4,
					site_title: 'liuyuliangbox / Project Turn',
					site_tagline: '由 Cloudflare Workers、Pages、D1、R2 提供服务。',
					...SITE_META_DEFAULTS
				};
				
				if (settings.results) {
					for (const row of settings.results) {
						const key = row.key as string;
						const value = row.value as string;
						if (BOOL_SETTING_KEYS.has(key)) {
							config[key] = value === '1';
						} else if (INT_SETTING_KEYS.has(key)) {
							config[key] = clampGuestGateInt(value, config[key] ?? 1);
						} else if (STRING_SETTING_KEYS.has(key)) {
							config[key] = value;
						}
					}
				}
				
				return jsonResponse(config);
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/admin/moderation-words
		if (url.pathname === '/api/admin/moderation-words' && method === 'GET') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const { results } = await env.cforum_db
					.prepare(
						`SELECT id, word, enabled, created_at FROM moderation_words ORDER BY id DESC`
					)
					.all();
				return jsonResponse(results || []);
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/moderation-words
		if (url.pathname === '/api/admin/moderation-words' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const body = (await request.json()) as any;
				const word = String(body?.word || '').trim();
				if (!word) return jsonResponse({ error: '请输入敏感词' }, 400);
				if (word.length > 64) return jsonResponse({ error: '敏感词过长（最多 64 字符）' }, 400);
				try {
					await env.cforum_db
						.prepare(`INSERT INTO moderation_words (word, enabled) VALUES (?, 1)`)
						.bind(word)
						.run();
				} catch {
					return jsonResponse({ error: '该敏感词已存在' }, 400);
				}
				invalidateModerationWordCache();
				await security.logAudit(userPayload.id, 'ADD_MODERATION_WORD', 'moderation_word', word, {}, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// DELETE /api/admin/moderation-words/:id
		if (url.pathname.match(/^\/api\/admin\/moderation-words\/\d+$/) && method === 'DELETE') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const id = url.pathname.split('/')[4];
				await env.cforum_db.prepare(`DELETE FROM moderation_words WHERE id = ?`).bind(id).run();
				invalidateModerationWordCache();
				await security.logAudit(userPayload.id, 'DELETE_MODERATION_WORD', 'moderation_word', id, {}, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/settings
		if (url.pathname === '/api/admin/settings' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const body = await request.json() as any;
				const {
					turnstile_enabled,
					notify_on_user_delete,
					notify_on_username_change,
					notify_on_avatar_change,
					notify_on_manual_verify,
					notify_on_post_status_change,
					notify_on_site_feature,
					guest_gate_enabled,
					guest_gate_soft_posts,
					guest_gate_soft_lists,
					guest_gate_hard_posts,
					guest_gate_hard_lists,
					site_title,
					site_tagline,
					site_brand,
					project_codename,
					working_title_note,
					product_tagline,
					site_description,
					community_home_url,
					footer_rights,
					friend_links,
					allowed_link_hosts,
					ops_playbook,
					avatar_presets
				} = body;
				
				const stmt = env.cforum_db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
				const batch = [];

				if (turnstile_enabled !== undefined) batch.push(stmt.bind('turnstile_enabled', turnstile_enabled ? '1' : '0'));
				if (notify_on_user_delete !== undefined) batch.push(stmt.bind('notify_on_user_delete', notify_on_user_delete ? '1' : '0'));
				if (notify_on_username_change !== undefined) batch.push(stmt.bind('notify_on_username_change', notify_on_username_change ? '1' : '0'));
				if (notify_on_avatar_change !== undefined) batch.push(stmt.bind('notify_on_avatar_change', notify_on_avatar_change ? '1' : '0'));
				if (notify_on_manual_verify !== undefined) batch.push(stmt.bind('notify_on_manual_verify', notify_on_manual_verify ? '1' : '0'));
				if (notify_on_post_status_change !== undefined) {
					batch.push(stmt.bind('notify_on_post_status_change', notify_on_post_status_change ? '1' : '0'));
				}
				if (notify_on_site_feature !== undefined) {
					batch.push(stmt.bind('notify_on_site_feature', notify_on_site_feature ? '1' : '0'));
				}
				if (guest_gate_enabled !== undefined) {
					batch.push(stmt.bind('guest_gate_enabled', guest_gate_enabled ? '1' : '0'));
				}
				if (guest_gate_soft_posts !== undefined) {
					batch.push(stmt.bind('guest_gate_soft_posts', String(clampGuestGateInt(guest_gate_soft_posts, 3))));
				}
				if (guest_gate_soft_lists !== undefined) {
					batch.push(stmt.bind('guest_gate_soft_lists', String(clampGuestGateInt(guest_gate_soft_lists, 2))));
				}
				if (guest_gate_hard_posts !== undefined) {
					batch.push(stmt.bind('guest_gate_hard_posts', String(clampGuestGateInt(guest_gate_hard_posts, 5))));
				}
				if (guest_gate_hard_lists !== undefined) {
					batch.push(stmt.bind('guest_gate_hard_lists', String(clampGuestGateInt(guest_gate_hard_lists, 4))));
				}
				if (site_title !== undefined) batch.push(stmt.bind('site_title', String(site_title).slice(0, 80)));
				if (site_tagline !== undefined) batch.push(stmt.bind('site_tagline', String(site_tagline).slice(0, 160)));
				if (site_brand !== undefined) batch.push(stmt.bind('site_brand', String(site_brand).slice(0, 80)));
				if (project_codename !== undefined) batch.push(stmt.bind('project_codename', String(project_codename).slice(0, 80)));
				if (working_title_note !== undefined) batch.push(stmt.bind('working_title_note', String(working_title_note).slice(0, 120)));
				if (product_tagline !== undefined) batch.push(stmt.bind('product_tagline', String(product_tagline).slice(0, 160)));
				if (site_description !== undefined) batch.push(stmt.bind('site_description', String(site_description).slice(0, 300)));
				if (community_home_url !== undefined) {
					const url = String(community_home_url || '').trim().replace(/\/+$/, '').slice(0, 300);
					batch.push(stmt.bind('community_home_url', url || SITE_META_DEFAULTS.community_home_url));
				}
				if (footer_rights !== undefined) batch.push(stmt.bind('footer_rights', String(footer_rights).slice(0, 80)));
				if (friend_links !== undefined) batch.push(stmt.bind('friend_links', normalizeFriendLinksJson(friend_links)));
				if (allowed_link_hosts !== undefined) {
					batch.push(stmt.bind('allowed_link_hosts', serializeAllowedLinkHosts(allowed_link_hosts)));
				}
				if (ops_playbook !== undefined) {
					batch.push(stmt.bind('ops_playbook', String(ops_playbook || '').slice(0, 20000)));
				}
				if (avatar_presets !== undefined) {
					batch.push(
						stmt.bind('avatar_presets', JSON.stringify(parseAvatarPresets(avatar_presets)))
					);
				}
				
				if (batch.length > 0) await env.cforum_db.batch(batch);
				if (allowed_link_hosts !== undefined) invalidateAllowedLinkHostsCache();
				bumpMetaCacheVersion();

				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/preset-avatars — list configured preset URLs
		if (url.pathname === '/api/preset-avatars' && method === 'GET') {
			try {
				const presets = await getConfiguredAvatarPresets();
				return jsonResponse({ presets });
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/preset-avatars/:id — generated placeholder SVG
		if (url.pathname.match(/^\/api\/preset-avatars\/\d+$/) && method === 'GET') {
			try {
				const id = Number(url.pathname.split('/')[3]);
				if (!Number.isFinite(id) || id < 1 || id > 48) {
					return new Response('Not found', { status: 404, headers: corsHeaders });
				}
				const svg = await generateIdenticonSvg(`preset-avatar-${id}`);
				return new Response(svg, {
					status: 200,
					headers: {
						...corsHeaders,
						'Content-Type': 'image/svg+xml; charset=utf-8',
						'Cache-Control': 'public, max-age=86400'
					}
				});
			} catch (e) {
				return handleError(e);
			}
		}
		
		// Helper to check Turnstile if enabled
		const checkTurnstile = async (reqBody: any, ip: string) => {
			const setting = await env.cforum_db.prepare("SELECT value FROM settings WHERE key = 'turnstile_enabled'").first<DBSetting>();
			// 只有数据库启用且两个环境变量都配置时才要求验证（与前端逻辑一致）
			const dbEnabled = setting && setting.value === '1';
			const siteKey = (env as any).TURNSTILE_SITE_KEY;
			const secretKey = (env as any).TURNSTILE_SECRET_KEY;
			const fullyConfigured = dbEnabled && siteKey && secretKey;
			
			if (fullyConfigured) {
				const token = reqBody['cf-turnstile-response'];
				if (!token) return false;
				return await verifyTurnstile(token, ip, secretKey);
			}
			return true;
		};

		// POST /api/upload (Image Upload) — post images only; avatar upload disabled
		if (url.pathname === '/api/upload' && method === 'POST') {
			try {
				const user = await authenticate(request);
				
				const formData = await request.formData();
				const file = formData.get('file');
				const userId = user.id.toString();
				const postId = formData.get('post_id') || 'general';
				const type = String(formData.get('type') || 'post');

				if (type === 'avatar') {
					if (user.role !== 'admin') {
						return jsonResponse({ error: '不支持上传头像，请选择预设头像' }, 400);
					}
				}

				if (!file || !(file instanceof File)) {
					return jsonResponse({ error: 'No file uploaded' }, 400);
				}

				if (!file.type.startsWith('image/')) {
					return jsonResponse({ error: 'Only images are allowed' }, 400);
				}

				const MAX_SIZE = 2 * 1024 * 1024;
				if (file.size > MAX_SIZE) {
					return jsonResponse({ error: 'File size too large (Max 2MB)' }, 400);
				}

				const uploadType = type === 'avatar' && user.role === 'admin' ? 'avatar' : 'post';
				if (uploadType === 'post' && user.role !== 'admin') {
					const row = await env.cforum_db
						.prepare('SELECT created_at FROM users WHERE id = ?')
						.bind(user.id)
						.first<{ created_at: string }>();
					const raw = String(row?.created_at || '').trim();
					const createdMs = raw
						? Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z')
						: NaN;
					const ageMs = Number.isFinite(createdMs) ? Date.now() - createdMs : 0;
					const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
					if (ageMs < SEVEN_DAYS) {
						return jsonResponse({ error: '注册满 7 天后才能上传图片' }, 403);
					}
				}

				const imageKey = await uploadImage(
					env as unknown as S3Env,
					file,
					userId,
					postId.toString(),
					uploadType as 'post' | 'avatar'
				);
				const publicBase = (env as any).BUCKET ? `${getBaseUrl()}/r2` : undefined;
				const imageUrl = getPublicUrl(env as unknown as S3Env, imageKey, publicBase);
				return jsonResponse({ success: true, url: imageUrl });
			} catch (e) {
				console.error('Upload error:', e);
				return handleError(e);
			}
		}

		// --- AUTH ROUTES ---

		// POST /api/login
		if (url.pathname === '/api/login' && method === 'POST') {
			try {
				const body = await request.json() as any;
				
				// Turnstile Check
				const ip = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
				if (!(await checkTurnstile(body, ip))) {
					return jsonResponse({ error: 'Turnstile verification failed' }, 403);
				}

				const { email, password, totp_code } = body;
				if (!email || !password) {
					return jsonResponse({ error: 'Missing email or password' }, 400);
				}

				const user = await env.cforum_db
					.prepare('SELECT * FROM users WHERE email = ?')
					.bind(email)
					.first<DBUser>();
				if (!user) {
					return jsonResponse({ error: 'Username or Password Error' }, 401);
				}

				if (!user.verified) {
					return jsonResponse({ error: 'Please verify your email first' }, 403);
				}

				const passwordHash = await hashPassword(password);
				if (user.password !== passwordHash) {
					return jsonResponse({ error: 'Username or Password Error' }, 401);
				}

				// TOTP Check
				if (user.totp_enabled) {
					if (!totp_code) {
						return jsonResponse({ error: 'TOTP_REQUIRED' }, 403);
					}
					if (!user.totp_secret) {
						return jsonResponse({ error: 'TOTP not configured' }, 500);
					}

					const totp = new OTPAuth.TOTP({
						algorithm: 'SHA1',
						digits: 6,
						period: 30,
						secret: OTPAuth.Secret.fromBase32(String(user.totp_secret)),
					});

					const delta = totp.validate({ token: totp_code, window: 1 });
					if (delta === null) {
						return jsonResponse({ error: 'Invalid TOTP code' }, 401);
					}
				}

				const { token, jti, expiresAt } = await security.generateToken({
					id: user.id,
					role: user.role || 'user',
					email: user.email
				});

				await env.cforum_db.prepare('INSERT INTO sessions (jti, user_id, expires_at) VALUES (?, ?, ?)').bind(jti, user.id, expiresAt).run();
				await security.logAudit(user.id, 'LOGIN', 'user', String(user.id), { email }, request);

				const role = user.role || 'user';
				return jsonResponse({
					token,
					user: {
						id: user.id,
						email: user.email,
						username: user.username,
						avatar_url: user.avatar_url,
						role,
						totp_enabled: !!user.totp_enabled,
						email_notifications: user.email_notifications === 1,
						...(role === 'admin'
							? { admin_panel_path: adminPanelHref((env as any).ADMIN_PANEL_PATH) }
							: {})
					}
				});
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/admin/entry — obscure panel path for authenticated admins only
		if (url.pathname === '/api/admin/entry' && method === 'GET') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const path = adminPanelHref((env as any).ADMIN_PANEL_PATH);
				return jsonResponse({ path }, 200, {
					'Cache-Control': 'no-store',
					'X-Robots-Tag': 'noindex, nofollow'
				});
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/user/profile
		if (url.pathname === '/api/user/profile' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				const body = await request.json() as any;
				const { username, avatar_url, email_notifications } = body;
				
				const user_id = userPayload.id;
				const currentUser = await env.cforum_db.prepare('SELECT * FROM users WHERE id = ?').bind(user_id).first<DBUser>();
				if (!currentUser) return jsonResponse({ error: 'User not found' }, 404);

				if (username) {
					if (username.length > 20) return jsonResponse({ error: 'Username too long (Max 20 chars)' }, 400);
					if (isVisuallyEmpty(username)) return jsonResponse({ error: 'Username cannot be empty' }, 400);
					if (hasInvisibleCharacters(username)) return jsonResponse({ error: 'Username contains invalid invisible characters' }, 400);
					if (hasControlCharacters(username)) return jsonResponse({ error: 'Username contains invalid control characters' }, 400);
					if (hasRestrictedKeywords(username)) return jsonResponse({ error: 'Username contains restricted keywords' }, 400);

					if (username !== currentUser.username) {
						const modErr = await assertContentModeration(env.cforum_db, username, {
							skip: userPayload.role === 'admin'
						});
						if (modErr) return jsonResponse({ error: modErr }, 400);
					}
					
					const existingUser = await env.cforum_db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').bind(username, user_id).first<{id:number}>();
					if (existingUser) {
						return jsonResponse({ error: 'Username already taken' }, 409);
					}
				}

				let newUsername = currentUser.username;
				if (username !== undefined) {
					newUsername = username;
				}

				const isAdmin = userPayload.role === 'admin';
				let newAvatarUrl = currentUser.avatar_url;
				if (avatar_url !== undefined) {
					try {
						if (avatar_url === '' || avatar_url === null) {
							newAvatarUrl = await createDefaultAvatarUrl(user_id);
						} else if (isAdmin && typeof avatar_url === 'string' && avatar_url.startsWith('data:image/')) {
							newAvatarUrl = await normalizeAvatarUrl(user_id, avatar_url, { allowUpload: true });
						} else if (currentUser.avatar_url && avatar_url === currentUser.avatar_url) {
							if (String(currentUser.avatar_url).startsWith('data:image/')) {
								newAvatarUrl = isAdmin
									? await normalizeAvatarUrl(user_id, String(currentUser.avatar_url), { allowUpload: true })
									: await createDefaultAvatarUrl(user_id);
							} else {
								newAvatarUrl = currentUser.avatar_url;
							}
						} else {
							newAvatarUrl = await normalizeAvatarUrl(user_id, String(avatar_url), {
								presetsOnly: !isAdmin,
								allowUpload: isAdmin
							});
						}
					} catch (avatarErr: any) {
						return jsonResponse({ error: String(avatarErr?.message || avatarErr) }, 400);
					}
				} else if (currentUser.avatar_url && String(currentUser.avatar_url).startsWith('data:image/')) {
					try {
						newAvatarUrl = isAdmin
							? await normalizeAvatarUrl(user_id, String(currentUser.avatar_url), { allowUpload: true })
							: await createDefaultAvatarUrl(user_id);
					} catch (avatarErr: any) {
						return jsonResponse({ error: String(avatarErr?.message || avatarErr) }, 400);
					}
				}

				let newEmailNotif = currentUser.email_notifications;
				if (email_notifications !== undefined) {
					newEmailNotif = email_notifications ? 1 : 0;
				}

				await env.cforum_db.prepare('UPDATE users SET username = ?, avatar_url = ?, email_notifications = ? WHERE id = ?')
					.bind(newUsername, newAvatarUrl, newEmailNotif, user_id).run();

			const user = await env.cforum_db.prepare('SELECT * FROM users WHERE id = ?').bind(user_id).first<DBUser>();
			if (!user) return jsonResponse({ error: 'User not found' }, 404);
				const role = user.role || 'user';
				return jsonResponse({
					success: true,
					user: {
						id: user.id,
						email: user.email,
						username: user.username,
						avatar_url: user.avatar_url,
						role,
						totp_enabled: !!user.totp_enabled,
						email_notifications: user.email_notifications === 1,
						...(role === 'admin'
							? { admin_panel_path: adminPanelHref((env as any).ADMIN_PANEL_PATH) }
							: {})
					}
				});
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/user/delete
		if (url.pathname === '/api/user/delete' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				const body = await request.json() as any;
				const { password, totp_code } = body;
				
				if (!password) return jsonResponse({ error: 'Missing credentials' }, 400);

				const user_id = userPayload.id;

				const user = await env.cforum_db.prepare('SELECT * FROM users WHERE id = ?').bind(user_id).first<DBUser>();
				if (!user) return jsonResponse({ error: 'User not found' }, 404);

				// Verify Password (Double check for sensitive delete op)
				const passwordHash = await hashPassword(password);
				if (user.password !== passwordHash) {
					return jsonResponse({ error: 'Invalid password' }, 401);
				}

				// Verify TOTP if enabled
				if (user.totp_enabled) {
					if (!totp_code) return jsonResponse({ error: 'TOTP_REQUIRED' }, 403);
					if (!user.totp_secret) return jsonResponse({ error: 'TOTP not configured' }, 500);
					const totp = new OTPAuth.TOTP({
						algorithm: 'SHA1',
						digits: 6,
						period: 30,
						secret: OTPAuth.Secret.fromBase32(String(user.totp_secret))
					});
					if (totp.validate({ token: totp_code, window: 1 }) === null) {
						return jsonResponse({ error: 'Invalid TOTP code' }, 401);
					}
				}

				// Delete User and Data
				
				// 1. Delete images (Avatar + Post images)
				const posts: any = await env.cforum_db.prepare('SELECT content FROM posts WHERE author_id = ?').bind(user_id).all();
				const deletionPromises: Promise<any>[] = [];
				
				if (user.avatar_url) {
					deletionPromises.push(deleteImage(env as unknown as S3Env, user.avatar_url, user_id));
				}
				
				if (posts.results) {
					for (const post of posts.results) {
						const imageUrls = extractImageUrls(post.content as string);
						imageUrls.forEach(url => deletionPromises.push(deleteImage(env as unknown as S3Env, url, user_id)));
					}
				}
				
				if (deletionPromises.length > 0) {
					 ctx.waitUntil(Promise.all(deletionPromises).catch(err => console.error('Failed to delete user images', err)));
				}

				// 2. Delete likes/comments ON user's posts (Cascade manually)
				await env.cforum_db.prepare('DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)').bind(user_id).run();
				await env.cforum_db.prepare('DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)').bind(user_id).run();

				// 3. Delete user's activity
				await env.cforum_db.prepare('DELETE FROM likes WHERE user_id = ?').bind(user_id).run();
				await env.cforum_db.prepare('DELETE FROM comments WHERE author_id = ?').bind(user_id).run();
				
				// 4. Delete posts and user
				await env.cforum_db.prepare('DELETE FROM posts WHERE author_id = ?').bind(user_id).run();
				await env.cforum_db.prepare('DELETE FROM users WHERE id = ?').bind(user_id).run();
				
				await security.logAudit(userPayload.id, 'DELETE_ACCOUNT', 'user', String(user_id), {}, request);

				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/user/totp/setup
		if (url.pathname === '/api/user/totp/setup' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				const user_id = userPayload.id; // Force use of authenticated ID
				
				const secret = new OTPAuth.Secret({ size: 20 });
				const secretBase32 = secret.base32;

				await env.cforum_db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').bind(secretBase32, user_id).run();

				const user = await env.cforum_db.prepare('SELECT email FROM users WHERE id = ?').bind(user_id).first<DBUserEmail>();
			if (!user) return jsonResponse({ error: 'User not found' }, 404);
				
				await security.logAudit(userPayload.id, 'SETUP_TOTP', 'user', String(user_id), {}, request);

				const totp = new OTPAuth.TOTP({
					issuer: 'CloudflareForum',
					label: user.email,
					algorithm: 'SHA1',
					digits: 6,
					period: 30,
					secret: secret
				});

				return jsonResponse({ 
					secret: secretBase32,
					uri: totp.toString() 
				});
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/user/totp/verify
		if (url.pathname === '/api/user/totp/verify' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				const body = await request.json() as any;
				const { token } = body;
				const user_id = userPayload.id; // Force use of authenticated ID

				if (!token) return jsonResponse({ error: 'Missing parameters' }, 400);

				const user = await env.cforum_db.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(user_id).first<DBUserTotp>();
				
				if (!user || !user.totp_secret) return jsonResponse({ error: 'TOTP not setup' }, 400);

				const totp = new OTPAuth.TOTP({
					algorithm: 'SHA1',
					digits: 6,
					period: 30,
					secret: OTPAuth.Secret.fromBase32(user.totp_secret)
				});

				const delta = totp.validate({ token: token, window: 1 });

				if (delta !== null) {
					await env.cforum_db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').bind(user_id).run();
					await security.logAudit(userPayload.id, 'ENABLE_TOTP', 'user', String(user_id), {}, request);
					return jsonResponse({ success: true });
				} else {
					return jsonResponse({ error: 'Invalid code' }, 400);
				}
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/auth/forgot-password
		if (url.pathname === '/api/auth/forgot-password' && method === 'POST') {
			try {
				const body = await request.json() as any;

				// Turnstile Check
				const ip = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
				if (!(await checkTurnstile(body, ip))) {
					return jsonResponse({ error: 'Turnstile verification failed' }, 403);
				}

				const { email } = body;
				if (!email) return jsonResponse({ error: 'Missing email' }, 400);

				const user = await env.cforum_db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
				if (!user) return jsonResponse({ success: true }); // Silent fail

				const token = generateToken();
				const expires = Date.now() + 3600000; // 1 hour

				await env.cforum_db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?')
					.bind(token, expires, user.id).run();

				const baseUrl = getBaseUrl();
				const resetLink = `${baseUrl}/reset?token=${token}`;
				
				const emailHtml = `
					<h1>密码重置请求</h1>
					<p>请点击下方链接重置您的密码：</p>
					<a href="${resetLink}">重置密码</a>
					<p>如果您未请求此操作，请忽略此邮件。</p>
					<p>此链接将在 1 小时后失效。</p>
				`;

				ctx.waitUntil(sendEmail(email, '密码重置请求', emailHtml, env).catch(console.error));
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /auth/reset-password
		if (url.pathname === '/api/auth/reset-password' && method === 'POST') {
			try {
				const body = await request.json() as any;

				// Turnstile Check
				const ip = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
				if (!(await checkTurnstile(body, ip))) {
					return jsonResponse({ error: 'Turnstile verification failed' }, 403);
				}

				const { token, new_password, totp_code } = body;
				if (!token || !new_password) return jsonResponse({ error: 'Missing parameters' }, 400);

				if (new_password.length < 8 || new_password.length > 16) return jsonResponse({ error: 'Password must be 8-16 characters' }, 400);

				// Verify token
				const user = await env.cforum_db.prepare('SELECT * FROM users WHERE reset_token = ?').bind(token).first<DBUser>();
				if (!user) return jsonResponse({ error: 'Invalid token' }, 400);
				if (!user.reset_token_expires || Date.now() > user.reset_token_expires) return jsonResponse({ error: 'Token expired' }, 400);

				// If user has 2FA, require it
				if (user.totp_enabled) {
					if (!totp_code) return jsonResponse({ error: 'TOTP_REQUIRED' }, 403);
					if (!user.totp_secret) return jsonResponse({ error: 'TOTP not configured' }, 500);
					const totp = new OTPAuth.TOTP({
						algorithm: 'SHA1',
						digits: 6,
						period: 30,
						secret: OTPAuth.Secret.fromBase32(String(user.totp_secret))
					});
					if (totp.validate({ token: totp_code, window: 1 }) === null) {
						return jsonResponse({ error: 'Invalid TOTP code' }, 401);
					}
				}

				const passwordHash = await hashPassword(new_password);
				await env.cforum_db.prepare('UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
					.bind(passwordHash, user.id).run();

				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/user/change-email
		if (url.pathname === '/api/user/change-email' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				const body = await request.json() as any;
				const { new_email, totp_code } = body; 
				
				if (!new_email) return jsonResponse({ error: 'Missing parameters' }, 400);
				
				if (new_email.length > 50) return jsonResponse({ error: 'Email too long (Max 50 chars)' }, 400);
				
				const user_id = userPayload.id;

const user = await env.cforum_db.prepare('SELECT * FROM users WHERE id = ?').bind(user_id).first<DBUser>();
				if (!user) return jsonResponse({ error: 'User not found' }, 404);

				// Verify 2FA if enabled
				if (user.totp_enabled) {
					if (!totp_code) return jsonResponse({ error: 'TOTP_REQUIRED' }, 403);
					if (!user.totp_secret) return jsonResponse({ error: 'TOTP not configured' }, 500);
					const totp = new OTPAuth.TOTP({
						algorithm: 'SHA1',
						digits: 6,
						period: 30,
						secret: OTPAuth.Secret.fromBase32(String(user.totp_secret))
					});
					if (totp.validate({ token: totp_code, window: 1 }) === null) {
						return jsonResponse({ error: 'Invalid TOTP code' }, 401);
					}
				}

				// Check if email already exists
				const exists = await env.cforum_db.prepare('SELECT id FROM users WHERE email = ?').bind(new_email).first();
				if (exists) return jsonResponse({ error: 'Email already in use' }, 400);

				const token = generateToken();
				await env.cforum_db.prepare('UPDATE users SET pending_email = ?, email_change_token = ? WHERE id = ?')
					.bind(new_email, token, user.id).run();
				
				await security.logAudit(userPayload.id, 'CHANGE_EMAIL_INIT', 'user', String(user_id), { new_email }, request);

				const baseUrl = getBaseUrl();
				const verifyLink = `${baseUrl}/api/verify-email-change?token=${token}`;
				const emailHtml = `
					<h1>确认更换邮箱</h1>
					<p>请点击下方链接确认将您的邮箱更换为 ${new_email}：</p>
					<a href="${verifyLink}">确认更换</a>
				`;

				ctx.waitUntil(sendEmail(new_email, '确认更换邮箱', emailHtml, env).catch(console.error));
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/verify-email-change
		if (url.pathname === '/api/verify-email-change' && method === 'GET') {
			const token = url.searchParams.get('token');
			if (!token) return new Response('Missing token', { status: 400 });

			try {
const user = await env.cforum_db.prepare('SELECT * FROM users WHERE email_change_token = ?').bind(token).first<DBUser>();
				if (!user) return new Response('Invalid token', { status: 400 });

				await env.cforum_db.prepare('UPDATE users SET email = ?, pending_email = NULL, email_change_token = NULL WHERE id = ?')
					.bind(user.pending_email, user.id).run();

				return Response.redirect(`${getBaseUrl()}/?email_changed=true`, 302);
			} catch (e) {
				return new Response('Failed', { status: 500 });
			}
		}

		// POST /api/admin/users/:id/update (Admin direct update)
		if (url.pathname.match(/^\/api\/admin\/users\/\d+\/update$/) && method === 'POST') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const body = await request.json() as any;
				const { password, email, username, avatar_url } = body;

				if (password && (password.length < 8 || password.length > 16)) {
					return jsonResponse({ error: '密码必须为 8-16 个字符' }, 400);
				}

				if (password) {
					const hash = await hashPassword(password);
					await env.cforum_db.prepare('UPDATE users SET password = ? WHERE id = ?').bind(hash, id).run();
				}
				if (email) {
					if (email.length > 50) return jsonResponse({ error: 'Email too long (Max 50 chars)' }, 400);
					await env.cforum_db.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email, id).run();
				}
				if (avatar_url !== undefined) {
					try {
						const nextAvatar = !avatar_url
							? await createDefaultAvatarUrl(id)
							: await normalizeAvatarUrl(id, String(avatar_url));
						await env.cforum_db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(nextAvatar, id).run();
					} catch (avatarErr: any) {
						return jsonResponse({ error: String(avatarErr?.message || avatarErr) }, 400);
					}

					// Notify Avatar Change
					const notifyAvatar = await env.cforum_db.prepare("SELECT value FROM settings WHERE key = 'notify_on_avatar_change'").first<DBSetting>();
					if (notifyAvatar && notifyAvatar.value === '1') {
						const user = await env.cforum_db.prepare('SELECT email, username FROM users WHERE id = ?').bind(id).first<{email:string;username:string}>();
						if (user) {
							const emailHtml = `
								<h1>头像已更新</h1>
								<p>您的头像已被管理员更新。</p>
							`;
							ctx.waitUntil(sendEmail(user.email, '您的头像已更新', emailHtml, env).catch(console.error));
						}
					}
				}
				if (username) {
					if (username.length > 20) return jsonResponse({ error: 'Username too long (Max 20 chars)' }, 400);
					if (isVisuallyEmpty(username)) return jsonResponse({ error: 'Username cannot be empty' }, 400);
					if (hasInvisibleCharacters(username)) return jsonResponse({ error: 'Username contains invalid invisible characters' }, 400);
					if (hasControlCharacters(username)) return jsonResponse({ error: 'Username contains invalid control characters' }, 400);
					
					await env.cforum_db.prepare('UPDATE users SET username = ? WHERE id = ?').bind(username, id).run();

					// Notify user about username change
					const notifyUsername = await env.cforum_db.prepare("SELECT value FROM settings WHERE key = 'notify_on_username_change'").first<DBSetting>();
					if (notifyUsername && notifyUsername.value === '1') {
						const user = await env.cforum_db.prepare('SELECT email, username FROM users WHERE id = ?').bind(id).first<{email:string;username:string}>();
						if (user) {
							const emailHtml = `
								<h1>用户名已修改</h1>
								<p>您的用户名已被管理员修改为 <strong>${username}</strong>。</p>
								<p>如有疑问，请联系管理员。</p>
							`;
							ctx.waitUntil(sendEmail(user.email, '您的用户名已修改', emailHtml, env).catch(console.error));
						}
					}
				}
				
				await security.logAudit(userPayload.id, 'ADMIN_UPDATE_USER', 'user', id, { username, email, avatar_url, passwordChanged: !!password }, request);

				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/categories
		if (url.pathname === '/api/categories' && method === 'GET') {
			try {
				const { results } = await env.cforum_db
					.prepare(
						`SELECT id, name,
							IFNULL(subtitle, '') AS subtitle,
							IFNULL(admin_only, 0) AS admin_only,
							IFNULL(show_on_site, 0) AS show_on_site,
							IFNULL(show_on_forum, 1) AS show_on_forum,
							IFNULL(sort_order, 0) AS sort_order,
							IFNULL(status_options, '[]') AS status_options,
							IFNULL(author_can_set_status, 0) AS author_can_set_status,
							IFNULL(enable_cite, 0) AS enable_cite,
							IFNULL(enable_cited_from, 0) AS enable_cited_from,
							IFNULL(enable_relate, 0) AS enable_relate,
							created_at
						 FROM categories
						 ORDER BY IFNULL(sort_order, 0) ASC, id ASC`
					)
					.all();
				return jsonResponse(
					(results || []).map((row: any) => ({
						...row,
						subtitle: String(row.subtitle || ''),
						admin_only: Number(row.admin_only) === 1,
						show_on_site: Number(row.show_on_site) === 1,
						show_on_forum: Number(row.show_on_forum) === 1,
						sort_order: Number(row.sort_order || 0),
						status_options: parseStatusOptions(row.status_options),
						author_can_set_status: Number(row.author_can_set_status) === 1,
						enable_cite: Number(row.enable_cite) === 1,
						enable_cited_from: Number(row.enable_cited_from) === 1,
						enable_relate: Number(row.enable_relate) === 1
					}))
				);
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/export/site-meta — public brand copy for official site builds
		if (url.pathname === '/api/export/site-meta' && method === 'GET') {
			try {
				const settings = await env.cforum_db.prepare('SELECT key, value FROM settings').all();
				const meta: Record<string, string> = { ...SITE_META_DEFAULTS };
				for (const row of settings.results || []) {
					const key = String((row as any).key || '');
					if (key in SITE_META_DEFAULTS) {
						meta[key] = String((row as any).value ?? meta[key]);
					}
				}
				meta.friend_links = normalizeFriendLinksJson(meta.friend_links);
				meta.community_home_url = String(meta.community_home_url || SITE_META_DEFAULTS.community_home_url)
					.trim()
					.replace(/\/+$/, '') || SITE_META_DEFAULTS.community_home_url;
				return jsonResponse(meta);
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/export/site-categories — public, for official site builds
		if (url.pathname === '/api/export/site-categories' && method === 'GET') {
			try {
				const { results } = await env.cforum_db
					.prepare(
						`SELECT id, name, IFNULL(subtitle, '') AS subtitle,
							IFNULL(show_on_forum, 1) AS show_on_forum,
							IFNULL(sort_order, 0) AS sort_order, created_at
						 FROM categories
						 WHERE IFNULL(show_on_site, 0) = 1
						 ORDER BY IFNULL(sort_order, 0) ASC, id ASC`
					)
					.all();
				return jsonResponse(
					(results || []).map((row: any) => ({
						...row,
						subtitle: String(row.subtitle || ''),
						show_on_forum: Number(row.show_on_forum) === 1,
						sort_order: Number(row.sort_order || 0)
					}))
				);
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/export/site-posts — public posts in show_on_site categories
		if (url.pathname === '/api/export/site-posts' && method === 'GET') {
			try {
				const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 200);
				const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
				const categoryId = url.searchParams.get('category_id');

				// 仅管理员发帖栏目：可见帖均可上官网；非管理员栏目：需官网精选
				let query = `SELECT
						posts.id, posts.title, posts.content, posts.category_id, posts.created_at, posts.is_pinned,
						posts.site_featured,
						categories.name as category_name,
						users.username as author_name
					FROM posts
					JOIN users ON posts.author_id = users.id
					JOIN categories ON posts.category_id = categories.id
					WHERE IFNULL(categories.show_on_site, 0) = 1
					  AND IFNULL(posts.is_visible, 1) = 1
					  AND (
						IFNULL(categories.admin_only, 0) = 1
						OR IFNULL(posts.site_featured, 0) = 1
					  )`;
				const params: any[] = [];
				if (categoryId) {
					query += ` AND posts.category_id = ?`;
					params.push(categoryId);
				}
				query += ` ORDER BY posts.is_pinned DESC, posts.created_at DESC LIMIT ? OFFSET ?`;
				params.push(limit, offset);

				const { results } = await env.cforum_db.prepare(query).bind(...params).all();
				const posts = (results || []).map((row: any) => {
					const plain = String(row.content || '')
						.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
						.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
						.replace(/[#>*_`~\-]/g, ' ')
						.replace(/\s+/g, ' ')
						.trim();
					return {
						id: row.id,
						title: row.title,
						content: row.content,
						summary: plain.slice(0, 160),
						category_id: row.category_id,
						category_name: row.category_name,
						author_name: row.author_name,
						is_pinned: Number(row.is_pinned) === 1,
						site_featured: Number(row.site_featured) === 1,
						created_at: row.created_at
					};
				});
				return jsonResponse({ posts, total: posts.length });
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/export/site-posts/:id
		if (url.pathname.match(/^\/api\/export\/site-posts\/\d+$/) && method === 'GET') {
			const postId = url.pathname.split('/')[4];
			try {
				const post = await env.cforum_db
					.prepare(
						`SELECT
							posts.id, posts.title, posts.content, posts.category_id, posts.created_at, posts.is_pinned,
							posts.site_featured,
							categories.name as category_name,
							IFNULL(categories.admin_only, 0) AS admin_only,
							users.username as author_name
						 FROM posts
						 JOIN users ON posts.author_id = users.id
						 JOIN categories ON posts.category_id = categories.id
						 WHERE posts.id = ? AND IFNULL(categories.show_on_site, 0) = 1
						   AND IFNULL(posts.is_visible, 1) = 1`
					)
					.bind(postId)
					.first();
				if (!post) return jsonResponse({ error: 'Post not found' }, 404);
				const adminOnlyCat = Number((post as any).admin_only ?? 0) === 1;
				if (!adminOnlyCat && Number((post as any).site_featured ?? 0) !== 1) {
					return jsonResponse({ error: 'Post not found' }, 404);
				}

				const { results: featuredComments } = await env.cforum_db
					.prepare(
						`SELECT
							comments.id,
							comments.content,
							comments.created_at,
							users.username AS author_name,
							users.avatar_url AS author_avatar
						 FROM comments
						 JOIN users ON comments.author_id = users.id
						 WHERE comments.post_id = ?
						   AND comments.parent_id IS NULL
						   AND IFNULL(comments.is_featured, 0) = 1
						 ORDER BY comments.created_at ASC`
					)
					.bind(postId)
					.all();

				return jsonResponse({
					...post,
					is_pinned: Number((post as any).is_pinned) === 1,
					site_featured: Number((post as any).site_featured) === 1,
					featured_comments: (featuredComments || []).map((row: any) => ({
						id: row.id,
						content: row.content,
						created_at: row.created_at,
						author_name: row.author_name,
						author_avatar: row.author_avatar || null
					}))
				});
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/post-templates?category_id=
		if (url.pathname === '/api/post-templates' && method === 'GET') {
			try {
				const categoryId = url.searchParams.get('category_id');
				if (!categoryId) return jsonResponse([]);
				const { results } = await env.cforum_db
					.prepare(
						`SELECT t.id, t.name, t.body, t.sort_order
						 FROM post_templates t
						 JOIN post_template_categories tc ON tc.template_id = t.id
						 WHERE tc.category_id = ?
						 ORDER BY t.sort_order ASC, t.id ASC`
					)
					.bind(categoryId)
					.all();
				return jsonResponse(results || []);
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/admin/post-templates
		if (url.pathname === '/api/admin/post-templates' && method === 'GET') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const { results: templates } = await env.cforum_db
					.prepare(
						`SELECT id, name, body, sort_order, created_at FROM post_templates ORDER BY sort_order ASC, id DESC`
					)
					.all();
				const { results: links } = await env.cforum_db
					.prepare(`SELECT template_id, category_id FROM post_template_categories`)
					.all<{ template_id: number; category_id: number }>();
				const byTpl = new Map<number, number[]>();
				for (const row of links || []) {
					const list = byTpl.get(row.template_id) || [];
					list.push(row.category_id);
					byTpl.set(row.template_id, list);
				}
				return jsonResponse(
					(templates || []).map((t: any) => ({
						...t,
						category_ids: byTpl.get(Number(t.id)) || []
					}))
				);
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/post-templates
		if (url.pathname === '/api/admin/post-templates' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const body = (await request.json()) as any;
				const name = String(body?.name || '').trim().slice(0, 40);
				const tplBody = String(body?.body || '').slice(0, 3000);
				const categoryIds = Array.isArray(body?.category_ids)
					? body.category_ids.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0)
					: [];
				if (!name) return jsonResponse({ error: '请输入模板名称' }, 400);
				const maxOrder =
					(
						await env.cforum_db
							.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM post_templates')
							.first<{ m: number }>()
					)?.m ?? 0;
				const inserted = await env.cforum_db
					.prepare(`INSERT INTO post_templates (name, body, sort_order) VALUES (?, ?, ?)`)
					.bind(name, tplBody, maxOrder + 1)
					.run();
				const templateId = Number(inserted.meta?.last_row_id);
				if (templateId && categoryIds.length) {
					const stmt = env.cforum_db.prepare(
						`INSERT OR IGNORE INTO post_template_categories (template_id, category_id) VALUES (?, ?)`
					);
					await env.cforum_db.batch(categoryIds.map((cid: number) => stmt.bind(templateId, cid)));
				}
				await security.logAudit(userPayload.id, 'CREATE_POST_TEMPLATE', 'post_template', String(templateId), {
					name,
					category_ids: categoryIds
				}, request);
				return jsonResponse({ success: true, id: templateId });
			} catch (e) {
				return handleError(e);
			}
		}

		// PUT /api/admin/post-templates/:id
		if (url.pathname.match(/^\/api\/admin\/post-templates\/\d+$/) && method === 'PUT') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const body = (await request.json()) as any;
				const name = String(body?.name || '').trim().slice(0, 40);
				const tplBody = String(body?.body || '').slice(0, 3000);
				const categoryIds = Array.isArray(body?.category_ids)
					? body.category_ids.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0)
					: [];
				if (!name) return jsonResponse({ error: '请输入模板名称' }, 400);
				await env.cforum_db
					.prepare(`UPDATE post_templates SET name = ?, body = ? WHERE id = ?`)
					.bind(name, tplBody, id)
					.run();
				await env.cforum_db.prepare(`DELETE FROM post_template_categories WHERE template_id = ?`).bind(id).run();
				if (categoryIds.length) {
					const stmt = env.cforum_db.prepare(
						`INSERT OR IGNORE INTO post_template_categories (template_id, category_id) VALUES (?, ?)`
					);
					await env.cforum_db.batch(categoryIds.map((cid: number) => stmt.bind(id, cid)));
				}
				await security.logAudit(userPayload.id, 'UPDATE_POST_TEMPLATE', 'post_template', id, {
					name,
					category_ids: categoryIds
				}, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// DELETE /api/admin/post-templates/:id
		if (url.pathname.match(/^\/api\/admin\/post-templates\/\d+$/) && method === 'DELETE') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				await env.cforum_db.prepare(`DELETE FROM post_template_categories WHERE template_id = ?`).bind(id).run();
				await env.cforum_db.prepare(`DELETE FROM post_templates WHERE id = ?`).bind(id).run();
				await security.logAudit(userPayload.id, 'DELETE_POST_TEMPLATE', 'post_template', id, {}, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/categories
		if (url.pathname === '/api/admin/categories' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const body = await request.json() as any;
				const {
					name,
					admin_only,
					show_on_site,
					show_on_forum,
					subtitle,
					status_options,
					author_can_set_status,
					enable_cite,
					enable_cited_from,
					enable_relate
				} = body;
				if (!name) return jsonResponse({ error: 'Missing name' }, 400);
				const subtitleValue = show_on_site ? String(subtitle || '').trim().slice(0, 200) : '';
				const statusOptionsJson = serializeStatusOptions(status_options);
				const maxOrder =
					(
						await env.cforum_db
							.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories')
							.first<{ m: number }>()
					)?.m ?? 0;
				const sortOrder = maxOrder + 1;
				
				const { success } = await env.cforum_db
					.prepare(
						`INSERT INTO categories
							(name, subtitle, admin_only, show_on_site, show_on_forum, sort_order, status_options,
							 author_can_set_status, enable_cite, enable_cited_from, enable_relate)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						name,
						subtitleValue,
						admin_only ? 1 : 0,
						show_on_site ? 1 : 0,
						show_on_forum === false || show_on_forum === 0 ? 0 : 1,
						sortOrder,
						statusOptionsJson,
						author_can_set_status ? 1 : 0,
						enable_cite ? 1 : 0,
						enable_cited_from ? 1 : 0,
						enable_relate ? 1 : 0
					)
					.run();
				bumpMetaCacheVersion();
				await security.logAudit(userPayload.id, 'CREATE_CATEGORY', 'category', name, {
					admin_only: !!admin_only,
					show_on_site: !!show_on_site,
					show_on_forum: !(show_on_forum === false || show_on_forum === 0),
					subtitle: subtitleValue,
					sort_order: sortOrder,
					status_options: parseStatusOptions(statusOptionsJson),
					author_can_set_status: !!author_can_set_status,
					enable_cite: !!enable_cite,
					enable_cited_from: !!enable_cited_from,
					enable_relate: !!enable_relate
				}, request);
				return jsonResponse({ success });
			} catch (e) {
				return handleError(e);
			}
		}

		// PUT /api/admin/categories/:id
		if (url.pathname.match(/^\/api\/admin\/categories\/\d+$/) && method === 'PUT') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const body = await request.json() as any;
				const {
					name,
					admin_only,
					show_on_site,
					show_on_forum,
					subtitle,
					status_options,
					author_can_set_status,
					enable_cite,
					enable_cited_from,
					enable_relate
				} = body;
				if (!name) return jsonResponse({ error: 'Missing name' }, 400);
				const subtitleValue = show_on_site ? String(subtitle || '').trim().slice(0, 200) : '';
				const statusOptionsJson = serializeStatusOptions(status_options);
				
				await env.cforum_db
					.prepare(
						`UPDATE categories SET name = ?, subtitle = ?, admin_only = ?, show_on_site = ?, show_on_forum = ?,
							status_options = ?, author_can_set_status = ?,
							enable_cite = ?, enable_cited_from = ?, enable_relate = ?
						 WHERE id = ?`
					)
					.bind(
						name,
						subtitleValue,
						admin_only ? 1 : 0,
						show_on_site ? 1 : 0,
						show_on_forum === false || show_on_forum === 0 ? 0 : 1,
						statusOptionsJson,
						author_can_set_status ? 1 : 0,
						enable_cite ? 1 : 0,
						enable_cited_from ? 1 : 0,
						enable_relate ? 1 : 0,
						id
					)
					.run();
				bumpMetaCacheVersion();
				await security.logAudit(userPayload.id, 'UPDATE_CATEGORY', 'category', id, {
					name,
					admin_only: !!admin_only,
					show_on_site: !!show_on_site,
					show_on_forum: !(show_on_forum === false || show_on_forum === 0),
					subtitle: subtitleValue,
					status_options: parseStatusOptions(statusOptionsJson),
					author_can_set_status: !!author_can_set_status,
					enable_cite: !!enable_cite,
					enable_cited_from: !!enable_cited_from,
					enable_relate: !!enable_relate
				}, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/categories/reorder — body: { ordered_ids: number[] }
		if (url.pathname === '/api/admin/categories/reorder' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const body = (await request.json()) as any;
				const orderedIds = Array.isArray(body?.ordered_ids)
					? body.ordered_ids.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n > 0)
					: [];
				if (!orderedIds.length) return jsonResponse({ error: 'Missing ordered_ids' }, 400);
				const stmt = env.cforum_db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
				const batch = orderedIds.map((id: number, idx: number) => stmt.bind(idx + 1, id));
				await env.cforum_db.batch(batch);
				bumpMetaCacheVersion();
				await security.logAudit(userPayload.id, 'REORDER_CATEGORIES', 'category', 'all', { ordered_ids: orderedIds }, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/import-posts — one-shot migration helper
		if (url.pathname === '/api/admin/import-posts' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const body = (await request.json()) as any;
				const items = Array.isArray(body?.posts) ? body.posts : [];
				if (!items.length) return jsonResponse({ error: 'Missing posts' }, 400);

				const created: number[] = [];
				for (const item of items) {
					const title = String(item?.title || '').trim().slice(0, 30);
					const content = String(item?.content || '').trim().slice(0, 3000);
					const categoryName = String(item?.category_name || '开发进度').trim();
					if (!title || !content) continue;

					let cat = await env.cforum_db
						.prepare('SELECT id FROM categories WHERE name = ?')
						.bind(categoryName)
						.first<{ id: number }>();
					if (!cat) {
						const inserted = await env.cforum_db
							.prepare(
								'INSERT INTO categories (name, admin_only, show_on_site, show_on_forum) VALUES (?, 1, 1, 1)'
							)
							.bind(categoryName)
							.run();
						cat = { id: Number(inserted.meta?.last_row_id) };
					}

					const result = await env.cforum_db
						.prepare('INSERT INTO posts (author_id, title, content, category_id) VALUES (?, ?, ?, ?)')
						.bind(userPayload.id, title, content, cat.id)
						.run();
					const postId = Number(result.meta?.last_row_id);
					if (item?.created_at && postId) {
						try {
							await env.cforum_db
								.prepare('UPDATE posts SET created_at = ? WHERE id = ?')
								.bind(String(item.created_at), postId)
								.run();
						} catch {
							// ignore date rewrite failures
						}
					}
					if (postId) created.push(postId);
				}

				await security.logAudit(userPayload.id, 'ADMIN_IMPORT_POSTS', 'post', 'batch', { count: created.length }, request);
				return jsonResponse({ success: true, ids: created }, 201);
			} catch (e) {
				return handleError(e);
			}
		}

		// DELETE /api/admin/categories/:id
		if (url.pathname.match(/^\/api\/admin\/categories\/\d+$/) && method === 'DELETE') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				// Check if there are posts in this category
				const count = await env.cforum_db.prepare('SELECT COUNT(*) as count FROM posts WHERE category_id = ?').bind(id).first<number>('count');
				if ((count ?? 0) > 0) {
					return jsonResponse({ error: '该分类下仍有帖子，无法删除。请先将帖子移到其他分类或删除后再试。' }, 400);
				}
				
				await env.cforum_db.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
				bumpMetaCacheVersion();
				await security.logAudit(userPayload.id, 'DELETE_CATEGORY', 'category', id, {}, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// --- ADMIN ROUTES ---

		// GET /api/admin/stats
		if (url.pathname === '/api/admin/stats' && method === 'GET') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const [userCount, postCount, commentCount] = await Promise.all([
					env.cforum_db.prepare('SELECT COUNT(*) as count FROM users').first<number>('count'),
					env.cforum_db.prepare('SELECT COUNT(*) as count FROM posts').first<number>('count'),
					env.cforum_db.prepare('SELECT COUNT(*) as count FROM comments').first<number>('count')
				]);
				
				return jsonResponse({
					users: userCount,
					posts: postCount,
					comments: commentCount
				});
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/admin/users
		if (url.pathname === '/api/admin/users' && method === 'GET') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const { results } = await env.cforum_db
					.prepare(
						`SELECT id, email, username, role, verified, created_at, avatar_url, posting_cooldown_until
						 FROM users ORDER BY created_at DESC`
					)
					.all();
				return jsonResponse(results);
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/users/:id/clear-cooldown
		if (url.pathname.match(/^\/api\/admin\/users\/\d+\/clear-cooldown$/) && method === 'POST') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				await clearPostingCooldown(env.cforum_db, Number(id));
				await security.logAudit(userPayload.id, 'CLEAR_POSTING_COOLDOWN', 'user', id, {}, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/users/:id/cooldown — body: { hours: 1|24|168|8760 }
		if (url.pathname.match(/^\/api\/admin\/users\/\d+\/cooldown$/) && method === 'POST') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const body = (await request.json()) as any;
				if (!isAdminCooldownHours(body?.hours)) {
					return jsonResponse({ error: '冷却时长无效（可选 1 / 24 / 168 / 8760 小时）' }, 400);
				}
				const target = await env.cforum_db
					.prepare('SELECT id, role FROM users WHERE id = ?')
					.bind(id)
					.first<{ id: number; role: string }>();
				if (!target) return jsonResponse({ error: '用户不存在' }, 404);
				if (target.role === 'admin') {
					return jsonResponse({ error: '不能给管理员账号加冷却' }, 403);
				}
				const result = await setPostingCooldownHours(env.cforum_db, Number(id), body.hours);
				await security.logAudit(
					userPayload.id,
					'SET_POSTING_COOLDOWN',
					'user',
					id,
					{ hours: body.hours, cooldown_until: result.cooldownUntil },
					request
				);
				return jsonResponse({ success: true, ...result });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/users/:id/verify (Manual Verify)
		if (url.pathname.match(/^\/api\/admin\/users\/\d+\/verify$/) && method === 'POST') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const { success } = await env.cforum_db.prepare('UPDATE users SET verified = 1, verification_token = NULL WHERE id = ?').bind(id).run();
				await security.logAudit(userPayload.id, 'MANUAL_VERIFY_USER', 'user', id, {}, request);

				// Notification
				const setting = await env.cforum_db.prepare("SELECT value FROM settings WHERE key = 'notify_on_manual_verify'").first<DBSetting>();
				if (setting && setting.value === '1') {
					const user = await env.cforum_db.prepare('SELECT email, username FROM users WHERE id = ?').bind(id).first<{email:string;username:string}>();
					if (!user) throw new Error('User unexpectedly missing');
					const emailHtml = `
						<h1>账户已验证</h1>
						<p>您的账户 (用户名: <strong>${user.username}</strong>) 已通过管理员手动验证。</p>
						<p>您现在可以登录并使用所有功能。</p>
					`;
					ctx.waitUntil(sendEmail(user.email as string, '您的账户已通过验证', emailHtml, env).catch(console.error));
				}

				return jsonResponse({ success });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/users/:id/resend (Resend Verification Email)
		if (url.pathname.match(/^\/api\/admin\/users\/\d+\/resend$/) && method === 'POST') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const user = await env.cforum_db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<DBUser>();
				if (!user) return jsonResponse({ error: 'User not found' }, 404);
				if (user.verified) return jsonResponse({ error: 'User already verified' }, 400);

				// Generate new token if needed, or use existing
				let token = user.verification_token;
				if (!token) {
					token = generateToken();
					await env.cforum_db.prepare('UPDATE users SET verification_token = ? WHERE id = ?').bind(token, id).run();
				}

				const baseUrl = getBaseUrl();
				const verifyLink = `${baseUrl}/api/verify?token=${token}`;
				const emailHtml = `
					<h1>欢迎加入社区，${user.username}！</h1>
					<p>请点击下方链接验证您的邮箱地址：</p>
					<a href="${verifyLink}">验证邮箱</a>
					<p>如果您未请求此操作，请忽略此邮件。</p>
				`;

				ctx.waitUntil(
					sendEmail(user.email, '请验证您的邮箱', emailHtml, env)
						.catch(err => console.error('[Background Email Error]', err))
				);
				
				await security.logAudit(userPayload.id, 'RESEND_VERIFY_EMAIL', 'user', id, {}, request);

				return jsonResponse({ success: true, message: '验证邮件已发送' });
			} catch (e) {
				return handleError(e);
			}
		}

		// DELETE /api/admin/users/:id
		if (url.pathname.startsWith('/api/admin/users/') && method === 'DELETE') {
			const id = url.pathname.split('/').pop();
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				// 0. Delete user avatar and post images
				const user = await env.cforum_db.prepare('SELECT avatar_url FROM users WHERE id = ?').bind(id).first<{avatar_url?: string}>();
				const posts = await env.cforum_db.prepare('SELECT content FROM posts WHERE author_id = ?').bind(id).all();
				
				const deletionPromises: Promise<any>[] = [];
				if (user && user.avatar_url) {
					deletionPromises.push(deleteImage(env as unknown as S3Env, user.avatar_url, id));
				}
				if (posts.results) {
					for (const post of posts.results) {
						const imageUrls = extractImageUrls(post.content as string);
						imageUrls.forEach(url => deletionPromises.push(deleteImage(env as unknown as S3Env, url, id)));
					}
				}
				if (deletionPromises.length > 0) {
					ctx.waitUntil(Promise.all(deletionPromises).catch(err => console.error('Failed to delete user images', err)));
				}

				// 1. Delete likes and comments ON the user's posts (to avoid orphans)
				await env.cforum_db.prepare('DELETE FROM likes WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)').bind(id).run();
				await env.cforum_db.prepare('DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)').bind(id).run();

				// 2. Delete the user's own activity (likes and comments they made)
				await env.cforum_db.prepare('DELETE FROM likes WHERE user_id = ?').bind(id).run();
				await env.cforum_db.prepare('DELETE FROM comments WHERE author_id = ?').bind(id).run();

				// 3. Delete the user's posts
				await env.cforum_db.prepare('DELETE FROM posts WHERE author_id = ?').bind(id).run();

				// 4. Finally, delete the user
				const userToDelete = await env.cforum_db.prepare('SELECT email, username FROM users WHERE id = ?').bind(id).first();
				await env.cforum_db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
				
				await security.logAudit(userPayload.id, 'ADMIN_DELETE_USER', 'user', String(id), {}, request);

				// Notification
				if (userToDelete) {
					const setting = await env.cforum_db.prepare("SELECT value FROM settings WHERE key = 'notify_on_user_delete'").first();
					if (setting && setting.value === '1') {
						const emailHtml = `
							<h1>账户已删除</h1>
							<p>您的账户 (用户名: <strong>${userToDelete.username}</strong>) 已被管理员删除。</p>
							<p>如果您认为这是误操作，请联系管理员。</p>
						`;
						ctx.waitUntil(sendEmail(userToDelete.email as string, '您的账户已被删除', emailHtml, env).catch(console.error));
					}
				}

				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// DELETE /api/admin/posts/:id
		if (url.pathname.startsWith('/api/admin/posts/') && method === 'DELETE') {
			const id = url.pathname.split('/').pop();
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				// Delete images in post
				const post = await env.cforum_db.prepare('SELECT content, author_id FROM posts WHERE id = ?').bind(id).first();
				if (post) {
					const imageUrls = extractImageUrls(post.content as string);
					if (imageUrls.length > 0) {
						ctx.waitUntil(Promise.all(imageUrls.map(url => deleteImage(env as unknown as S3Env, url, post.author_id as number))).catch(err => console.error('Failed to delete post images', err)));
					}
				}

				await env.cforum_db.prepare('DELETE FROM likes WHERE post_id = ?').bind(id).run();
				await env.cforum_db.prepare('DELETE FROM comments WHERE post_id = ?').bind(id).run();
				await env.cforum_db.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
				
				await security.logAudit(userPayload.id, 'ADMIN_DELETE_POST', 'post', String(id), {}, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// DELETE /api/admin/comments/:id
		if (url.pathname.startsWith('/api/admin/comments/') && method === 'DELETE') {
			const id = url.pathname.split('/').pop();
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				// Delete the comment AND its children (orphans prevention)
				await env.cforum_db.prepare('DELETE FROM comments WHERE parent_id = ?').bind(id).run();
				await env.cforum_db.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
				
				await security.logAudit(userPayload.id, 'ADMIN_DELETE_COMMENT', 'comment', String(id), {}, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/posts/:id/pin
		if (url.pathname.match(/^\/api\/admin\/posts\/\d+\/pin$/) && method === 'POST') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const body = await request.json() as any;
				const { pinned } = body;
				await env.cforum_db.prepare('UPDATE posts SET is_pinned = ? WHERE id = ?').bind(pinned ? 1 : 0, id).run();
				
				await security.logAudit(userPayload.id, 'ADMIN_PIN_POST', 'post', id, { pinned }, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/posts/:id/move
		if (url.pathname.match(/^\/api\/admin\/posts\/\d+\/move$/) && method === 'POST') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const body = await request.json() as any;
				const { category_id } = body;
				
				if (!category_id) return jsonResponse({ error: '请选择分类' }, 400);
				const category = await env.cforum_db
					.prepare(`SELECT id, IFNULL(status_options, '[]') AS status_options FROM categories WHERE id = ?`)
					.bind(category_id)
					.first<{ id: number; status_options: string }>();
				if (!category) return jsonResponse({ error: 'Category not found' }, 404);
				const nextStatus = defaultStatusForOptions(parseStatusOptions(category.status_options));

				await env.cforum_db
					.prepare('UPDATE posts SET category_id = ?, status = ? WHERE id = ?')
					.bind(category_id, nextStatus, id)
					.run();
				
				await security.logAudit(userPayload.id, 'ADMIN_MOVE_POST', 'post', id, { category_id, status: nextStatus }, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/admin/cleanup/analyze
		if (url.pathname === '/api/admin/cleanup/analyze' && method === 'GET') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
                                
				// 1. List all S3 objects
				const allKeys = await listAllKeys(env as unknown as S3Env);
				
				// 2. Gather used URLs
				const usedKeys = new Set<string>();

				// Users avatars
				const users = await env.cforum_db.prepare('SELECT avatar_url FROM users WHERE avatar_url IS NOT NULL').all();
				for (const u of users.results) {
					const uUrl = u.avatar_url as string;
					const key = uUrl ? getKeyFromUrl(env as unknown as S3Env, uUrl) : null;
					if (key) usedKeys.add(key);
				}

				// Posts images
				const posts = await env.cforum_db.prepare('SELECT content FROM posts').all();
				for (const p of posts.results) {
					const urls = extractImageUrls(p.content as string);
					for (const uUrl of urls) {
						const key = uUrl ? getKeyFromUrl(env as unknown as S3Env, uUrl) : null;
						if (key) usedKeys.add(key);
					}
				}

				// 3. Find orphans
				const orphans = allKeys.filter(key => !usedKeys.has(key));

				return jsonResponse({ 
					total_files: allKeys.length,
					used_files: usedKeys.size,
					orphaned_files: orphans.length,
					orphans: orphans
				});

			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/cleanup/execute
		if (url.pathname === '/api/admin/cleanup/execute' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				
				const body = await request.json() as any;
				const { orphans } = body;
				
				if (!orphans || !Array.isArray(orphans)) return jsonResponse({ error: 'Invalid parameters' }, 400);

				const deletePromises = orphans.map(key => deleteImage(env as unknown as S3Env, key));
				
				ctx.waitUntil(Promise.all(deletePromises).catch(err => console.error('Cleanup failed', err)));
				
				return jsonResponse({ success: true, message: `Deletion of ${orphans.length} files started` });
			} catch (e) {
				return handleError(e);
			}
		}

		// --- END ADMIN ROUTES ---

		// TEST: Email Debug
		if (url.pathname === '/api/test-email' && method === 'POST') {
			try {
				const body = await request.json() as any;
				const { to } = body;
				if (!to) return jsonResponse({ error: '缺少收件人地址' }, 400);

				console.log('[DEBUG] Starting test email to:', to);
				await sendEmail(to, '测试邮件', '<h1>你好</h1><p>这是一封测试邮件。</p>', env);
				console.log('[DEBUG] Test email sent successfully');
				
				return jsonResponse({ success: true, message: '邮件已发送' });
			} catch (e) {
				console.error('[DEBUG] Test email failed:', e);
				return handleError(e);
			}
		}

		// AUTH: Register
		if (url.pathname === '/api/register' && method === 'POST') {
			try {
				const body = await request.json() as any;

				// Turnstile Check
				const ip = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
				if (!(await checkTurnstile(body, ip))) {
					return jsonResponse({ error: 'Turnstile verification failed' }, 403);
				}

				const { email, username, password } = body;
				if (!email || !username || !password) {
					return jsonResponse({ error: 'Missing email, username or password' }, 400);
				}

				if (email.length > 50) return jsonResponse({ error: 'Email too long (Max 50 chars)' }, 400);

				if (username.length > 20) return jsonResponse({ error: 'Username too long (Max 20 chars)' }, 400);
				if (isVisuallyEmpty(username)) return jsonResponse({ error: 'Username cannot be empty' }, 400);
				if (hasInvisibleCharacters(username)) return jsonResponse({ error: 'Username contains invalid invisible characters' }, 400);
				if (hasControlCharacters(username)) return jsonResponse({ error: 'Username contains invalid control characters' }, 400);
				if (hasRestrictedKeywords(username)) return jsonResponse({ error: 'Username contains restricted keywords' }, 400);
				{
					const modErr = await assertContentModeration(env.cforum_db, username);
					if (modErr) return jsonResponse({ error: modErr }, 400);
				}

				if (password.length < 8 || password.length > 16) return jsonResponse({ error: 'Password must be 8-16 characters' }, 400);

				// Check Uniqueness (Combined Query for Performance)
				const existing = await env.cforum_db.prepare('SELECT email, username FROM users WHERE email = ? OR username = ?').bind(email, username).first();
				if (existing) {
					if (existing.email === email) return jsonResponse({ error: 'Email already exists' }, 409);
					return jsonResponse({ error: 'Username already taken' }, 409);
				}

				const passwordHash = await hashPassword(password);
				const verificationToken = generateToken();

				// Pre-check email deliverability (Send a test email first)
				// Note: We don't insert user yet. If email fails, we abort.
				const baseUrl = getBaseUrl();
				const verifyLink = `${baseUrl}/api/verify?token=${verificationToken}`;
				
				const emailHtml = `
					<h1>欢迎加入社区，${username}！</h1>
					<p>请点击下方链接验证您的邮箱地址：</p>
					<a href="${verifyLink}">验证邮箱</a>
					<p>如果您未请求此操作，请忽略此邮件。</p>
				`;

				try {
					await sendEmail(email, '请验证您的邮箱', emailHtml, env);
				} catch (e) {
					console.error('[Registration Email Error]', e);
					const errorMsg = e instanceof Error ? e.message : '未知错误';
					return jsonResponse({ 
						error: `验证邮件发送失败: ${errorMsg}`,
						details: '请检查邮箱地址或联系管理员检查 SMTP 配置'
					}, 400);
				}

				const { success, meta } = await env.cforum_db.prepare(
					'INSERT INTO users (email, username, password, role, verified, verification_token) VALUES (?, ?, ?, "user", 0, ?)'
				).bind(email, username, passwordHash, verificationToken).run();

				if (success) {
					const userId = meta?.last_row_id;
					if (userId) {
						try {
							const avatar = await createDefaultAvatarUrl(userId);
							await env.cforum_db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(avatar, userId).run();
						} catch (avatarErr) {
							console.error('Failed to create default avatar on register', avatarErr);
						}
					} else {
						try {
							const row = await env.cforum_db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: number }>();
							if (row?.id) {
								const avatar = await createDefaultAvatarUrl(row.id, username);
								await env.cforum_db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(avatar, row.id).run();
							}
						} catch (avatarErr) {
							console.error('Failed to create default avatar on register fallback', avatarErr);
						}
					}
				}

				return jsonResponse({ success, message: '注册成功，请前往邮箱完成验证。' }, 201);
			} catch (e: any) {
				if (e.message && e.message.includes('UNIQUE constraint failed')) {
					return jsonResponse({ error: 'Email already exists' }, 409);
				}
				return handleError(e);
			}
		}

		// AUTH: Verify Email
		if (url.pathname === '/api/verify' && method === 'GET') {
			const token = url.searchParams.get('token');
			if (!token) {
				return new Response('缺少 token', { status: 400 });
			}

			try {
				const { success } = await env.cforum_db.prepare(
					'UPDATE users SET verified = 1, verification_token = NULL WHERE verification_token = ?'
				).bind(token).run();

				if (success) {
					// Redirect to home page with verified param
					return Response.redirect(`${getBaseUrl()}/?verified=true`, 302);
				} else {
					return new Response('token 无效或已过期', { status: 400 });
				}
			} catch (e) {
				return new Response('验证失败', { status: 500 });
			}
		}

		// GET /users
		if (url.pathname === '/api/users' && method === 'GET') {
			try {
				const { results } = await env.cforum_db.prepare(
					'SELECT id, email, username, created_at FROM users'
				).all();
				return jsonResponse(results);
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/user/likes (Get all post IDs liked by user)
		if (url.pathname === '/api/user/likes' && method === 'GET') {
			try {
				const userPayload = await authenticate(request);
				const { results } = await env.cforum_db.prepare('SELECT post_id FROM likes WHERE user_id = ?').bind(userPayload.id).all();
				return jsonResponse(results.map((r: any) => r.post_id));
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /posts
		if (url.pathname === '/api/posts' && method === 'GET') {
			try {
				const viewer = await tryAuthenticate(request);
				const isAdmin = viewer?.role === 'admin';
				const limit = parseInt(url.searchParams.get('limit') || '20');
				const offset = parseInt(url.searchParams.get('offset') || '0');
				const categoryId = url.searchParams.get('category_id');
				const siteFeaturedOnly =
					url.searchParams.get('site_featured') === '1' ||
					url.searchParams.get('site_featured') === 'true';
				const mineOnly =
					url.searchParams.get('mine') === '1' || url.searchParams.get('mine') === 'true';
				const q = (url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
				const sortByRaw = (url.searchParams.get('sort_by') || 'time').trim().toLowerCase();
				const sortDirRaw = (url.searchParams.get('sort_dir') || 'desc').trim().toLowerCase();
				const sortDir = sortDirRaw === 'asc' ? 'ASC' : 'DESC';
				
				const statusFilter = (url.searchParams.get('status') || '').trim();
				const unrepliedOnly =
					url.searchParams.get('unreplied') === '1' || url.searchParams.get('unreplied') === 'true';

				let query = `SELECT 
                        posts.id, posts.author_id, posts.title, posts.content, posts.category_id,
                        posts.is_pinned, posts.is_visible, posts.author_publish_until, posts.site_featured,
                        posts.status, posts.view_count, posts.created_at,
                        users.username as author_name, 
                        users.avatar_url as author_avatar,
                        users.role as author_role,
                        categories.name as category_name,
                        IFNULL(categories.status_options, '[]') as category_status_options,
                        IFNULL(categories.author_can_set_status, 0) as category_author_can_set_status,
                        IFNULL(like_agg.like_count, 0) as like_count,
                        IFNULL(comment_agg.comment_count, 0) as comment_count
                     FROM posts 
                     JOIN users ON posts.author_id = users.id 
                     LEFT JOIN categories ON posts.category_id = categories.id
                     LEFT JOIN (
                        SELECT post_id, COUNT(*) AS like_count FROM likes GROUP BY post_id
                     ) like_agg ON like_agg.post_id = posts.id
                     LEFT JOIN (
                        SELECT post_id, COUNT(*) AS comment_count FROM comments GROUP BY post_id
                     ) comment_agg ON comment_agg.post_id = posts.id`;
                
                let countQuery = `SELECT COUNT(*) as total FROM posts
					LEFT JOIN categories ON posts.category_id = categories.id
					LEFT JOIN (
                        SELECT post_id, COUNT(*) AS comment_count FROM comments GROUP BY post_id
                     ) comment_agg ON comment_agg.post_id = posts.id`;

                const params: any[] = [];
                const countParams: any[] = [];
				const conditions: string[] = [];

                if (categoryId) {
					conditions.push(`posts.category_id = ?`);
					params.push(categoryId);
					countParams.push(categoryId);
					// Non-admins cannot open forum-hidden categories via API
					if (!isAdmin) {
						conditions.push(`IFNULL(categories.show_on_forum, 1) = 1`);
					}
                } else if (!isAdmin) {
					// Hide forum-hidden category posts from the default feed (admins see all)
					conditions.push(`IFNULL(categories.show_on_forum, 1) = 1`);
				}

				if (siteFeaturedOnly) {
					conditions.push(`IFNULL(posts.site_featured, 0) = 1`);
				}

				if (unrepliedOnly) {
					conditions.push(`IFNULL(comment_agg.comment_count, 0) = 0`);
				}

				if (statusFilter && categoryId) {
					conditions.push(`posts.status = ?`);
					params.push(statusFilter);
					countParams.push(statusFilter);
				}

				if (mineOnly) {
					if (!viewer) {
						return jsonResponse({ error: 'Login required' }, 401);
					}
					conditions.push(`posts.author_id = ?`);
					params.push(viewer.id);
					countParams.push(viewer.id);
				}

				// Visibility: guests see public only; authors see own hidden; admins see all
				if (isAdmin) {
					// no visibility filter
				} else if (viewer) {
					conditions.push(`(IFNULL(posts.is_visible, 1) = 1 OR posts.author_id = ?)`);
					params.push(viewer.id);
					countParams.push(viewer.id);
				} else {
					conditions.push(`IFNULL(posts.is_visible, 1) = 1`);
				}

				if (q) {
					conditions.push(`(posts.title LIKE ? OR posts.content LIKE ?)`);
					const like = `%${q}%`;
					params.push(like, like);
					countParams.push(like, like);
				}

				if (conditions.length) {
					query += ` WHERE ${conditions.join(' AND ')}`;
					countQuery += ` WHERE ${conditions.join(' AND ')}`;
				}

				const sortExpr =
					sortByRaw === 'likes'
						? `like_count ${sortDir}`
						: sortByRaw === 'comments'
							? `comment_count ${sortDir}`
							: sortByRaw === 'views'
								? `posts.view_count ${sortDir}`
								: `posts.created_at ${sortDir}`;

                query += ` ORDER BY is_pinned DESC, ${sortExpr}, posts.created_at DESC LIMIT ? OFFSET ?`;
                params.push(limit, offset);
				
				const [postsResult, countResult] = await Promise.all([
                    env.cforum_db.prepare(query).bind(...params).all(),
                    env.cforum_db.prepare(countQuery).bind(...countParams).first()
                ]);

				return jsonResponse({
					posts: (postsResult.results || []).map((row: any) => ({
						...row,
						status: row.status || null,
						category_status_options: parseStatusOptions(row.category_status_options),
						category_author_can_set_status: Number(row.category_author_can_set_status) === 1
					})),
					total: countResult ? countResult.total : 0
				});
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/posts/:id
		if (url.pathname.match(/^\/api\/posts\/\d+$/) && method === 'GET') {
			const postId = url.pathname.split('/')[3];
			try {
				const viewer = await tryAuthenticate(request);
				const isAdmin = viewer?.role === 'admin';
				const post = await env.cforum_db.prepare(
					`SELECT 
                        posts.id, posts.author_id, posts.title, posts.content, posts.category_id,
                        posts.is_pinned, posts.is_visible, posts.author_publish_until, posts.site_featured,
                        posts.status, posts.cited_post_id, posts.view_count, posts.created_at,
                        users.username as author_name, 
                        users.avatar_url as author_avatar,
                        users.role as author_role,
                        categories.name as category_name,
						IFNULL(categories.show_on_forum, 1) AS category_show_on_forum,
						IFNULL(categories.status_options, '[]') AS category_status_options,
						IFNULL(categories.author_can_set_status, 0) AS category_author_can_set_status,
						IFNULL(categories.enable_cite, 0) AS category_enable_cite,
						IFNULL(categories.enable_cited_from, 0) AS category_enable_cited_from,
						IFNULL(categories.enable_relate, 0) AS category_enable_relate,
                        (SELECT COUNT(*) FROM likes WHERE likes.post_id = posts.id) as like_count,
                        (SELECT COUNT(*) FROM comments WHERE comments.post_id = posts.id) as comment_count
                     FROM posts 
                     JOIN users ON posts.author_id = users.id 
                     LEFT JOIN categories ON posts.category_id = categories.id
                     WHERE posts.id = ?`
				).bind(postId).first();
				
				if (!post) return jsonResponse({ error: 'Post not found' }, 404);

				const visible = Number((post as any).is_visible ?? 1) === 1;
				const forumShown = Number((post as any).category_show_on_forum ?? 1) === 1;
				const isAuthor = !!viewer && Number((post as any).author_id) === viewer.id;
				if (!isAdmin) {
					if (!forumShown && (post as any).category_id != null) {
						return jsonResponse({ error: 'Post not found' }, 404);
					}
					if (!visible && !isAuthor) {
						return jsonResponse({ error: 'Post not found' }, 404);
					}
				}

				try {
					await env.cforum_db.prepare('UPDATE posts SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?').bind(postId).run();
					(post as any).view_count = Number((post as any).view_count || 0) + 1;
				} catch {}
				
				// Check like status if user_id provided
				const userId = url.searchParams.get('user_id');
				if (userId) {
					const like = await env.cforum_db.prepare('SELECT id FROM likes WHERE post_id = ? AND user_id = ?').bind(postId, userId).first();
					(post as any).liked = !!like;
				}

				const enableRelate = Number((post as any).category_enable_relate) === 1;
				const enableCitedFrom = Number((post as any).category_enable_cited_from) === 1;
				const mapCard = (row: any) => ({ ...row, status: row.status || null });

				let cited_post: any = null;
				const citedId = (post as any).cited_post_id != null ? Number((post as any).cited_post_id) : null;
				if (citedId) {
					const cited = await env.cforum_db
						.prepare(
							`${RELATION_CARD_SQL}
							 WHERE posts.id = ? AND IFNULL(posts.is_visible, 1) = 1`
						)
						.bind(citedId)
						.first();
					if (cited) cited_post = mapCard(cited);
				}

				let cited_by_posts: any[] = [];
				if (enableCitedFrom) {
					const { results } = await env.cforum_db
						.prepare(
							`${RELATION_CARD_SQL}
							 WHERE posts.cited_post_id = ?
							   AND IFNULL(posts.is_visible, 1) = 1
							 ORDER BY posts.created_at DESC
							 LIMIT 200`
						)
						.bind(postId)
						.all();
					cited_by_posts = (results || []).map(mapCard);
				}

				let related_posts: any[] = [];
				if (enableRelate) {
					const { results } = await env.cforum_db
						.prepare(
							`${RELATION_CARD_SQL}
							 INNER JOIN post_relations_undirected pr
							   ON (pr.post_low_id = posts.id OR pr.post_high_id = posts.id)
							 WHERE (pr.post_low_id = ? OR pr.post_high_id = ?)
							   AND posts.id != ?
							   AND IFNULL(posts.is_visible, 1) = 1
							 ORDER BY pr.created_at DESC`
						)
						.bind(postId, postId, postId)
						.all();
					related_posts = (results || []).map(mapCard);
				}

				return jsonResponse({
					...post,
					cited_post_id: citedId,
					status: (post as any).status || null,
					category_status_options: parseStatusOptions((post as any).category_status_options),
					category_author_can_set_status: Number((post as any).category_author_can_set_status) === 1,
					category_enable_cite: Number((post as any).category_enable_cite) === 1,
					category_enable_cited_from: enableCitedFrom,
					category_enable_relate: enableRelate,
					cited_post,
					cited_by_posts,
					related_posts
				});
			} catch (e) {
				return handleError(e);
			}
		}

		// PUT /api/posts/:id/cite — admin only; set or clear single citation
		if (url.pathname.match(/^\/api\/posts\/\d+\/cite$/) && method === 'PUT') {
			const postId = Number(url.pathname.split('/')[3]);
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const body = (await request.json()) as any;
				const raw = body?.cited_post_id;
				const citedPostId =
					raw === null || raw === undefined || raw === ''
						? null
						: Number(raw);
				const post = await env.cforum_db
					.prepare(`SELECT id, category_id FROM posts WHERE id = ?`)
					.bind(postId)
					.first<{ id: number; category_id: number | null }>();
				if (!post) return jsonResponse({ error: 'Post not found' }, 404);
				if (post.category_id == null) return jsonResponse({ error: '帖子无分类' }, 400);
				const citeErr = await validateCitedPostId(env.cforum_db, {
					citedPostId,
					sourcePostId: postId,
					sourceCategoryId: Number(post.category_id)
				});
				if (citeErr) return jsonResponse({ error: citeErr }, 400);
				await env.cforum_db
					.prepare(`UPDATE posts SET cited_post_id = ? WHERE id = ?`)
					.bind(citedPostId, postId)
					.run();
				await security.logAudit(
					userPayload.id,
					'SET_POST_CITE',
					'post',
					String(postId),
					{ cited_post_id: citedPostId },
					request
				);
				return jsonResponse({ success: true, cited_post_id: citedPostId });
			} catch (e) {
				return handleError(e);
			}
		}

		// PUT /api/posts/:id/relations — admin only; replace undirected related neighbors
		if (url.pathname.match(/^\/api\/posts\/\d+\/relations$/) && method === 'PUT') {
			const postId = Number(url.pathname.split('/')[3]);
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);

				const source = await env.cforum_db
					.prepare(
						`SELECT posts.id, posts.category_id,
							IFNULL(categories.enable_relate, 0) AS enable_relate
						 FROM posts
						 LEFT JOIN categories ON posts.category_id = categories.id
						 WHERE posts.id = ?`
					)
					.bind(postId)
					.first<{ id: number; category_id: number | null; enable_relate: number }>();
				if (!source) return jsonResponse({ error: 'Post not found' }, 404);
				if (Number(source.enable_relate) !== 1) {
					return jsonResponse({ error: '该分类未启用关联' }, 400);
				}

				const body = (await request.json()) as any;
				const rawIds = Array.isArray(body?.related_ids) ? body.related_ids : [];
				const relatedIds = [
					...new Set(
						rawIds
							.map((x: any) => Number(x))
							.filter((n: number) => Number.isFinite(n) && n > 0 && n !== postId)
					)
				] as number[];

				if (relatedIds.length) {
					const placeholders = relatedIds.map(() => '?').join(',');
					const { results: targets } = await env.cforum_db
						.prepare(
							`SELECT posts.id,
								IFNULL(categories.enable_relate, 0) AS enable_relate,
								IFNULL(posts.is_visible, 1) AS is_visible
							 FROM posts
							 LEFT JOIN categories ON posts.category_id = categories.id
							 WHERE posts.id IN (${placeholders})`
						)
						.bind(...relatedIds)
						.all<{ id: number; enable_relate: number; is_visible: number }>();
					const byId = new Map((targets || []).map((t) => [Number(t.id), t]));
					for (const id of relatedIds) {
						const t = byId.get(id);
						if (!t) return jsonResponse({ error: `目标帖不存在: ${id}` }, 400);
						if (Number(t.is_visible) !== 1) return jsonResponse({ error: `目标帖不可见: ${id}` }, 400);
						if (Number(t.enable_relate) !== 1) {
							return jsonResponse({ error: `目标帖分类未启用关联: ${id}` }, 400);
						}
					}
				}

				await env.cforum_db
					.prepare(
						`DELETE FROM post_relations_undirected WHERE post_low_id = ? OR post_high_id = ?`
					)
					.bind(postId, postId)
					.run();
				if (relatedIds.length) {
					const insert = env.cforum_db.prepare(
						`INSERT OR IGNORE INTO post_relations_undirected (post_low_id, post_high_id, created_by)
						 VALUES (?, ?, ?)`
					);
					await env.cforum_db.batch(
						relatedIds.map((otherId) => {
							const low = Math.min(postId, otherId);
							const high = Math.max(postId, otherId);
							return insert.bind(low, high, userPayload.id);
						})
					);
				}
				await security.logAudit(
					userPayload.id,
					'SET_POST_RELATIONS',
					'post',
					String(postId),
					{ related_ids: relatedIds },
					request
				);
				return jsonResponse({ success: true, related_ids: relatedIds });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/posts/:id/status — admin, or author when category.author_can_set_status
		if (url.pathname.match(/^\/api\/posts\/\d+\/status$/) && method === 'POST') {
			const postId = url.pathname.split('/')[3];
			try {
				const userPayload = await authenticate(request);
				const body = (await request.json()) as any;
				const nextStatus = String(body?.status || '').trim();
				const post = await env.cforum_db
					.prepare(
						`SELECT posts.id, posts.title, posts.status, posts.author_id, posts.category_id,
							IFNULL(categories.status_options, '[]') AS status_options,
							IFNULL(categories.author_can_set_status, 0) AS author_can_set_status,
							categories.name AS category_name,
							users.email AS author_email,
							IFNULL(users.email_notifications, 1) AS author_email_notifications
						 FROM posts
						 LEFT JOIN categories ON posts.category_id = categories.id
						 LEFT JOIN users ON posts.author_id = users.id
						 WHERE posts.id = ?`
					)
					.bind(postId)
					.first<{
						id: number;
						title: string;
						status: string | null;
						author_id: number;
						category_id: number | null;
						status_options: string;
						author_can_set_status: number;
						category_name: string | null;
						author_email: string | null;
						author_email_notifications: number;
					}>();
				if (!post) return jsonResponse({ error: 'Post not found' }, 404);
				const options = parseStatusOptions(post.status_options);
				if (!options.length) return jsonResponse({ error: '该分类未启用帖子状态' }, 400);
				if (!isValidStatusForOptions(nextStatus, options)) {
					return jsonResponse({ error: '状态无效' }, 400);
				}
				const isAdmin = userPayload.role === 'admin';
				const isAuthor = post.author_id === userPayload.id;
				const authorAllowed = Number(post.author_can_set_status) === 1;
				if (!isAdmin && !(isAuthor && authorAllowed)) {
					return jsonResponse({ error: '无权修改状态' }, 403);
				}
				const prevStatus = String(post.status || '').trim();
				if (prevStatus === nextStatus) {
					return jsonResponse({ success: true, status: nextStatus });
				}
				await env.cforum_db.prepare('UPDATE posts SET status = ? WHERE id = ?').bind(nextStatus, postId).run();
				await security.logAudit(
					userPayload.id,
					'SET_POST_STATUS',
					'post',
					postId,
					{ status: nextStatus, prev_status: prevStatus },
					request
				);

				// Progress feedback email: other user changed status + dual switches
				if (!isAuthor && post.author_email && Number(post.author_email_notifications) === 1) {
					const notifyRow = await env.cforum_db
						.prepare("SELECT value FROM settings WHERE key = 'notify_on_post_status_change'")
						.first<DBSetting>();
					const notifyEnabled = !notifyRow || notifyRow.value === '1';
					if (notifyEnabled) {
						const postUrl = `${getBaseUrl()}/post?id=${post.id}`;
						const catLabel = post.category_name ? String(post.category_name) : '未分类';
						const oldLabel = prevStatus || '（无）';
						const safeTitle = String(post.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
						const emailHtml = `
							<h1>帖子进度已更新</h1>
							<p>您的帖子 <strong>${safeTitle}</strong>（${catLabel}）状态已更新。</p>
							<p><strong>${oldLabel}</strong> → <strong>${nextStatus}</strong></p>
							<p><a href="${postUrl}">查看帖子</a></p>
						`;
						ctx.waitUntil(
							sendEmail(
								post.author_email,
								`您的帖子进度已更新：${String(post.title || '').slice(0, 40)}`,
								emailHtml,
								env
							).catch(console.error)
						);
					}
				}

				return jsonResponse({ success: true, status: nextStatus });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/posts/:id/visibility — author: hide anytime; first-publish within author_publish_until; admin: hide/show
		if (url.pathname.match(/^\/api\/posts\/\d+\/visibility$/) && method === 'POST') {
			const postId = url.pathname.split('/')[3];
			try {
				const userPayload = await authenticate(request);
				const body = (await request.json()) as any;
				const visible = !(body?.visible === false || body?.visible === 0);
				const post = await env.cforum_db
					.prepare(
						`SELECT id, author_id,
							IFNULL(site_featured, 0) AS site_featured,
							IFNULL(is_visible, 1) AS is_visible,
							author_publish_until
						 FROM posts WHERE id = ?`
					)
					.bind(postId)
					.first<{
						id: number;
						author_id: number;
						site_featured: number;
						is_visible: number;
						author_publish_until: string | null;
					}>();
				if (!post) return jsonResponse({ error: 'Post not found' }, 404);
				const isAdmin = userPayload.role === 'admin';
				const isAuthor = post.author_id === userPayload.id;
				if (!isAdmin && !isAuthor) {
					return jsonResponse({ error: 'Unauthorized' }, 403);
				}
				if (!isAdmin) {
					if (visible) {
						const untilRaw = post.author_publish_until;
						if (!untilRaw) {
							return jsonResponse({ error: '隐藏后不可再设为可见，请联系管理员' }, 403);
						}
						const untilMs = Date.parse(
							String(untilRaw).endsWith('Z') ? String(untilRaw) : `${untilRaw}Z`
						);
						if (Number.isNaN(untilMs) || Date.now() > untilMs) {
							return jsonResponse(
								{ error: '超过 15 分钟未设为可见，已失去设为可见权限，请联系管理员' },
								403
							);
						}
					} else if (Number(post.site_featured) === 1) {
						return jsonResponse({ error: '官网精选帖不可由作者隐藏' }, 403);
					}
				}
				await env.cforum_db
					.prepare(
						visible
							? 'UPDATE posts SET is_visible = 1, author_publish_until = NULL WHERE id = ?'
							: 'UPDATE posts SET is_visible = 0 WHERE id = ?'
					)
					.bind(postId)
					.run();
				await security.logAudit(
					userPayload.id,
					'TOGGLE_POST_VISIBILITY',
					'post',
					postId,
					{ visible },
					request
				);
				return jsonResponse({
					success: true,
					is_visible: visible ? 1 : 0,
					author_publish_until: visible ? null : post.author_publish_until
				});
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/posts/:id/site-feature — admin only 官网精选
		if (url.pathname.match(/^\/api\/admin\/posts\/\d+\/site-feature$/) && method === 'POST') {
			const postId = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const body = (await request.json()) as any;
				const featured = !(body?.featured === false || body?.featured === 0);
				const post = await env.cforum_db
					.prepare(
						`SELECT posts.id, posts.title, posts.author_id,
							IFNULL(posts.site_featured, 0) AS site_featured,
							users.email AS author_email,
							IFNULL(users.email_notifications, 1) AS author_email_notifications
						 FROM posts
						 LEFT JOIN users ON posts.author_id = users.id
						 WHERE posts.id = ?`
					)
					.bind(postId)
					.first<{
						id: number;
						title: string;
						author_id: number;
						site_featured: number;
						author_email: string | null;
						author_email_notifications: number;
					}>();
				if (!post) return jsonResponse({ error: 'Post not found' }, 404);
				const prevFeatured = Number(post.site_featured) === 1;
				if (prevFeatured === featured) {
					return jsonResponse({ success: true, site_featured: featured ? 1 : 0 });
				}
				await env.cforum_db
					.prepare('UPDATE posts SET site_featured = ? WHERE id = ?')
					.bind(featured ? 1 : 0, postId)
					.run();
				await security.logAudit(
					userPayload.id,
					'ADMIN_SITE_FEATURE_POST',
					'post',
					postId,
					{ featured },
					request
				);

				const isAuthor = post.author_id === userPayload.id;
				if (!isAuthor && post.author_email && Number(post.author_email_notifications) === 1) {
					const notifyRow = await env.cforum_db
						.prepare("SELECT value FROM settings WHERE key = 'notify_on_site_feature'")
						.first<DBSetting>();
					const notifyEnabled = !notifyRow || notifyRow.value === '1';
					if (notifyEnabled) {
						const postUrl = `${getBaseUrl()}/post?id=${post.id}`;
						const safeTitle = String(post.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
						const emailHtml = featured
							? `
								<h1>帖子已设为官网精选</h1>
								<p>您的帖子 <strong>${safeTitle}</strong> 已被选入官网精选。</p>
								<p><a href="${postUrl}">查看帖子</a></p>
							`
							: `
								<h1>帖子已取消官网精选</h1>
								<p>您的帖子 <strong>${safeTitle}</strong> 已取消官网精选。</p>
								<p><a href="${postUrl}">查看帖子</a></p>
							`;
						const subject = featured
							? `您的帖子已设为官网精选：${String(post.title || '').slice(0, 40)}`
							: `您的帖子已取消官网精选：${String(post.title || '').slice(0, 40)}`;
						ctx.waitUntil(sendEmail(post.author_email, subject, emailHtml, env).catch(console.error));
					}
				}

				return jsonResponse({ success: true, site_featured: featured ? 1 : 0 });
			} catch (e) {
				return handleError(e);
			}
		}

		// PUT /api/posts/:id
		if (url.pathname.match(/^\/api\/posts\/\d+$/) && method === 'PUT') {
			const postId = url.pathname.split('/')[3];
			try {
				const userPayload = await authenticate(request);
				const body = await request.json() as any;
				const { title, content, category_id } = body; // user_id not needed from body

				if (!title || !content) {
					return jsonResponse({ error: 'Missing parameters' }, 400);
				}

				if (isVisuallyEmpty(title) || isVisuallyEmpty(content)) return jsonResponse({ error: 'Title or content cannot be empty' }, 400);

				if (hasInvisibleCharacters(title) || hasInvisibleCharacters(content)) return jsonResponse({ error: 'Title or content contains invalid invisible characters' }, 400);

				// Check ownership or admin
				const post = await env.cforum_db
					.prepare(
						'SELECT author_id, IFNULL(is_visible, 1) AS is_visible, cited_post_id FROM posts WHERE id = ?'
					)
					.bind(postId)
					.first<any>();
				if (!post) return jsonResponse({ error: 'Post not found' }, 404);

				const isAdmin = userPayload.role === 'admin';
				// Use userPayload for RBAC
				if (post.author_id !== userPayload.id && !isAdmin) {
					return jsonResponse({ error: 'Unauthorized' }, 403);
				}
				// 可见帖作者不可再编辑（管理员可）
				if (!isAdmin && Number(post.is_visible) === 1) {
					return jsonResponse({ error: '可见帖不可再编辑，可隐藏或联系管理员' }, 403);
				}
				if (!category_id) {
					return jsonResponse({ error: '请选择分类' }, 400);
				}

				// Validate Lengths
				if (title.length > 30) return jsonResponse({ error: 'Title too long (Max 30 chars)' }, 400);
				if (content.length > 3000) return jsonResponse({ error: 'Content too long (Max 3000 chars)' }, 400);
				if (hasControlCharacters(title) || hasControlCharacters(content)) return jsonResponse({ error: 'Title or content contains invalid control characters' }, 400);

				const gate = await assertNotInCooldown(env.cforum_db, userPayload);
				if (!gate.ok) return jsonResponse({ error: gate.error }, gate.status);

				const moderationErr = await assertContentModeration(env.cforum_db, `${title}\n${content}`, {
					skip: userPayload.role === 'admin'
				});
				if (moderationErr) {
					if (userPayload.role !== 'admin') {
						const hit = await recordModerationReject(env.cforum_db, {
							userId: userPayload.id,
							reason: moderationErr,
							path: 'edit',
							ip: request.headers.get('CF-Connecting-IP') || 'unknown'
						});
						const suffix = hit.cooldownUntil ? '；已进入发言冷却' : '';
						return jsonResponse({ error: moderationErr + suffix }, 400);
					}
					return jsonResponse({ error: moderationErr }, 400);
				}

				// Validate Category + announcement restriction
				const category = await env.cforum_db
					.prepare('SELECT id, admin_only FROM categories WHERE id = ?')
					.bind(category_id)
					.first<any>();
				if (!category) return jsonResponse({ error: 'Category not found' }, 400);
				if (category.admin_only && userPayload.role !== 'admin') {
					return jsonResponse({ error: '该分类仅管理员可发帖' }, 403);
				}

				let nextCitedId =
					post.cited_post_id != null ? Number(post.cited_post_id) : null;
				if (isAdmin && Object.prototype.hasOwnProperty.call(body, 'cited_post_id')) {
					const raw = body.cited_post_id;
					nextCitedId =
						raw === null || raw === undefined || raw === ''
							? null
							: Number(raw);
					const citeErr = await validateCitedPostId(env.cforum_db, {
						citedPostId: nextCitedId,
						sourcePostId: Number(postId),
						sourceCategoryId: Number(category_id)
					});
					if (citeErr) return jsonResponse({ error: citeErr }, 400);
				}

				await env.cforum_db
					.prepare(
						'UPDATE posts SET title = ?, content = ?, category_id = ?, cited_post_id = ? WHERE id = ?'
					)
					.bind(title.trim(), content.trim(), category_id, nextCitedId, postId)
					.run();
				
				await security.logAudit(userPayload.id, 'UPDATE_POST', 'post', postId, {
					title_length: title.length,
					cited_post_id: nextCitedId
				}, request);

				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// DELETE /api/posts/:id (User delete own post)
		if (url.pathname.match(/^\/api\/posts\/\d+$/) && method === 'DELETE') {
			const id = url.pathname.split('/')[3];
			try {
				const userPayload = await authenticate(request);
				
				// Check ownership
				const post = await env.cforum_db
					.prepare(
						'SELECT author_id, content, IFNULL(site_featured, 0) AS site_featured FROM posts WHERE id = ?'
					)
					.bind(id)
					.first<any>();
				if (!post) return jsonResponse({ error: 'Post not found' }, 404);
				
				if (post.author_id !== userPayload.id) {
					return jsonResponse({ error: 'Unauthorized' }, 403);
				}
				if (Number(post.site_featured) === 1) {
					return jsonResponse({ error: '官网精选帖不可由作者删除' }, 403);
				}

				// Delete images in post
				const imageUrls = extractImageUrls(post.content as string);
				if (imageUrls.length > 0) {
					ctx.waitUntil(Promise.all(imageUrls.map(url => deleteImage(env as unknown as S3Env, url, userPayload.id))).catch(err => console.error('Failed to delete post images', err)));
				}

				await env.cforum_db.prepare('DELETE FROM likes WHERE post_id = ?').bind(id).run();
				await env.cforum_db.prepare('DELETE FROM comments WHERE post_id = ?').bind(id).run();
				await env.cforum_db.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
				
				await security.logAudit(userPayload.id, 'DELETE_POST', 'post', id, {}, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// GET /api/posts/:id/comments （一级精选优先）
		if (url.pathname.match(/^\/api\/posts\/\d+\/comments$/) && method === 'GET') {
			const postId = url.pathname.split('/')[3];
			try {
				const { results } = await env.cforum_db.prepare(
					`SELECT
						comments.id,
						comments.post_id,
						comments.parent_id,
						comments.author_id,
						comments.content,
						comments.is_featured,
						comments.created_at,
						users.username,
						users.avatar_url,
						users.role
                     FROM comments 
                     JOIN users ON comments.author_id = users.id 
                     WHERE comments.post_id = ? 
                     ORDER BY
                       CASE WHEN comments.parent_id IS NULL AND IFNULL(comments.is_featured, 0) = 1 THEN 0 ELSE 1 END ASC,
                       comments.created_at ASC`
				).bind(postId).all();
				return jsonResponse(results || []);
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/posts/:id/comments
		if (url.pathname.match(/^\/api\/posts\/\d+\/comments$/) && method === 'POST') {
			const postId = url.pathname.split('/')[3];
			try {
				const userPayload = await authenticate(request);
				const body = (await request.json()) as any;

				const ip = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
				if (!(await checkTurnstile(body, ip))) {
					return jsonResponse({ error: 'Turnstile verification failed' }, 403);
				}

				let content = String(body?.content || '');
				const parentId = body?.parent_id == null || body?.parent_id === '' ? null : Number(body.parent_id);

				if (!content) return jsonResponse({ error: 'Missing content' }, 400);
				if (isVisuallyEmpty(content)) return jsonResponse({ error: 'Content cannot be empty' }, 400);
				if (hasInvisibleCharacters(content)) return jsonResponse({ error: 'Content contains invalid invisible characters' }, 400);
				if (content.length > 3000) return jsonResponse({ error: 'Content too long (Max 3000 chars)' }, 400);
				if (hasControlCharacters(content)) return jsonResponse({ error: 'Content contains invalid control characters' }, 400);

				const gate = await assertPublishAllowed(env.cforum_db, userPayload, 'comment');
				if (!gate.ok) return jsonResponse({ error: gate.error }, gate.status);

				const moderationErr = await assertContentModeration(env.cforum_db, content, {
					skip: userPayload.role === 'admin'
				});
				if (moderationErr) {
					if (userPayload.role !== 'admin') {
						const hit = await recordModerationReject(env.cforum_db, {
							userId: userPayload.id,
							reason: moderationErr,
							path: 'comment',
							ip: request.headers.get('CF-Connecting-IP') || 'unknown'
						});
						const suffix = hit.cooldownUntil ? '；已进入发言冷却' : '';
						return jsonResponse({ error: moderationErr + suffix }, 400);
					}
					return jsonResponse({ error: moderationErr }, 400);
				}

				const post = await env.cforum_db.prepare('SELECT id FROM posts WHERE id = ?').bind(postId).first();
				if (!post) return jsonResponse({ error: 'Post not found' }, 404);

				if (parentId != null) {
					if (!Number.isFinite(parentId)) return jsonResponse({ error: 'Invalid parent comment' }, 400);
					const parent = await env.cforum_db
						.prepare('SELECT id, post_id FROM comments WHERE id = ?')
						.bind(parentId)
						.first<any>();
					if (!parent || String(parent.post_id) !== String(postId)) {
						return jsonResponse({ error: 'Parent comment not found' }, 400);
					}
				}

				content = content
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/"/g, '&quot;')
					.replace(/'/g, '&#039;');

				const { success, meta } = await env.cforum_db
					.prepare('INSERT INTO comments (post_id, parent_id, author_id, content) VALUES (?, ?, ?, ?)')
					.bind(postId, parentId, userPayload.id, content.trim())
					.run();

				await security.logAudit(
					userPayload.id,
					'CREATE_COMMENT',
					'comment',
					String(meta?.last_row_id || 'new'),
					{ post_id: Number(postId), parent_id: parentId },
					request
				);

				return jsonResponse({ success, id: meta?.last_row_id ?? null }, 201);
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/admin/comments/:id/feature — admin only, 仅一级评论
		if (url.pathname.match(/^\/api\/admin\/comments\/\d+\/feature$/) && method === 'POST') {
			const id = url.pathname.split('/')[4];
			try {
				const userPayload = await authenticate(request);
				if (userPayload.role !== 'admin') return jsonResponse({ error: 'Unauthorized' }, 403);
				const body = (await request.json()) as any;
				const featured = !(body?.featured === false || body?.featured === 0);
				const comment = await env.cforum_db
					.prepare(
						`SELECT comments.id, comments.parent_id, comments.author_id, comments.post_id,
							IFNULL(comments.is_featured, 0) AS is_featured,
							posts.title AS post_title,
							users.email AS author_email,
							IFNULL(users.email_notifications, 1) AS author_email_notifications
						 FROM comments
						 LEFT JOIN posts ON comments.post_id = posts.id
						 LEFT JOIN users ON comments.author_id = users.id
						 WHERE comments.id = ?`
					)
					.bind(id)
					.first<{
						id: number;
						parent_id: number | null;
						author_id: number;
						post_id: number;
						is_featured: number;
						post_title: string | null;
						author_email: string | null;
						author_email_notifications: number;
					}>();
				if (!comment) return jsonResponse({ error: 'Comment not found' }, 404);
				if (comment.parent_id != null) {
					return jsonResponse({ error: '仅一级评论可精选' }, 400);
				}
				const prevFeatured = Number(comment.is_featured) === 1;
				if (prevFeatured === featured) {
					return jsonResponse({ success: true, is_featured: featured ? 1 : 0 });
				}
				await env.cforum_db
					.prepare('UPDATE comments SET is_featured = ? WHERE id = ?')
					.bind(featured ? 1 : 0, id)
					.run();
				await security.logAudit(
					userPayload.id,
					'ADMIN_FEATURE_COMMENT',
					'comment',
					id,
					{ featured },
					request
				);

				const isAuthor = comment.author_id === userPayload.id;
				if (!isAuthor && comment.author_email && Number(comment.author_email_notifications) === 1) {
					const notifyRow = await env.cforum_db
						.prepare("SELECT value FROM settings WHERE key = 'notify_on_site_feature'")
						.first<DBSetting>();
					const notifyEnabled = !notifyRow || notifyRow.value === '1';
					if (notifyEnabled) {
						const postUrl = `${getBaseUrl()}/post?id=${comment.post_id}`;
						const safeTitle = String(comment.post_title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
						const emailHtml = featured
							? `
								<h1>评论已设为官网精选</h1>
								<p>您在帖子 <strong>${safeTitle}</strong> 下的评论已被选入官网精选。</p>
								<p><a href="${postUrl}">查看帖子</a></p>
							`
							: `
								<h1>评论已取消官网精选</h1>
								<p>您在帖子 <strong>${safeTitle}</strong> 下的评论已取消官网精选。</p>
								<p><a href="${postUrl}">查看帖子</a></p>
							`;
						const subject = featured
							? `您的评论已设为官网精选：${String(comment.post_title || '').slice(0, 40)}`
							: `您的评论已取消官网精选：${String(comment.post_title || '').slice(0, 40)}`;
						ctx.waitUntil(
							sendEmail(comment.author_email, subject, emailHtml, env).catch(console.error)
						);
					}
				}

				return jsonResponse({ success: true, is_featured: featured ? 1 : 0 });
			} catch (e) {
				return handleError(e);
			}
		}

		// DELETE /api/comments/:id
		if (url.pathname.match(/^\/api\/comments\/\d+$/) && method === 'DELETE') {
			const id = url.pathname.split('/').pop();
			try {
				const userPayload = await authenticate(request);
				
				// Fetch comment to check ownership
				const comment = await env.cforum_db.prepare('SELECT author_id FROM comments WHERE id = ?').bind(id).first();
				
				if (!comment) return jsonResponse({ error: 'Comment not found' }, 404);

				// Allow deletion if user is author OR admin
				if (comment.author_id !== userPayload.id && userPayload.role !== 'admin') {
					return jsonResponse({ error: 'Unauthorized' }, 403);
				}

				// Delete the comment AND its children (orphans prevention)
				await env.cforum_db.prepare('DELETE FROM comments WHERE parent_id = ?').bind(id).run();
				await env.cforum_db.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
				
				await security.logAudit(userPayload.id, 'DELETE_COMMENT', 'comment', String(id), {}, request);
				return jsonResponse({ success: true });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /api/posts/:id/like
		if (url.pathname.match(/^\/api\/posts\/\d+\/like$/) && method === 'POST') {
			const postId = url.pathname.split('/')[3];
			try {
				const userPayload = await authenticate(request);
				const userId = userPayload.id;

				// Toggle like
				const existing = await env.cforum_db.prepare(
					'SELECT id FROM likes WHERE post_id = ? AND user_id = ?'
				).bind(postId, userId).first();

				if (existing) {
					await env.cforum_db.prepare('DELETE FROM likes WHERE id = ?').bind(existing.id).run();
					return jsonResponse({ liked: false });
				} else {
					await env.cforum_db.prepare('INSERT INTO likes (post_id, user_id) VALUES (?, ?)').bind(postId, userId).run();
					return jsonResponse({ liked: true });
				}
			} catch (e) {
				return handleError(e);
			}
		}
		
		// GET /api/posts/:id/like-status
		if (url.pathname.match(/^\/api\/posts\/\d+\/like-status$/) && method === 'GET') {
			const postId = url.pathname.split('/')[3];
			
			try {
				const userPayload = await authenticate(request);
				const existing = await env.cforum_db.prepare(
					'SELECT id FROM likes WHERE post_id = ? AND user_id = ?'
				).bind(postId, userPayload.id).first();
				return jsonResponse({ liked: !!existing });
			} catch (e) {
				return handleError(e);
			}
		}

		// POST /posts (Protected - in real app check token)
		if (url.pathname === '/api/posts' && method === 'POST') {
			try {
				const userPayload = await authenticate(request);
				const body = await request.json() as any;

				// Turnstile Check
				const ip = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
				if (!(await checkTurnstile(body, ip))) {
					return jsonResponse({ error: 'Turnstile verification failed' }, 403);
				}

				const { title, content: rawContent, category_id } = body;
				const citedPostIdRaw = body?.cited_post_id;
				const citedPostId =
					citedPostIdRaw === null || citedPostIdRaw === undefined || citedPostIdRaw === ''
						? null
						: Number(citedPostIdRaw);
				const isVisible = !(body?.is_visible === false || body?.is_visible === 0 || body?.visible === false || body?.visible === 0);
				let content = rawContent;
				
				if (!title || !content) {
					return jsonResponse({ error: 'Missing title or content' }, 400);
				}
				if (!category_id) {
					return jsonResponse({ error: '请选择分类' }, 400);
				}
				
				// --- Input Sanitization & Validation (Sync with Frontend) ---
				if (isVisuallyEmpty(title) || isVisuallyEmpty(content)) return jsonResponse({ error: 'Title or content cannot be empty' }, 400);
				
				if (hasInvisibleCharacters(title) || hasInvisibleCharacters(content)) return jsonResponse({ error: 'Title or content contains invalid invisible characters' }, 400);

				// Validate Lengths
				if (title.length > 30) return jsonResponse({ error: 'Title too long (Max 30 chars)' }, 400);
				if (content.length > 3000) return jsonResponse({ error: 'Content too long (Max 3000 chars)' }, 400);

				if (hasControlCharacters(title) || hasControlCharacters(content)) return jsonResponse({ error: 'Title or content contains invalid control characters' }, 400);

				const gate = await assertPublishAllowed(env.cforum_db, userPayload, 'post');
				if (!gate.ok) return jsonResponse({ error: gate.error }, gate.status);

				const moderationErr = await assertContentModeration(env.cforum_db, `${title}\n${content}`, {
					skip: userPayload.role === 'admin'
				});
				if (moderationErr) {
					if (userPayload.role !== 'admin') {
						const hit = await recordModerationReject(env.cforum_db, {
							userId: userPayload.id,
							reason: moderationErr,
							path: 'post',
							ip: request.headers.get('CF-Connecting-IP') || 'unknown'
						});
						const suffix = hit.cooldownUntil ? '；已进入发言冷却' : '';
						return jsonResponse({ error: moderationErr + suffix }, 400);
					}
					return jsonResponse({ error: moderationErr }, 400);
				}

				// HTML Escape Content (Backend Enforcement)
				content = content
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/"/g, '&quot;')
					.replace(/'/g, '&#039;');
				
				// Escape Title as well just in case
				const safeTitle = title
					.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;')
					.replace(/"/g, '&quot;')
					.replace(/'/g, '&#039;');

				// Validate Category + announcement restriction
				const category = await env.cforum_db
					.prepare(
						`SELECT id, admin_only, IFNULL(status_options, '[]') AS status_options,
							IFNULL(enable_cite, 0) AS enable_cite
						 FROM categories WHERE id = ?`
					)
					.bind(category_id)
					.first<any>();
				if (!category) return jsonResponse({ error: 'Category not found' }, 400);
				if (category.admin_only && userPayload.role !== 'admin') {
					return jsonResponse({ error: '该分类仅管理员可发帖' }, 403);
				}
				const citeErr = await validateCitedPostId(env.cforum_db, {
					citedPostId: citedPostId != null && Number.isFinite(citedPostId) ? citedPostId : null,
					sourceCategoryId: Number(category_id)
				});
				if (citeErr) return jsonResponse({ error: citeErr }, 400);
				const statusOptions = parseStatusOptions(category.status_options);
				const initialStatus = defaultStatusForOptions(statusOptions);

				const authorPublishUntil = isVisible
					? null
					: new Date(Date.now() + 15 * 60 * 1000)
							.toISOString()
							.replace('T', ' ')
							.slice(0, 19);
				const resolvedCite =
					citedPostId != null && Number.isFinite(citedPostId) ? citedPostId : null;
				const { success } = await env.cforum_db
					.prepare(
						`INSERT INTO posts (author_id, title, content, category_id, is_visible, author_publish_until, status, cited_post_id)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.bind(
						userPayload.id,
						safeTitle.trim(),
						content.trim(),
						category_id,
						isVisible ? 1 : 0,
						authorPublishUntil,
						initialStatus,
						resolvedCite
					)
					.run();

				await security.logAudit(userPayload.id, 'CREATE_POST', 'post', 'new', {
					title_length: safeTitle.length,
					is_visible: isVisible,
					author_publish_until: authorPublishUntil,
					status: initialStatus,
					cited_post_id: resolvedCite
				}, request);

				return jsonResponse({ success, author_publish_until: authorPublishUntil }, 201);
			} catch (e) {
				return handleError(e);
			}
		}

		if (method === 'GET' && !url.pathname.startsWith('/api')) {
			const pathname = url.pathname;
			const postMatch = pathname.match(/^\/posts\/(\d+)$/);
			if (postMatch) {
				const redirectUrl = new URL(request.url);
				redirectUrl.pathname = '/post';
				redirectUrl.search = `?id=${postMatch[1]}`;
				return Response.redirect(redirectUrl.toString(), 302);
			}
			const postAltMatch = pathname.match(/^\/post\/(\d+)$/);
			if (postAltMatch) {
				const redirectUrl = new URL(request.url);
				redirectUrl.pathname = '/post';
				redirectUrl.search = `?id=${postAltMatch[1]}`;
				return Response.redirect(redirectUrl.toString(), 302);
			}

			if (!(env as any).ASSETS?.fetch) return new Response('Not Found', { status: 404 });

			const panelSlug = getAdminPanelPath((env as any).ADMIN_PANEL_PATH);
			const panelHtml = `/${panelSlug}.html`;
			const noIndexHeaders = {
				'X-Robots-Tag': 'noindex, nofollow, noarchive',
				'X-Frame-Options': 'DENY',
				'Referrer-Policy': 'no-referrer',
				'Cache-Control': 'no-store'
			};

			// Legacy /admin entry is intentionally closed
			if (pathname === '/admin' || pathname === '/admin.html') {
				return new Response('Not Found', {
					status: 404,
					headers: { ...corsHeaders, ...noIndexHeaders }
				});
			}

			const mapped =
				pathname === '/login' ? '/login.html' :
				pathname === '/register' ? '/register.html' :
				pathname === '/forgot' ? '/forgot.html' :
				pathname === '/reset' ? '/reset.html' :
				pathname === '/settings' ? '/settings.html' :
				// Prefer extensionless path; forcing *.html can 308→pretty URL and loop
				pathname === `/${panelSlug}` || pathname === panelHtml ? `/${panelSlug}` :
				pathname === '/post' ? '/post.html' :
				pathname;

			const assetUrl = new URL(request.url);
			assetUrl.pathname = mapped;
			let assetRes = await (env as any).ASSETS.fetch(new Request(assetUrl, request));
			if (
				(assetRes.status === 404 || (assetRes.status >= 300 && assetRes.status < 400)) &&
				(pathname === `/${panelSlug}` || pathname === panelHtml)
			) {
				assetUrl.pathname = panelHtml;
				assetRes = await (env as any).ASSETS.fetch(
					new Request(assetUrl.toString(), { method: 'GET', redirect: 'manual' })
				);
			}
			if (assetRes.status !== 404 && !(assetRes.status >= 300 && assetRes.status < 400)) {
				if (pathname === `/${panelSlug}` || pathname === panelHtml || mapped === `/${panelSlug}`) {
					const headers = new Headers(assetRes.headers);
					for (const [k, v] of Object.entries(noIndexHeaders)) headers.set(k, v);
					return new Response(assetRes.body, { status: assetRes.status, headers });
				}
				return assetRes;
			}
			if (mapped !== pathname) {
				const directRes = await (env as any).ASSETS.fetch(request);
				if (directRes.status !== 404 && !(directRes.status >= 300 && directRes.status < 400)) {
					return directRes;
				}
			}
			return new Response('Not Found', { status: 404 });
		}

		return new Response('Not Found', { status: 404 });
	}
};
