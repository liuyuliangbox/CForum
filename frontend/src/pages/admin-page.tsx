import * as React from 'react';
import { ArrowDown, ArrowUp, Eye, Pencil, RefreshCw, Shield, User as UserIcon } from 'lucide-react';

import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { invalidateConfigCache } from '@/hooks/use-config';
import { apiFetch, getSecurityHeaders, type Category, type PostTemplate } from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { renderMarkdownToHtml } from '@/lib/markdown';
import { DEFAULT_SITE_TAGLINE, DEFAULT_SITE_TITLE } from '@/lib/site';

function statusOptionsToText(options?: string[] | null): string {
	return Array.isArray(options) && options.length ? options.join('\n') : '';
}

function textToStatusOptions(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 20);
}

export function AdminPage() {
	const token = getToken();
	const user = React.useMemo(() => getUser(), [token]);
	const isAdmin = user?.role === 'admin';
	const [error, setError] = React.useState('');
	const [loading, setLoading] = React.useState(false);

	const [stats, setStats] = React.useState<{ users: number; posts: number; comments: number } | null>(null);
	const [users, setUsers] = React.useState<
		Array<{
			id: number;
			email: string;
			username: string;
			role: string;
			verified: number;
			created_at: string;
			avatar_url?: string | null;
			posting_cooldown_until?: string | null;
		}>
	>([]);
	const [categories, setCategories] = React.useState<Category[]>([]);
	const [systemSettings, setSystemSettings] = React.useState({
		turnstile_enabled: false,
		notify_on_user_delete: false,
		notify_on_username_change: false,
		notify_on_avatar_change: false,
		notify_on_manual_verify: false,
		notify_on_post_status_change: true,
		notify_on_site_feature: true,
		guest_gate_enabled: true,
		guest_gate_soft_posts: 15,
		guest_gate_soft_lists: 10,
		guest_gate_soft_times: 3,
		site_title: DEFAULT_SITE_TITLE,
		site_tagline: DEFAULT_SITE_TAGLINE,
		site_brand: 'liuyuliangbox',
		project_codename: 'Project Turn',
		working_title_note: '正式名称待定 / Working Title',
		product_tagline: '单人修道，一回合定势。江湖未定，先把战斗打通。',
		site_description: '单人优先的回合制 RPG。开发日志、社区反馈与内测资讯。正式名称待定。',
		community_home_url: 'https://bbs.aridjaya.eu.org',
		footer_rights: '保留所有权利。',
		friend_links: [{ label: '社区 bbs.aridjaya.eu.org', url: 'https://bbs.aridjaya.eu.org' }] as Array<{
			label: string;
			url: string;
		}>,
		allowed_link_hosts_text: 'aridjaya.eu.org',
		ops_playbook: '',
		avatar_presets_text: ''
	});

	const [newCategoryName, setNewCategoryName] = React.useState('');
	const [newCategoryAdminOnly, setNewCategoryAdminOnly] = React.useState(false);
	const [newCategoryShowOnSite, setNewCategoryShowOnSite] = React.useState(false);
	const [newCategoryShowOnForum, setNewCategoryShowOnForum] = React.useState(true);
	const [newCategorySubtitle, setNewCategorySubtitle] = React.useState('');
	const [newCategoryStatusOptionsText, setNewCategoryStatusOptionsText] = React.useState('');
	const [newCategoryAuthorCanSetStatus, setNewCategoryAuthorCanSetStatus] = React.useState(false);
	const [newCategoryEnableCite, setNewCategoryEnableCite] = React.useState(false);
	const [newCategoryEnableCitedFrom, setNewCategoryEnableCitedFrom] = React.useState(false);
	const [newCategoryEnableRelate, setNewCategoryEnableRelate] = React.useState(false);
	const [editingCategoryId, setEditingCategoryId] = React.useState<number | null>(null);
	const [editingCategoryName, setEditingCategoryName] = React.useState('');
	const [editingCategoryAdminOnly, setEditingCategoryAdminOnly] = React.useState(false);
	const [editingCategoryShowOnSite, setEditingCategoryShowOnSite] = React.useState(false);
	const [editingCategoryShowOnForum, setEditingCategoryShowOnForum] = React.useState(true);
	const [editingCategorySubtitle, setEditingCategorySubtitle] = React.useState('');
	const [editingCategoryStatusOptionsText, setEditingCategoryStatusOptionsText] = React.useState('');
	const [editingCategoryAuthorCanSetStatus, setEditingCategoryAuthorCanSetStatus] = React.useState(false);
	const [editingCategoryEnableCite, setEditingCategoryEnableCite] = React.useState(false);
	const [editingCategoryEnableCitedFrom, setEditingCategoryEnableCitedFrom] = React.useState(false);
	const [editingCategoryEnableRelate, setEditingCategoryEnableRelate] = React.useState(false);

	const [postTemplates, setPostTemplates] = React.useState<PostTemplate[]>([]);
	const [tplName, setTplName] = React.useState('');
	const [tplBody, setTplBody] = React.useState('');
	const [tplCategoryIds, setTplCategoryIds] = React.useState<number[]>([]);
	const [editingTplId, setEditingTplId] = React.useState<number | null>(null);
	const [opsPlaybookEditing, setOpsPlaybookEditing] = React.useState(false);
	const opsPlaybookPreviewRef = React.useRef<HTMLDivElement | null>(null);

	const [moderationWords, setModerationWords] = React.useState<
		Array<{ id: number; word: string; enabled: number; created_at: string }>
	>([]);
	const [newModerationWord, setNewModerationWord] = React.useState('');

	const [editOpen, setEditOpen] = React.useState(false);
	const [editUserId, setEditUserId] = React.useState<number | null>(null);
	const [editEmail, setEditEmail] = React.useState('');
	const [editUsername, setEditUsername] = React.useState('');
	const [editAvatarUrl, setEditAvatarUrl] = React.useState('');
	const [editPassword, setEditPassword] = React.useState('');
	const [editError, setEditError] = React.useState('');
	const [editAvatarIsDataUri, setEditAvatarIsDataUri] = React.useState(false);

	React.useEffect(() => {
		if (!token) window.location.href = '/login';
	}, [token]);

	React.useEffect(() => {
		if (token && !isAdmin) setError('无权限访问管理后台');
	}, [token, isAdmin]);

	const refresh = React.useCallback(async () => {
		if (!isAdmin) return;
		setLoading(true);
		setError('');
		try {
			const [s, u, c, settings, words, templates] = await Promise.all([
				apiFetch<{ users: number; posts: number; comments: number }>('/admin/stats', { headers: getSecurityHeaders('GET') }),
				apiFetch<any[]>('/admin/users', { headers: getSecurityHeaders('GET') }),
				apiFetch<Category[]>('/categories'),
				apiFetch<any>('/admin/settings', { headers: getSecurityHeaders('GET') }),
				apiFetch<Array<{ id: number; word: string; enabled: number; created_at: string }>>('/admin/moderation-words', {
					headers: getSecurityHeaders('GET')
				}),
				apiFetch<PostTemplate[]>('/admin/post-templates', { headers: getSecurityHeaders('GET') })
			]);
			setStats(s);
			setUsers(u as any);
			setCategories(c);
			setModerationWords(Array.isArray(words) ? words : []);
			setPostTemplates(Array.isArray(templates) ? templates : []);
			let friendLinks: Array<{ label: string; url: string }> = [
				{ label: '社区 bbs.aridjaya.eu.org', url: 'https://bbs.aridjaya.eu.org' }
			];
			try {
				const raw = settings.friend_links;
				const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
				if (Array.isArray(parsed) && parsed.length > 0) {
					friendLinks = parsed
						.map((item: any) => ({
							label: String(item?.label || '').trim(),
							url: String(item?.url || '').trim()
						}))
						.filter((x: { label: string; url: string }) => x.label && x.url);
				}
			} catch {
				/* keep default */
			}
			let allowedHostsText = 'aridjaya.eu.org';
			try {
				const rawHosts = settings.allowed_link_hosts;
				const parsedHosts =
					typeof rawHosts === 'string'
						? rawHosts.trim().startsWith('[')
							? JSON.parse(rawHosts)
							: rawHosts.split(/[\n,]+/)
						: rawHosts;
				if (Array.isArray(parsedHosts) && parsedHosts.length) {
					allowedHostsText = parsedHosts.map((h: unknown) => String(h || '').trim()).filter(Boolean).join('\n');
				} else if (typeof rawHosts === 'string' && rawHosts.trim() && !rawHosts.trim().startsWith('[')) {
					allowedHostsText = rawHosts
						.split(/[\n,]+/)
						.map((h: string) => h.trim())
						.filter(Boolean)
						.join('\n');
				}
			} catch {
				allowedHostsText = 'aridjaya.eu.org';
			}
			setSystemSettings({
				turnstile_enabled: !!settings.turnstile_enabled,
				notify_on_user_delete: !!settings.notify_on_user_delete,
				notify_on_username_change: !!settings.notify_on_username_change,
				notify_on_avatar_change: !!settings.notify_on_avatar_change,
				notify_on_manual_verify: !!settings.notify_on_manual_verify,
				notify_on_post_status_change: settings.notify_on_post_status_change !== false,
				notify_on_site_feature: settings.notify_on_site_feature !== false,
				guest_gate_enabled: settings.guest_gate_enabled !== false,
				guest_gate_soft_posts: Number(settings.guest_gate_soft_posts) || 15,
				guest_gate_soft_lists: Number(settings.guest_gate_soft_lists) || 10,
				guest_gate_soft_times: Number(settings.guest_gate_soft_times) || 3,
				site_title: settings.site_title || DEFAULT_SITE_TITLE,
				site_tagline: settings.site_tagline || DEFAULT_SITE_TAGLINE,
				site_brand: settings.site_brand || 'liuyuliangbox',
				project_codename: settings.project_codename || 'Project Turn',
				working_title_note: settings.working_title_note || '正式名称待定 / Working Title',
				product_tagline:
					settings.product_tagline || '单人修道，一回合定势。江湖未定，先把战斗打通。',
				site_description:
					settings.site_description ||
					'单人优先的回合制 RPG。开发日志、社区反馈与内测资讯。正式名称待定。',
				community_home_url: settings.community_home_url || 'https://bbs.aridjaya.eu.org',
				footer_rights: settings.footer_rights || '保留所有权利。',
				friend_links: friendLinks.length
					? friendLinks
					: [{ label: '社区 bbs.aridjaya.eu.org', url: 'https://bbs.aridjaya.eu.org' }],
				allowed_link_hosts_text: allowedHostsText || 'aridjaya.eu.org',
				ops_playbook: String(settings.ops_playbook || ''),
				avatar_presets_text: (() => {
					const raw = settings.avatar_presets;
					if (Array.isArray(raw)) return raw.map((s: unknown) => String(s || '').trim()).filter(Boolean).join('\n');
					if (typeof raw === 'string') {
						const t = raw.trim();
						if (t.startsWith('[')) {
							try {
								const parsed = JSON.parse(t);
								if (Array.isArray(parsed)) {
									return parsed.map((s) => String(s || '').trim()).filter(Boolean).join('\n');
								}
							} catch {
								/* fallthrough */
							}
						}
						return t;
					}
					return '';
				})()
			});
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}, [isAdmin]);

	React.useEffect(() => {
		refresh();
	}, [refresh]);

	async function saveSettings() {
		if (!isAdmin) return;
		setLoading(true);
		setError('');
		try {
			const allowedHosts = systemSettings.allowed_link_hosts_text
				.split(/[\n,]+/)
				.map((s) => s.trim())
				.filter(Boolean);
			const avatarPresets = systemSettings.avatar_presets_text
				.split(/\r?\n/)
				.map((s) => s.trim())
				.filter(Boolean);
			await apiFetch('/admin/settings', {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({
					...systemSettings,
					allowed_link_hosts: allowedHosts.length ? allowedHosts : ['aridjaya.eu.org'],
					avatar_presets: avatarPresets
				})
			});
			invalidateConfigCache();
			setOpsPlaybookEditing(false);
			alert('设置已保存');
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	async function addModerationWord() {
		if (!isAdmin) return;
		const word = newModerationWord.trim();
		if (!word) return;
		setLoading(true);
		setError('');
		try {
			await apiFetch('/admin/moderation-words', {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({ word })
			});
			setNewModerationWord('');
			await refresh();
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	async function deleteModerationWord(id: number) {
		if (!isAdmin) return;
		if (!confirm('确定删除该敏感词？')) return;
		setLoading(true);
		setError('');
		try {
			await apiFetch(`/admin/moderation-words/${id}`, {
				method: 'DELETE',
				headers: getSecurityHeaders('DELETE')
			});
			await refresh();
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	async function createCategory() {
		if (!isAdmin) return;
		if (!newCategoryName) return;
		setLoading(true);
		setError('');
		try {
			await apiFetch('/admin/categories', {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({
					name: newCategoryName,
					admin_only: newCategoryAdminOnly,
					show_on_site: newCategoryShowOnSite,
					show_on_forum: newCategoryShowOnForum,
					subtitle: newCategoryShowOnSite ? newCategorySubtitle : '',
					status_options: textToStatusOptions(newCategoryStatusOptionsText),
					author_can_set_status: newCategoryAuthorCanSetStatus,
					enable_cite: newCategoryEnableCite,
					enable_cited_from: newCategoryEnableCitedFrom,
					enable_relate: newCategoryEnableRelate
				})
			});
			setNewCategoryName('');
			setNewCategoryAdminOnly(false);
			setNewCategoryShowOnSite(false);
			setNewCategoryShowOnForum(true);
			setNewCategorySubtitle('');
			setNewCategoryStatusOptionsText('');
			setNewCategoryAuthorCanSetStatus(false);
			setNewCategoryEnableCite(false);
			setNewCategoryEnableCitedFrom(false);
			setNewCategoryEnableRelate(false);
			await refresh();
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	async function updateCategory(id: number) {
		if (!isAdmin) return;
		if (!editingCategoryName) return;
		setLoading(true);
		setError('');
		try {
			await apiFetch(`/admin/categories/${id}`, {
				method: 'PUT',
				headers: getSecurityHeaders('PUT'),
				body: JSON.stringify({
					name: editingCategoryName,
					admin_only: editingCategoryAdminOnly,
					show_on_site: editingCategoryShowOnSite,
					show_on_forum: editingCategoryShowOnForum,
					subtitle: editingCategoryShowOnSite ? editingCategorySubtitle : '',
					status_options: textToStatusOptions(editingCategoryStatusOptionsText),
					author_can_set_status: editingCategoryAuthorCanSetStatus,
					enable_cite: editingCategoryEnableCite,
					enable_cited_from: editingCategoryEnableCitedFrom,
					enable_relate: editingCategoryEnableRelate
				})
			});
			setEditingCategoryId(null);
			setEditingCategoryName('');
			setEditingCategoryAdminOnly(false);
			setEditingCategoryShowOnSite(false);
			setEditingCategoryShowOnForum(true);
			setEditingCategorySubtitle('');
			setEditingCategoryStatusOptionsText('');
			setEditingCategoryAuthorCanSetStatus(false);
			setEditingCategoryEnableCite(false);
			setEditingCategoryEnableCitedFrom(false);
			setEditingCategoryEnableRelate(false);
			await refresh();
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	async function deleteCategory(id: number) {
		if (!confirm('确定删除此分类？')) return;
		setLoading(true);
		setError('');
		try {
			await apiFetch(`/admin/categories/${id}`, { method: 'DELETE', headers: getSecurityHeaders('DELETE') });
			await refresh();
		} catch (e: any) {
			const msg = String(e?.message || e);
			setError(msg);
			alert(msg);
		} finally {
			setLoading(false);
		}
	}

	function toggleTplCategory(id: number) {
		setTplCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
	}

	async function savePostTemplate() {
		if (!isAdmin) return;
		const name = tplName.trim();
		if (!name) return;
		setLoading(true);
		setError('');
		try {
			if (editingTplId) {
				await apiFetch(`/admin/post-templates/${editingTplId}`, {
					method: 'PUT',
					headers: getSecurityHeaders('PUT'),
					body: JSON.stringify({ name, body: tplBody, category_ids: tplCategoryIds })
				});
			} else {
				await apiFetch('/admin/post-templates', {
					method: 'POST',
					headers: getSecurityHeaders('POST'),
					body: JSON.stringify({ name, body: tplBody, category_ids: tplCategoryIds })
				});
			}
			setTplName('');
			setTplBody('');
			setTplCategoryIds([]);
			setEditingTplId(null);
			await refresh();
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	async function deletePostTemplate(id: number) {
		if (!confirm('确定删除该发帖模板？')) return;
		setLoading(true);
		setError('');
		try {
			await apiFetch(`/admin/post-templates/${id}`, { method: 'DELETE', headers: getSecurityHeaders('DELETE') });
			if (editingTplId === id) {
				setEditingTplId(null);
				setTplName('');
				setTplBody('');
				setTplCategoryIds([]);
			}
			await refresh();
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	async function moveCategory(id: number, direction: -1 | 1) {
		if (!isAdmin) return;
		const sorted = [...categories].sort(
			(a, b) => Number(a.sort_order ?? a.id) - Number(b.sort_order ?? b.id) || a.id - b.id
		);
		const idx = sorted.findIndex((c) => c.id === id);
		const swapIdx = idx + direction;
		if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return;
		const next = [...sorted];
		const tmp = next[idx];
		next[idx] = next[swapIdx];
		next[swapIdx] = tmp;
		setLoading(true);
		setError('');
		try {
			await apiFetch('/admin/categories/reorder', {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({ ordered_ids: next.map((c) => c.id) })
			});
			await refresh();
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	function openEdit(u: any) {
		const avatar = String(u.avatar_url || '');
		const isDataUri = avatar.startsWith('data:image/');
		setEditUserId(u.id);
		setEditEmail(u.email || '');
		setEditUsername(u.username || '');
		setEditAvatarUrl(isDataUri ? '' : avatar);
		setEditAvatarIsDataUri(isDataUri);
		setEditPassword('');
		setEditError('');
		setEditOpen(true);
	}

	async function saveEdit() {
		if (!editUserId) return;
		setLoading(true);
		setEditError('');
		setError('');
		if (editPassword && (editPassword.length < 8 || editPassword.length > 16)) {
			setEditError('密码必须为 8-16 个字符');
			setLoading(false);
			return;
		}
		try {
			const payload: Record<string, unknown> = {
				email: editEmail || undefined,
				username: editUsername || undefined,
				password: editPassword || undefined
			};
			if (editAvatarIsDataUri && !editAvatarUrl.trim()) {
				// Legacy data-URI avatar: ask backend to migrate/regenerate onto R2
				payload.avatar_url = '';
			} else {
				payload.avatar_url = editAvatarUrl;
			}
			await apiFetch(`/admin/users/${editUserId}/update`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify(payload)
			});
			setEditOpen(false);
			await refresh();
		} catch (e: any) {
			const msg = String(e?.message || e);
			setEditError(msg);
			setError(msg);
		} finally {
			setLoading(false);
		}
	}

	async function deleteUser(id: number) {
		if (!confirm('确定删除此用户？')) return;
		setLoading(true);
		setError('');
		try {
			await apiFetch(`/admin/users/${id}`, { method: 'DELETE', headers: getSecurityHeaders('DELETE') });
			await refresh();
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	async function manualVerify(id: number) {
		if (!confirm('确认手动验证此用户？')) return;
		setLoading(true);
		setError('');
		try {
			await apiFetch(`/admin/users/${id}/verify`, { method: 'POST', headers: getSecurityHeaders('POST'), body: JSON.stringify({}) });
			await refresh();
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	async function resendEmail(id: number) {
		if (!confirm('重新发送验证邮件？')) return;
		setLoading(true);
		setError('');
		try {
			await apiFetch(`/admin/users/${id}/resend`, { method: 'POST', headers: getSecurityHeaders('POST'), body: JSON.stringify({}) });
			alert('已发送');
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	function cooldownActive(until: string | null | undefined): boolean {
		if (!until) return false;
		const raw = String(until).trim();
		const ms = Date.parse(raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
		return !Number.isNaN(ms) && ms > Date.now();
	}

	async function clearCooldown(id: number) {
		if (!confirm('确认解除该用户的发言冷却？')) return;
		setLoading(true);
		setError('');
		try {
			await apiFetch(`/admin/users/${id}/clear-cooldown`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({})
			});
			await refresh();
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}

	return (
		<PageShell title="管理后台">
			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-2xl font-semibold tracking-tight">管理后台</h1>
						<p className="text-sm text-muted-foreground">站点设置、分类与用户管理</p>
					</div>
					<Button variant="outline" onClick={refresh} disabled={loading}>
						<RefreshCw className="h-4 w-4" />
						<span className="sr-only">刷新</span>
					</Button>
				</div>

				{user?.role !== 'admin' ? (
					<Card>
						<CardContent className="py-6 text-sm text-muted-foreground">无权限访问</CardContent>
					</Card>
				) : (
					<>
						{error ? <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">{error}</div> : null}

						<Card>
							<CardHeader>
								<CardTitle>统计</CardTitle>
							</CardHeader>
							<CardContent className="grid gap-4 sm:grid-cols-3">
								<div className="rounded-md border p-4">
									<div className="text-sm text-muted-foreground">用户</div>
									<div className="text-2xl font-semibold">{stats?.users ?? '-'}</div>
								</div>
								<div className="rounded-md border p-4">
									<div className="text-sm text-muted-foreground">帖子</div>
									<div className="text-2xl font-semibold">{stats?.posts ?? '-'}</div>
								</div>
								<div className="rounded-md border p-4">
									<div className="text-sm text-muted-foreground">评论</div>
									<div className="text-2xl font-semibold">{stats?.comments ?? '-'}</div>
								</div>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>站点设置</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								<p className="text-sm text-muted-foreground">社区顶栏标题（仅社区站）</p>
								<div className="grid gap-3 sm:grid-cols-2">
									<div className="space-y-2">
										<Label htmlFor="site-title">社区标题</Label>
										<Input
											id="site-title"
											value={systemSettings.site_title}
											onChange={(e) => setSystemSettings((s) => ({ ...s, site_title: e.target.value }))}
											maxLength={80}
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor="site-tagline">社区副标题</Label>
										<Input
											id="site-tagline"
											value={systemSettings.site_tagline}
											onChange={(e) => setSystemSettings((s) => ({ ...s, site_tagline: e.target.value }))}
											maxLength={160}
										/>
									</div>
								</div>
								<Separator />
								<p className="text-sm font-medium">官网展示</p>
								<p className="text-xs text-muted-foreground">构建官网时同步；改完后需重建官网生效</p>
								<div className="grid gap-3 sm:grid-cols-2">
									<div className="space-y-2">
										<Label htmlFor="site-brand">品牌名</Label>
										<Input
											id="site-brand"
											value={systemSettings.site_brand}
											onChange={(e) => setSystemSettings((s) => ({ ...s, site_brand: e.target.value }))}
											maxLength={80}
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor="project-codename">项目代号</Label>
										<Input
											id="project-codename"
											value={systemSettings.project_codename}
											onChange={(e) => setSystemSettings((s) => ({ ...s, project_codename: e.target.value }))}
											maxLength={80}
										/>
									</div>
									<div className="space-y-2 sm:col-span-2">
										<Label htmlFor="working-title-note">正式名称说明</Label>
										<Input
											id="working-title-note"
											value={systemSettings.working_title_note}
											onChange={(e) => setSystemSettings((s) => ({ ...s, working_title_note: e.target.value }))}
											maxLength={120}
										/>
									</div>
									<div className="space-y-2 sm:col-span-2">
										<Label htmlFor="product-tagline">产品一句话（首页）</Label>
										<Input
											id="product-tagline"
											value={systemSettings.product_tagline}
											onChange={(e) => setSystemSettings((s) => ({ ...s, product_tagline: e.target.value }))}
											maxLength={160}
											placeholder="单人修道，一回合定势……"
										/>
									</div>
									<div className="space-y-2 sm:col-span-2">
										<Label htmlFor="site-description">SEO 描述</Label>
										<Input
											id="site-description"
											value={systemSettings.site_description}
											onChange={(e) => setSystemSettings((s) => ({ ...s, site_description: e.target.value }))}
											maxLength={300}
										/>
									</div>
									<div className="space-y-2 sm:col-span-2">
										<Label htmlFor="community-home-url">社区首页地址</Label>
										<Input
											id="community-home-url"
											value={systemSettings.community_home_url}
											onChange={(e) =>
												setSystemSettings((s) => ({ ...s, community_home_url: e.target.value }))
											}
											maxLength={300}
											placeholder="https://bbs.aridjaya.eu.org"
										/>
										<p className="text-xs text-muted-foreground">
											官网「最新社区精选 → 查看更多」跳转到此地址
										</p>
									</div>
									<div className="space-y-2 sm:col-span-2">
										<Label htmlFor="footer-rights">版权后缀</Label>
										<Input
											id="footer-rights"
											value={systemSettings.footer_rights}
											onChange={(e) => setSystemSettings((s) => ({ ...s, footer_rights: e.target.value }))}
											maxLength={80}
										/>
									</div>
								</div>
								<Separator />
								<p className="text-sm font-medium">友链管理</p>
								<p className="text-xs text-muted-foreground">
									出现在官网页尾，与顶部导航栏目独立；可放社区、镜像、合作站点等
								</p>
								<div className="space-y-3">
									{systemSettings.friend_links.map((link, idx) => (
										<div key={idx} className="grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
											<Input
												placeholder="显示名称"
												value={link.label}
												onChange={(e) =>
													setSystemSettings((s) => {
														const next = [...s.friend_links];
														next[idx] = { ...next[idx], label: e.target.value };
														return { ...s, friend_links: next };
													})
												}
												maxLength={80}
											/>
											<Input
												placeholder="https://"
												value={link.url}
												onChange={(e) =>
													setSystemSettings((s) => {
														const next = [...s.friend_links];
														next[idx] = { ...next[idx], url: e.target.value };
														return { ...s, friend_links: next };
													})
												}
												maxLength={300}
											/>
											<Button
												type="button"
												variant="outline"
												onClick={() =>
													setSystemSettings((s) => ({
														...s,
														friend_links: s.friend_links.filter((_, i) => i !== idx)
													}))
												}
											>
												删除
											</Button>
										</div>
									))}
									<Button
										type="button"
										variant="secondary"
										onClick={() =>
											setSystemSettings((s) => ({
												...s,
												friend_links: [...s.friend_links, { label: '', url: '' }]
											}))
										}
									>
										添加友链
									</Button>
								</div>
								<Separator />
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										className="h-4 w-4"
										checked={systemSettings.turnstile_enabled}
										onChange={(e) => setSystemSettings((s) => ({ ...s, turnstile_enabled: e.target.checked }))}
									/>
									启用 Cloudflare Turnstile
								</label>
								<Separator />
								<div className="grid gap-3 sm:grid-cols-2">
									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											className="h-4 w-4"
											checked={systemSettings.notify_on_user_delete}
											onChange={(e) => setSystemSettings((s) => ({ ...s, notify_on_user_delete: e.target.checked }))}
										/>
										删除账号时通知用户
									</label>
									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											className="h-4 w-4"
											checked={systemSettings.notify_on_username_change}
											onChange={(e) => setSystemSettings((s) => ({ ...s, notify_on_username_change: e.target.checked }))}
										/>
										修改用户名时通知用户
									</label>
									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											className="h-4 w-4"
											checked={systemSettings.notify_on_avatar_change}
											onChange={(e) => setSystemSettings((s) => ({ ...s, notify_on_avatar_change: e.target.checked }))}
										/>
										修改头像时通知用户
									</label>
									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											className="h-4 w-4"
											checked={systemSettings.notify_on_manual_verify}
											onChange={(e) => setSystemSettings((s) => ({ ...s, notify_on_manual_verify: e.target.checked }))}
										/>
										手动验证通过时通知用户
									</label>
									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											className="h-4 w-4"
											checked={systemSettings.notify_on_post_status_change}
											onChange={(e) =>
												setSystemSettings((s) => ({ ...s, notify_on_post_status_change: e.target.checked }))
											}
										/>
										帖子状态变更时邮件通知作者
									</label>
									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											className="h-4 w-4"
											checked={systemSettings.notify_on_site_feature}
											onChange={(e) =>
												setSystemSettings((s) => ({ ...s, notify_on_site_feature: e.target.checked }))
											}
										/>
										官网精选变更时邮件通知作者
									</label>
									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											className="h-4 w-4"
											checked={systemSettings.guest_gate_enabled}
											onChange={(e) =>
												setSystemSettings((s) => ({ ...s, guest_gate_enabled: e.target.checked }))
											}
										/>
										启用游客兴趣转化门禁（先软后硬）
									</label>
									{systemSettings.guest_gate_enabled ? (
										<div className="grid gap-2 rounded-md border border-dashed p-3 sm:grid-cols-2">
											<label className="space-y-1 text-sm">
												<span className="text-muted-foreground">软提示：不同帖数 ≥</span>
												<Input
													type="number"
													min={1}
													max={200}
													value={systemSettings.guest_gate_soft_posts}
													onChange={(e) =>
														setSystemSettings((s) => ({
															...s,
															guest_gate_soft_posts: Number(e.target.value) || 15
														}))
													}
												/>
											</label>
											<label className="space-y-1 text-sm">
												<span className="text-muted-foreground">软提示：列表加载次数 ≥</span>
												<Input
													type="number"
													min={1}
													max={200}
													value={systemSettings.guest_gate_soft_lists}
													onChange={(e) =>
														setSystemSettings((s) => ({
															...s,
															guest_gate_soft_lists: Number(e.target.value) || 10
														}))
													}
												/>
											</label>
											<label className="space-y-1 text-sm sm:col-span-2">
												<span className="text-muted-foreground">软提示可关闭次数（达到后硬拦）</span>
												<Input
													type="number"
													min={1}
													max={20}
													value={systemSettings.guest_gate_soft_times}
													onChange={(e) =>
														setSystemSettings((s) => ({
															...s,
															guest_gate_soft_times: Number(e.target.value) || 3
														}))
													}
												/>
											</label>
											<p className="text-xs text-muted-foreground sm:col-span-2">
												每次关闭软提示会重置浏览计数并 +1；达到设定次数后，翻页或打开新帖需登录。
											</p>
										</div>
									) : null}
								</div>
								<div className="space-y-2">
									<Label htmlFor="allowed-link-hosts">链接域名白名单（一行一个）</Label>
									<Textarea
										id="allowed-link-hosts"
										rows={4}
										value={systemSettings.allowed_link_hosts_text}
										onChange={(e) =>
											setSystemSettings((s) => ({ ...s, allowed_link_hosts_text: e.target.value }))
										}
										placeholder={'aridjaya.eu.org\nexample.com'}
									/>
									<p className="text-xs text-muted-foreground">
										普通用户外链仅允许这些域名及其子域；管理员发布不受限。默认 aridjaya.eu.org。
									</p>
								</div>
								<div className="space-y-2">
									<Label htmlFor="avatar-presets">预设头像列表（一行一个 URL）</Label>
									<Textarea
										id="avatar-presets"
										rows={6}
										value={systemSettings.avatar_presets_text}
										onChange={(e) =>
											setSystemSettings((s) => ({ ...s, avatar_presets_text: e.target.value }))
										}
										placeholder={'/api/preset-avatars/1\n/api/preset-avatars/2'}
										className="font-mono text-sm"
									/>
									<p className="text-xs text-muted-foreground">
										用户只能从这里选择头像，不支持上传。留空则恢复默认 12 个生成占位图（/api/preset-avatars/1…12）。
									</p>
									{systemSettings.avatar_presets_text.trim() ? (
										<div className="flex flex-wrap gap-2 pt-1">
											{systemSettings.avatar_presets_text
												.split(/\r?\n/)
												.map((s) => s.trim())
												.filter(Boolean)
												.slice(0, 24)
												.map((url) => (
													<img
														key={url}
														src={url}
														alt=""
														className="h-10 w-10 rounded-md border bg-muted object-cover"
													/>
												))}
										</div>
									) : null}
								</div>
								<div className="space-y-2">
									<div className="flex flex-wrap items-center justify-between gap-2">
										<Label htmlFor="ops-playbook">运营备忘 / 设置说明（Markdown）</Label>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => setOpsPlaybookEditing((v) => !v)}
										>
											{opsPlaybookEditing ? (
												<>
													<Eye className="h-4 w-4" />
													预览
												</>
											) : (
												<>
													<Pencil className="h-4 w-4" />
													编辑
												</>
											)}
										</Button>
									</div>
									{opsPlaybookEditing ? (
										<Textarea
											id="ops-playbook"
											rows={18}
											value={systemSettings.ops_playbook}
											onChange={(e) => setSystemSettings((s) => ({ ...s, ops_playbook: e.target.value }))}
											placeholder="分类开关、引用/关联、活动节奏…"
											className="font-mono text-sm"
										/>
									) : (
										<div className="max-h-[32rem] overflow-y-auto rounded-md border bg-muted/20 p-4">
											{systemSettings.ops_playbook.trim() ? (
												<div
													ref={opsPlaybookPreviewRef}
													className="prose max-w-none break-words text-sm [&_table]:w-full [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6"
													dangerouslySetInnerHTML={{
														__html: renderMarkdownToHtml(systemSettings.ops_playbook)
													}}
												/>
											) : (
												<p className="text-sm text-muted-foreground">暂无内容，点「编辑」补充运营说明。</p>
											)}
										</div>
									)}
									<p className="text-xs text-muted-foreground">
										默认预览便于阅读；改完后点上方「保存设置」。仅管理员可见，不会展示给普通用户。
									</p>
								</div>
								<Button onClick={saveSettings} disabled={loading}>
									{loading ? '保存中...' : '保存设置'}
								</Button>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>内容审查 / 敏感词</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								<p className="text-sm text-muted-foreground">
									普通用户发帖、改帖与评论命中敏感词将拒绝发布；管理员发布跳过审查。
								</p>
								<div className="flex flex-wrap items-end gap-3">
									<div className="min-w-[220px] flex-1 space-y-2">
										<Label htmlFor="moderation-word">新增敏感词</Label>
										<Input
											id="moderation-word"
											value={newModerationWord}
											onChange={(e) => setNewModerationWord(e.target.value)}
											placeholder="例如：外挂"
											maxLength={64}
										/>
									</div>
									<Button type="button" onClick={() => void addModerationWord()} disabled={loading || !newModerationWord.trim()}>
										添加
									</Button>
								</div>
								{moderationWords.length ? (
									<ul className="divide-y rounded-md border">
										{moderationWords.map((w) => (
											<li key={w.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
												<span className="break-all font-medium">{w.word}</span>
												<Button type="button" variant="outline" size="sm" onClick={() => void deleteModerationWord(w.id)}>
													删除
												</Button>
											</li>
										))}
									</ul>
								) : (
									<p className="text-sm text-muted-foreground">暂无敏感词，可在上方添加。</p>
								)}
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>分类管理</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="space-y-3">
									<div className="flex flex-wrap items-end gap-3">
										<div className="space-y-2">
											<Label htmlFor="cat-name">分类名称</Label>
											<Input id="cat-name" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} />
										</div>
										<label className="mb-2 flex items-center gap-2 text-sm">
											<input
												type="checkbox"
												className="h-4 w-4"
												checked={newCategoryAdminOnly}
												onChange={(e) => setNewCategoryAdminOnly(e.target.checked)}
											/>
											仅管理员发帖
										</label>
										<label className="mb-2 flex items-center gap-2 text-sm">
											<input
												type="checkbox"
												className="h-4 w-4"
												checked={newCategoryShowOnSite}
												onChange={(e) => {
													setNewCategoryShowOnSite(e.target.checked);
													if (!e.target.checked) setNewCategorySubtitle('');
												}}
											/>
											官网展示
										</label>
										<label className="mb-2 flex items-center gap-2 text-sm">
											<input
												type="checkbox"
												className="h-4 w-4"
												checked={newCategoryShowOnForum}
												onChange={(e) => setNewCategoryShowOnForum(e.target.checked)}
											/>
											社区展示
										</label>
										<Button onClick={createCategory} disabled={loading}>
											添加
										</Button>
									</div>
									{newCategoryShowOnSite ? (
										<div className="max-w-xl space-y-2">
											<Label htmlFor="cat-subtitle">官网副标题（可选）</Label>
											<Input
												id="cat-subtitle"
												value={newCategorySubtitle}
												placeholder="展示在官网栏目页标题下方"
												onChange={(e) => setNewCategorySubtitle(e.target.value)}
											/>
										</div>
									) : null}
									<div className="grid max-w-2xl gap-3 sm:grid-cols-2">
										<div className="space-y-2">
											<Label htmlFor="cat-status-options">帖子状态（一行一个，空=不启用）</Label>
											<Textarea
												id="cat-status-options"
												rows={4}
												value={newCategoryStatusOptionsText}
												onChange={(e) => setNewCategoryStatusOptionsText(e.target.value)}
												placeholder={'待处理\n处理中\n已解决'}
											/>
										</div>
										<label className="flex items-start gap-2 self-end pb-2 text-sm">
											<input
												type="checkbox"
												className="mt-0.5 h-4 w-4"
												checked={newCategoryAuthorCanSetStatus}
												onChange={(e) => setNewCategoryAuthorCanSetStatus(e.target.checked)}
											/>
											<span>作者可修改状态（如问答「已解决」）</span>
										</label>
									</div>
									<div className="flex flex-wrap gap-4 text-sm">
										<label className="flex items-center gap-2">
											<input
												type="checkbox"
												className="h-4 w-4"
												checked={newCategoryEnableCite}
												onChange={(e) => setNewCategoryEnableCite(e.target.checked)}
											/>
											可引用他人
										</label>
										<label className="flex items-center gap-2">
											<input
												type="checkbox"
												className="h-4 w-4"
												checked={newCategoryEnableCitedFrom}
												onChange={(e) => setNewCategoryEnableCitedFrom(e.target.checked)}
											/>
											可被引用
										</label>
										<label className="flex items-center gap-2">
											<input
												type="checkbox"
												className="h-4 w-4"
												checked={newCategoryEnableRelate}
												onChange={(e) => setNewCategoryEnableRelate(e.target.checked)}
											/>
											启用关联
										</label>
									</div>
								</div>
								<div className="space-y-2">
									{[...categories]
										.sort((a, b) => Number(a.sort_order ?? a.id) - Number(b.sort_order ?? b.id) || a.id - b.id)
										.map((c, idx, arr) => (
										<div key={c.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
											{editingCategoryId === c.id ? (
												<div className="flex w-full flex-col gap-3">
													<div className="flex flex-wrap items-center gap-3">
														<Input
															value={editingCategoryName}
															onChange={(e) => setEditingCategoryName(e.target.value)}
															className="h-9 max-w-xs"
														/>
														<label className="flex items-center gap-2 text-sm">
															<input
																type="checkbox"
																className="h-4 w-4"
																checked={editingCategoryAdminOnly}
																onChange={(e) => setEditingCategoryAdminOnly(e.target.checked)}
															/>
															仅管理员发帖
														</label>
														<label className="flex items-center gap-2 text-sm">
															<input
																type="checkbox"
																className="h-4 w-4"
																checked={editingCategoryShowOnSite}
																onChange={(e) => {
																	setEditingCategoryShowOnSite(e.target.checked);
																	if (!e.target.checked) setEditingCategorySubtitle('');
																}}
															/>
															官网展示
														</label>
														<label className="flex items-center gap-2 text-sm">
															<input
																type="checkbox"
																className="h-4 w-4"
																checked={editingCategoryShowOnForum}
																onChange={(e) => setEditingCategoryShowOnForum(e.target.checked)}
															/>
															社区展示
														</label>
													</div>
													{editingCategoryShowOnSite ? (
														<div className="max-w-xl space-y-1">
															<Label>官网副标题（可选）</Label>
															<Input
																value={editingCategorySubtitle}
																placeholder="展示在官网栏目页标题下方"
																onChange={(e) => setEditingCategorySubtitle(e.target.value)}
															/>
														</div>
													) : null}
													<div className="grid max-w-2xl gap-3 sm:grid-cols-2">
														<div className="space-y-1">
															<Label>帖子状态（一行一个，空=不启用）</Label>
															<Textarea
																rows={4}
																value={editingCategoryStatusOptionsText}
																onChange={(e) => setEditingCategoryStatusOptionsText(e.target.value)}
																placeholder={'待处理\n处理中\n已解决'}
															/>
														</div>
														<label className="flex items-start gap-2 self-end pb-2 text-sm">
															<input
																type="checkbox"
																className="mt-0.5 h-4 w-4"
																checked={editingCategoryAuthorCanSetStatus}
																onChange={(e) => setEditingCategoryAuthorCanSetStatus(e.target.checked)}
															/>
															<span>作者可修改状态</span>
														</label>
													</div>
													<div className="flex flex-wrap gap-4 text-sm">
														<label className="flex items-center gap-2">
															<input
																type="checkbox"
																className="h-4 w-4"
																checked={editingCategoryEnableCite}
																onChange={(e) => setEditingCategoryEnableCite(e.target.checked)}
															/>
															可引用他人
														</label>
														<label className="flex items-center gap-2">
															<input
																type="checkbox"
																className="h-4 w-4"
																checked={editingCategoryEnableCitedFrom}
																onChange={(e) => setEditingCategoryEnableCitedFrom(e.target.checked)}
															/>
															可被引用
														</label>
														<label className="flex items-center gap-2">
															<input
																type="checkbox"
																className="h-4 w-4"
																checked={editingCategoryEnableRelate}
																onChange={(e) => setEditingCategoryEnableRelate(e.target.checked)}
															/>
															启用关联
														</label>
													</div>
												</div>
											) : (
												<span>
													<span className="mr-2 inline-flex h-5 min-w-5 items-center justify-center rounded bg-muted px-1 text-[10px] text-muted-foreground">
														{idx + 1}
													</span>
													{c.name}
													{c.admin_only ? (
														<span className="ml-2 text-xs text-muted-foreground">仅管理员发帖</span>
													) : null}
													{c.show_on_site ? (
														<span className="ml-2 text-xs text-sky-700 dark:text-sky-300">官网</span>
													) : null}
													{c.show_on_site && c.subtitle ? (
														<span className="ml-2 text-xs text-muted-foreground">· {c.subtitle}</span>
													) : null}
													{c.show_on_forum === false || c.show_on_forum === 0 ? (
														<span className="ml-2 text-xs text-amber-700 dark:text-amber-300">社区隐藏</span>
													) : null}
													{Array.isArray(c.status_options) && c.status_options.length ? (
														<span className="ml-2 text-xs text-emerald-700 dark:text-emerald-300">
															状态 {c.status_options.length} 项
															{c.author_can_set_status ? ' · 作者可改' : ''}
														</span>
													) : null}
													{c.enable_cite ? (
														<span className="ml-2 text-xs text-violet-700 dark:text-violet-300">可引用</span>
													) : null}
													{c.enable_cited_from ? (
														<span className="ml-2 text-xs text-violet-700 dark:text-violet-300">可被引</span>
													) : null}
													{c.enable_relate ? (
														<span className="ml-2 text-xs text-violet-700 dark:text-violet-300">关联</span>
													) : null}
												</span>
											)}
											<div className="flex shrink-0 items-center gap-2">
												{editingCategoryId === c.id ? (
													<>
														<Button variant="outline" size="sm" disabled={loading} onClick={() => updateCategory(c.id)}>
															保存
														</Button>
														<Button
															variant="outline"
															size="sm"
															disabled={loading}
															onClick={() => {
																setEditingCategoryId(null);
																setEditingCategoryName('');
																setEditingCategoryAdminOnly(false);
																setEditingCategoryShowOnSite(false);
																setEditingCategoryShowOnForum(true);
																setEditingCategorySubtitle('');
																setEditingCategoryStatusOptionsText('');
																setEditingCategoryAuthorCanSetStatus(false);
																setEditingCategoryEnableCite(false);
																setEditingCategoryEnableCitedFrom(false);
																setEditingCategoryEnableRelate(false);
															}}
														>
															取消
														</Button>
													</>
												) : (
													<>
														<Button
															variant="outline"
															size="sm"
															disabled={loading || idx === 0}
															onClick={() => void moveCategory(c.id, -1)}
															title="上移"
														>
															<ArrowUp className="h-4 w-4" />
															<span className="sr-only">上移</span>
														</Button>
														<Button
															variant="outline"
															size="sm"
															disabled={loading || idx === arr.length - 1}
															onClick={() => void moveCategory(c.id, 1)}
															title="下移"
														>
															<ArrowDown className="h-4 w-4" />
															<span className="sr-only">下移</span>
														</Button>
														<Button
															variant="outline"
															size="sm"
															onClick={() => {
																setEditingCategoryId(c.id);
																setEditingCategoryName(c.name);
																setEditingCategoryAdminOnly(!!c.admin_only);
																setEditingCategoryShowOnSite(!!c.show_on_site);
																setEditingCategoryShowOnForum(!(c.show_on_forum === false || c.show_on_forum === 0));
																setEditingCategorySubtitle(String(c.subtitle || ''));
																setEditingCategoryStatusOptionsText(statusOptionsToText(c.status_options));
																setEditingCategoryAuthorCanSetStatus(!!c.author_can_set_status);
																setEditingCategoryEnableCite(!!c.enable_cite);
																setEditingCategoryEnableCitedFrom(!!c.enable_cited_from);
																setEditingCategoryEnableRelate(!!c.enable_relate);
															}}
														>
															编辑
														</Button>
													</>
												)}
												<Button variant="destructive" size="sm" onClick={() => deleteCategory(c.id)}>
													删除
												</Button>
											</div>
										</div>
									))}
									{categories.length === 0 ? <div className="text-sm text-muted-foreground">暂无分类</div> : null}
								</div>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>发帖模板</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								<p className="text-sm text-muted-foreground">
									一个模板可绑定多个分类；用户发帖选中分类后可一键插入。
								</p>
								<div className="space-y-2">
									<Label htmlFor="tpl-name">模板名称</Label>
									<Input id="tpl-name" value={tplName} onChange={(e) => setTplName(e.target.value)} maxLength={40} />
								</div>
								<div className="space-y-2">
									<Label htmlFor="tpl-body">模板正文（Markdown）</Label>
									<Textarea id="tpl-body" rows={6} value={tplBody} onChange={(e) => setTplBody(e.target.value)} />
								</div>
								<div className="space-y-2">
									<Label>绑定分类（可多选）</Label>
									<div className="flex flex-wrap gap-3">
										{categories.map((c) => (
											<label key={c.id} className="flex items-center gap-2 text-sm">
												<input
													type="checkbox"
													className="h-4 w-4"
													checked={tplCategoryIds.includes(c.id)}
													onChange={() => toggleTplCategory(c.id)}
												/>
												{c.name}
											</label>
										))}
									</div>
								</div>
								<div className="flex flex-wrap gap-2">
									<Button type="button" onClick={() => void savePostTemplate()} disabled={loading || !tplName.trim()}>
										{editingTplId ? '保存模板' : '添加模板'}
									</Button>
									{editingTplId ? (
										<Button
											type="button"
											variant="outline"
											onClick={() => {
												setEditingTplId(null);
												setTplName('');
												setTplBody('');
												setTplCategoryIds([]);
											}}
										>
											取消编辑
										</Button>
									) : null}
								</div>
								{postTemplates.length ? (
									<ul className="divide-y rounded-md border">
										{postTemplates.map((t) => (
											<li key={t.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2 text-sm">
												<div className="min-w-0 space-y-1">
													<div className="font-medium">{t.name}</div>
													<div className="text-xs text-muted-foreground">
														{(t.category_ids || [])
															.map((id) => categories.find((c) => c.id === id)?.name || `#${id}`)
															.join('、') || '未绑定分类'}
													</div>
												</div>
												<div className="flex gap-2">
													<Button
														type="button"
														variant="outline"
														size="sm"
														onClick={() => {
															setEditingTplId(t.id);
															setTplName(t.name);
															setTplBody(t.body || '');
															setTplCategoryIds(Array.isArray(t.category_ids) ? t.category_ids : []);
														}}
													>
														编辑
													</Button>
													<Button type="button" variant="destructive" size="sm" onClick={() => void deletePostTemplate(t.id)}>
														删除
													</Button>
												</div>
											</li>
										))}
									</ul>
								) : (
									<p className="text-sm text-muted-foreground">暂无模板。</p>
								)}
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>用户管理</CardTitle>
							</CardHeader>
							<CardContent className="space-y-3">
								<div className="overflow-x-auto rounded-md border">
									<table className="w-full text-sm">
										<thead className="bg-muted/30 text-left">
											<tr>
												<th className="px-3 py-2">ID</th>
												<th className="px-3 py-2">用户名</th>
												<th className="px-3 py-2">邮箱</th>
												<th className="px-3 py-2">角色</th>
												<th className="px-3 py-2">已验证</th>
												<th className="px-3 py-2">冷却</th>
												<th className="px-3 py-2">操作</th>
											</tr>
										</thead>
										<tbody>
											{users.map((u) => (
												<tr key={u.id} className="border-t">
													<td className="px-3 py-2">{u.id}</td>
													<td className="px-3 py-2">
														<span className="inline-flex items-center gap-2">
															{u.avatar_url ? (
																<img
																	src={u.avatar_url}
																	alt=""
																	className="h-6 w-6 rounded-full object-cover"
																	loading="lazy"
																	referrerPolicy="no-referrer"
																/>
															) : (
																<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
																	<UserIcon className="h-4 w-4" />
																</span>
															)}
															<span>{u.username}</span>
															{u.role === 'admin' ? (
																<span className="inline-flex items-center gap-1 rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
																	<Shield className="h-3 w-3" />
																	<span className="sr-only">管理员</span>
																</span>
															) : null}
														</span>
													</td>
													<td className="px-3 py-2">{u.email}</td>
													<td className="px-3 py-2">{u.role}</td>
													<td className="px-3 py-2">{u.verified ? '是' : '否'}</td>
													<td className="px-3 py-2">
														{cooldownActive(u.posting_cooldown_until) ? (
															<span className="text-xs text-amber-700 dark:text-amber-400" title={String(u.posting_cooldown_until)}>
																冷却中
															</span>
														) : (
															<span className="text-xs text-muted-foreground">—</span>
														)}
													</td>
													<td className="px-3 py-2">
														<div className="flex flex-wrap gap-2">
															<Button
																variant="outline"
																size="sm"
																className="border-sky-500 text-sky-700 hover:bg-sky-50 hover:text-sky-800 dark:text-sky-400 dark:hover:bg-sky-950/40"
																onClick={() => openEdit(u)}
															>
																编辑
															</Button>
															{cooldownActive(u.posting_cooldown_until) ? (
																<Button
																	variant="outline"
																	size="sm"
																	className="border-amber-500 text-amber-800 hover:bg-amber-50 hover:text-amber-900 dark:text-amber-400 dark:hover:bg-amber-950/40"
																	onClick={() => void clearCooldown(u.id)}
																>
																	解除冷却
																</Button>
															) : null}
															{!u.verified ? (
																<>
																	<Button
																		variant="outline"
																		size="sm"
																		className="border-emerald-500 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
																		onClick={() => manualVerify(u.id)}
																	>
																		验证
																	</Button>
																	<Button
																		variant="outline"
																		size="sm"
																		className="border-amber-500 text-amber-800 hover:bg-amber-50 hover:text-amber-900 dark:text-amber-400 dark:hover:bg-amber-950/40"
																		onClick={() => resendEmail(u.id)}
																	>
																		重发
																	</Button>
																</>
															) : null}
															{user?.id !== u.id ? (
																<Button variant="destructive" size="sm" onClick={() => deleteUser(u.id)}>
																	删除
																</Button>
															) : null}
														</div>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</CardContent>
						</Card>

						<Dialog
							open={editOpen}
							onOpenChange={(open) => {
								setEditOpen(open);
								if (!open) setEditError('');
							}}
						>
							<DialogContent>
								<DialogHeader>
									<DialogTitle>编辑用户</DialogTitle>
									<DialogDescription>修改用户名/邮箱/头像/密码</DialogDescription>
								</DialogHeader>
								{editError ? (
									<div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">{editError}</div>
								) : null}
								<div className="grid gap-4 py-4">
									<div className="grid gap-2">
										<Label htmlFor="edit-username">用户名</Label>
										<Input id="edit-username" value={editUsername} onChange={(e) => setEditUsername(e.target.value)} maxLength={20} />
									</div>
									<div className="grid gap-2">
										<Label htmlFor="edit-email">邮箱</Label>
										<Input id="edit-email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} type="email" />
									</div>
									<div className="grid gap-2">
										<Label htmlFor="edit-avatar">头像 URL</Label>
										<Input
											id="edit-avatar"
											value={editAvatarUrl}
											onChange={(e) => {
												setEditAvatarUrl(e.target.value);
												setEditAvatarIsDataUri(false);
											}}
											placeholder={editAvatarIsDataUri ? '当前为内嵌默认头像，保存后会迁移到图床' : 'https://... 或 /r2/...，留空用默认头像'}
										/>
										{editAvatarIsDataUri ? (
											<p className="text-xs text-muted-foreground">检测到旧版内嵌头像，保存时会自动上传到 R2。</p>
										) : null}
									</div>
									<div className="grid gap-2">
										<Label htmlFor="edit-password">新密码 (8-16 字符，留空不变)</Label>
										<Input
											id="edit-password"
											type="password"
											autoComplete="new-password"
											value={editPassword}
											onChange={(e) => setEditPassword(e.target.value)}
										/>
									</div>
								</div>
								<DialogFooter>
									<Button variant="outline" onClick={() => setEditOpen(false)}>
										取消
									</Button>
									<Button onClick={saveEdit} disabled={loading}>
										{loading ? '保存中...' : '保存'}
									</Button>
								</DialogFooter>
							</DialogContent>
						</Dialog>
					</>
				)}
			</div>
		</PageShell>
	);
}
