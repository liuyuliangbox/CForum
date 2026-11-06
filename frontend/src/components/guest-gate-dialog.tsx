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
				className="max-w-md gap-0 overflow-hidden border border-border/80 bg-background p-0 shadow-lg"
			>
				<div
					className={cn(
						'h-1 w-full',
						hard
							? 'bg-gradient-to-r from-amber-400 via-orange-400 to-rose-400'
							: 'bg-gradient-to-r from-cyan-400 via-sky-500 to-indigo-500'
					)}
					aria-hidden
				/>
				<div className="space-y-5 bg-background p-6 pt-5">
					<DialogHeader className="space-y-2 text-left">
						<p
							className={cn(
								'text-[11px] font-medium tracking-[0.16em]',
								hard ? 'text-orange-600 dark:text-orange-300' : 'text-sky-600 dark:text-sky-300'
							)}
						>
							{hard ? '继续探索' : '加入社区'}
						</p>
						<DialogTitle className="text-xl leading-snug tracking-tight sm:text-2xl">
							{hard ? '登录后继续浏览社区' : '看起来你对社区挺感兴趣'}
						</DialogTitle>
						<DialogDescription className="text-sm leading-relaxed text-muted-foreground">
							注册后可跟进反馈进度、参与讨论，并发布你的体验与建议。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="flex flex-col gap-2.5 space-x-0 sm:flex-col sm:space-x-0">
						<a
							href={registerHref}
							className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-gradient-to-r from-cyan-500 via-sky-500 to-indigo-600 text-sm font-semibold text-white transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50"
						>
							免费注册
						</a>
						<a
							href={loginHref}
							className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-sky-500/30 bg-gradient-to-r from-sky-500/10 to-indigo-500/10 text-sm font-medium text-sky-800 transition hover:from-sky-500/15 hover:to-indigo-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40 dark:text-sky-100"
						>
							已有账号登录
						</a>
						{hard ? null : (
							<button
								type="button"
								onClick={dismissOnce}
								className="inline-flex h-10 w-full items-center justify-center rounded-lg text-sm text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
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
