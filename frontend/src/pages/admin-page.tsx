import * as React from 'react';
import { RefreshCw, Shield, User as UserIcon } from 'lucide-react';

import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { apiFetch, getSecurityHeaders, type Category } from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';

export function AdminPage() {
	const token = getToken();
	const user = React.useMemo(() => getUser(), [token]);
	const isAdmin = user?.role === 'admin';
	const [error, setError] = React.useState('');
	const [loading, setLoading] = React.useState(false);

	const [stats, setStats] = React.useState<{ users: number; posts: number; comments: number } | null>(null);
	const [users, setUsers] = React.useState<
		Array<{ id: number; email: string; username: string; role: string; verified: number; created_at: string; avatar_url?: string | null }>
	>([]);
	const [categories, setCategories] = React.useState<Category[]>([]);
	const [systemSettings, setSystemSettings] = React.useState({
		turnstile_enabled: false,
		notify_on_user_delete: false,
		notify_on_username_change: false,
		notify_on_avatar_change: false,
		notify_on_manual_verify: false,
		site_title: 'liuyuliangbox / Project Turn',
		site_tagline: '由 Cloudflare Workers、Pages、D1、R2 提供服务。'
	});

	const [newCategoryName, setNewCategoryName] = React.useState('');
	const [newCategoryAdminOnly, setNewCategoryAdminOnly] = React.useState(false);
	const [newCategoryShowOnSite, setNewCategoryShowOnSite] = React.useState(false);
	const [newCategoryShowOnForum, setNewCategoryShowOnForum] = React.useState(true);
	const [editingCategoryId, setEditingCategoryId] = React.useState<number | null>(null);
	const [editingCategoryName, setEditingCategoryName] = React.useState('');
	const [editingCategoryAdminOnly, setEditingCategoryAdminOnly] = React.useState(false);
	const [editingCategoryShowOnSite, setEditingCategoryShowOnSite] = React.useState(false);
	const [editingCategoryShowOnForum, setEditingCategoryShowOnForum] = React.useState(true);

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
			const [s, u, c, settings] = await Promise.all([
				apiFetch<{ users: number; posts: number; comments: number }>('/admin/stats', { headers: getSecurityHeaders('GET') }),
				apiFetch<any[]>('/admin/users', { headers: getSecurityHeaders('GET') }),
				apiFetch<Category[]>('/categories'),
				apiFetch<any>('/admin/settings', { headers: getSecurityHeaders('GET') })
			]);
			setStats(s);
			setUsers(u as any);
			setCategories(c);
			setSystemSettings({
				turnstile_enabled: !!settings.turnstile_enabled,
				notify_on_user_delete: !!settings.notify_on_user_delete,
				notify_on_username_change: !!settings.notify_on_username_change,
				notify_on_avatar_change: !!settings.notify_on_avatar_change,
				notify_on_manual_verify: !!settings.notify_on_manual_verify,
				site_title: settings.site_title || 'liuyuliangbox / Project Turn',
				site_tagline: settings.site_tagline || '由 Cloudflare Workers、Pages、D1、R2 提供服务。'
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
			await apiFetch('/admin/settings', {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify(systemSettings)
			});
			alert('设置已保存');
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
					show_on_forum: newCategoryShowOnForum
				})
			});
			setNewCategoryName('');
			setNewCategoryAdminOnly(false);
			setNewCategoryShowOnSite(false);
			setNewCategoryShowOnForum(true);
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
					show_on_forum: editingCategoryShowOnForum
				})
			});
			setEditingCategoryId(null);
			setEditingCategoryName('');
			setEditingCategoryAdminOnly(false);
			setEditingCategoryShowOnSite(false);
			setEditingCategoryShowOnForum(true);
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

	return (
		<PageShell>
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
								<div className="grid gap-3 sm:grid-cols-2">
									<div className="space-y-2">
										<Label htmlFor="site-title">站点标题</Label>
										<Input
											id="site-title"
											value={systemSettings.site_title}
											onChange={(e) => setSystemSettings((s) => ({ ...s, site_title: e.target.value }))}
											maxLength={80}
										/>
									</div>
									<div className="space-y-2">
										<Label htmlFor="site-tagline">副标题</Label>
										<Input
											id="site-tagline"
											value={systemSettings.site_tagline}
											onChange={(e) => setSystemSettings((s) => ({ ...s, site_tagline: e.target.value }))}
											maxLength={160}
										/>
									</div>
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
								</div>
								<Button onClick={saveSettings} disabled={loading}>
									{loading ? '保存中...' : '保存设置'}
								</Button>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>分类管理</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
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
											onChange={(e) => setNewCategoryShowOnSite(e.target.checked)}
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
										论坛展示
									</label>
									<Button onClick={createCategory} disabled={loading}>
										添加
									</Button>
								</div>
								<div className="space-y-2">
									{categories.map((c) => (
										<div key={c.id} className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
											{editingCategoryId === c.id ? (
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
															onChange={(e) => setEditingCategoryShowOnSite(e.target.checked)}
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
														论坛展示
													</label>
												</div>
											) : (
												<span>
													{c.name}
													{c.admin_only ? (
														<span className="ml-2 text-xs text-muted-foreground">仅管理员发帖</span>
													) : null}
													{c.show_on_site ? (
														<span className="ml-2 text-xs text-sky-700 dark:text-sky-300">官网</span>
													) : null}
													{c.show_on_forum === false || c.show_on_forum === 0 ? (
														<span className="ml-2 text-xs text-amber-700 dark:text-amber-300">论坛隐藏</span>
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
															}}
														>
															取消
														</Button>
													</>
												) : (
													<Button
														variant="outline"
														size="sm"
														onClick={() => {
															setEditingCategoryId(c.id);
															setEditingCategoryName(c.name);
															setEditingCategoryAdminOnly(!!c.admin_only);
															setEditingCategoryShowOnSite(!!c.show_on_site);
															setEditingCategoryShowOnForum(!(c.show_on_forum === false || c.show_on_forum === 0));
														}}
													>
														编辑
													</Button>
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
														<div className="flex flex-wrap gap-2">
															<Button
																variant="outline"
																size="sm"
																className="border-sky-500 text-sky-700 hover:bg-sky-50 hover:text-sky-800 dark:text-sky-400 dark:hover:bg-sky-950/40"
																onClick={() => openEdit(u)}
															>
																编辑
															</Button>
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
