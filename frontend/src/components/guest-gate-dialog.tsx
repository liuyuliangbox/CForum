import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from '@/components/ui/dialog';
import { authUrl } from '@/lib/guest-interest';

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

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !hard) onDismissSoft?.();
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
				className="max-w-md"
			>
				<DialogHeader>
					<DialogTitle>继续浏览社区需要登录</DialogTitle>
					<DialogDescription>
						注册后可跟进反馈进度、参与讨论，并发布你的体验与建议。
					</DialogDescription>
				</DialogHeader>
				<DialogFooter className="gap-2 sm:gap-2">
					{hard ? null : (
						<Button type="button" variant="ghost" onClick={() => onDismissSoft?.()}>
							稍后再看
						</Button>
					)}
					<Button asChild variant="outline">
						<a href={loginHref}>已有账号登录</a>
					</Button>
					<Button asChild>
						<a href={registerHref}>免费注册</a>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
