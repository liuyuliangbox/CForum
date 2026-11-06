import * as React from 'react';

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { authUrl } from '@/lib/guest-interest';
import { cn } from '@/lib/utils';

export function GuestGateDialog({
	mode,
	open,
	nextPath,
	onDismissSoft
}: {
	mode: 'soft' | 'hard';
	open: boolean;
	nextPath?: string;
	onDismissSoft?: () => void;
}) {
	const registerHref = authUrl('register', nextPath);
	const loginHref = authUrl('login', nextPath);
	const hard = mode === 'hard';
	const dismissedRef = React.useRef(false);

	React.useEffect(() => {
		if (open) dismissedRef.current = false;
	}, [open, mode]);

	function dismissOnce() {
		if (hard || dismissedRef.current) return;
		dismissedRef.current = true;
		onDismissSoft?.();
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) dismissOnce();
			}}
		>
			<DialogContent
				hideClose={hard}
				onPointerDownOutside={(e) => {
					if (hard) e.preventDefault();
				}}
				onEscapeKeyDown={(e) => {
					if (hard) e.preventDefault();
				}}
				className={cn(
					'max-w-md overflow-hidden border-0 p-0 shadow-2xl',
					'bg-gradient-to-br from-background via-background to-sky-500/10 dark:to-indigo-500/15'
				)}
			>
				<div
					className={cn(
						'h-1.5 w-full',
						hard
							? 'bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500'
							: 'bg-gradient-to-r from-cyan-500 via-sky-500 to-indigo-600'
					)}
					aria-hidden
				/>
				<div className="space-y-5 p-6 pt-5">
					<DialogHeader className="space-y-3 text-left">
						<p className="text-[11px] font-medium uppercase tracking-[0.18em] text-sky-700/80 dark:text-sky-300/80">
							{hard ? '继续探索' : '加入社区'}
						</p>
						<DialogTitle className="text-xl leading-snug sm:text-2xl">
							{hard ? '登录后继续浏览社区' : '看起来你对社区挺感兴趣'}
						</DialogTitle>
						<DialogDescription className="text-sm leading-relaxed text-muted-foreground">
							注册后可跟进反馈进度、参与讨论，并发布你的体验与建议。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
						<a
							href={registerHref}
							className="inline-flex h-11 w-full items-center justify-center rounded-md bg-gradient-to-r from-cyan-500 via-sky-500 to-indigo-600 text-sm font-semibold text-white shadow-md shadow-sky-500/25 transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"
						>
							免费注册
						</a>
						<a
							href={loginHref}
							className="inline-flex h-11 w-full items-center justify-center rounded-md bg-gradient-to-r from-slate-800 to-slate-600 text-sm font-medium text-white shadow-md shadow-slate-900/20 transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/50 dark:from-slate-200 dark:to-slate-400 dark:text-slate-900 dark:shadow-none"
						>
							已有账号登录
						</a>
						{hard ? null : (
							<button
								type="button"
								onClick={dismissOnce}
								className="inline-flex h-10 w-full items-center justify-center rounded-md text-sm text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
							>
								稍后再看
							</button>
						)}
					</DialogFooter>
				</div>
			</DialogContent>
		</Dialog>
	);
}
