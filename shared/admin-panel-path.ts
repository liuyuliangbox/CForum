/** Default public slug for the admin UI (no leading slash). Change + redeploy to rotate. */
export const DEFAULT_ADMIN_PANEL_PATH = 'c-ops-k7m2xq';

const RESERVED = new Set([
	'admin',
	'api',
	'assets',
	'forgot',
	'login',
	'post',
	'posts',
	'r2',
	'register',
	'reset',
	'settings',
	'user',
	'users'
]);

/** Sanitize env/default into a safe single path segment. */
export function getAdminPanelPath(envPath?: string | null): string {
	const raw = String(envPath || DEFAULT_ADMIN_PANEL_PATH)
		.trim()
		.replace(/^\/+|\/+$/g, '')
		.replace(/\.html$/i, '');
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{3,63}$/.test(raw)) return DEFAULT_ADMIN_PANEL_PATH;
	if (RESERVED.has(raw.toLowerCase())) return DEFAULT_ADMIN_PANEL_PATH;
	return raw;
}

export function adminPanelHref(envPath?: string | null): string {
	return `/${getAdminPanelPath(envPath)}`;
}
