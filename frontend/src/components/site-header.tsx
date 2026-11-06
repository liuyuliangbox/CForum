import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { apiFetch, getSecurityHeaders } from '@/lib/api';
import { getUser, logout, setUser, type User } from '@/lib/auth';
import { getTheme, toggleTheme, type Theme } from '@/lib/theme';
import { Home, LogIn, LogOut, Moon, Settings, Shield, Sun, User as UserIcon, UserPlus } from 'lucide-react';

export function SiteHeader({
	currentUser,
	onLogout
}: {
	currentUser: User | null;
	onLogout?: () => void;
}) {
	const user = currentUser ?? getUser();
	const [theme, setTheme] = React.useState<Theme>(() => getTheme());
	const [adminHref, setAdminHref] = React.useState(user?.admin_panel_path || '');

	React.useEffect(() => {
		function onThemeChange(e: Event) {
			const next = (e as CustomEvent).detail;
			if (next === 'light' || next === 'dark') setTheme(next);
		}
		window.addEventListener('theme-change', onThemeChange as any);
		setTheme(getTheme());
		return () => window.removeEventListener('theme-change', onThemeChange as any);
	}, []);

	React.useEffect(() => {
		if (!user || user.role !== 'admin') {
			setAdminHref('');
			return;
		}
		if (user.admin_panel_path) {
			setAdminHref(user.admin_panel_path);
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const data = await apiFetch<{ path: string }>('/admin/entry', {
					headers: getSecurityHeaders('GET')
				});
				if (cancelled || !data?.path) return;
				setAdminHref(data.path);
				const latest = getUser();
				if (latest && latest.id === user.id) {
					setUser({ ...latest, admin_panel_path: data.path });
				}
			} catch {
				/* ignore — link stays hidden if path unavailable */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [user?.id, user?.role, user?.admin_panel_path]);

	return (
		<header className="w-full border-b bg-background">
			<div className="mx-auto flex max-w-5xl items-center gap-1.5 px-3 py-3 sm:gap-3 sm:px-4 sm:py-4">
				<a
					href="/"
					className="inline-flex shrink-0 items-center justify-center rounded-md border border-transparent p-2 text-foreground hover:bg-muted/40"
				>
					<Home className="h-5 w-5" />
					<span className="sr-only">主页</span>
				</a>

				{user ? (
					<span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">
						{user.avatar_url ? (
							<img
								src={user.avatar_url}
								alt=""
								className="h-7 w-7 shrink-0 rounded-full object-cover"
								loading="lazy"
								referrerPolicy="no-referrer"
							/>
						) : (
							<span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
								<UserIcon className="h-4 w-4" />
							</span>
						)}
						<span className="min-w-0 truncate" title={user.username}>
							<span className="hidden sm:inline">欢迎，</span>
							<span className="text-foreground">{user.username}</span>
						</span>
						{user.role === 'admin' ? (
							<span className="inline-flex shrink-0 items-center gap-1 rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300 sm:px-2">
								<Shield className="h-3 w-3" />
								<span className="sr-only">管理员</span>
							</span>
						) : null}
					</span>
				) : (
					<span className="min-w-0 flex-1" aria-hidden />
				)}

				<div className="flex shrink-0 items-center gap-0.5 sm:gap-2">
					<Button type="button" variant="ghost" size="sm" onClick={toggleTheme}>
						{theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
						<span className="sr-only">切换主题</span>
					</Button>
					{user ? (
						<>
							{user.role === 'admin' && adminHref ? (
								<Button asChild variant="ghost" size="sm">
									<a href={adminHref} rel="nofollow">
										<Shield className="h-4 w-4" />
										<span className="sr-only">管理后台</span>
									</a>
								</Button>
							) : null}
							<Button asChild variant="ghost" size="sm">
								<a href="/settings">
									<Settings className="h-4 w-4" />
									<span className="sr-only">设置</span>
								</a>
							</Button>
							<Separator orientation="vertical" className="mx-0.5 hidden h-6 sm:block" />
							<Button
								variant="destructive"
								size="sm"
								onClick={() => {
									logout();
									onLogout?.();
									window.location.href = '/';
								}}
							>
								<LogOut className="h-4 w-4" />
								<span className="sr-only">退出</span>
							</Button>
						</>
					) : (
						<>
							<Button asChild variant="ghost" size="sm">
								<a href="/login">
									<LogIn className="h-4 w-4" />
									<span className="sr-only">登录</span>
								</a>
							</Button>
							<Button asChild size="sm">
								<a href="/register">
									<UserPlus className="h-4 w-4" />
									<span className="sr-only">注册</span>
								</a>
							</Button>
						</>
					)}
				</div>
			</div>
		</header>
	);
}
