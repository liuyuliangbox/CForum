import * as React from 'react';
import { Timer } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiFetch, getSecurityHeaders } from '@/lib/api';
import { cn } from '@/lib/utils';

export const ADMIN_COOLDOWN_OPTIONS = [
	{ hours: 1, label: '1 小时' },
	{ hours: 24, label: '1 天' },
	{ hours: 168, label: '7 天' },
	{ hours: 8760, label: '365 天' }
] as const;

export async function adminSetUserCooldown(opts: {
	userId: number;
	hours: number;
	username?: string;
}): Promise<void> {
	const opt = ADMIN_COOLDOWN_OPTIONS.find((o) => o.hours === opts.hours);
	const label = opt?.label || `${opts.hours} 小时`;
	const name = opts.username || '该用户';
	if (!confirm(`确定将「${name}」发言冷却 ${label}？`)) return;
	await apiFetch(`/admin/users/${opts.userId}/cooldown`, {
		method: 'POST',
		headers: getSecurityHeaders('POST'),
		body: JSON.stringify({ hours: opts.hours })
	});
	alert(`已设置冷却：${label}`);
}

/** 帖子/评论管理菜单内嵌的冷却选项列表 */
export function AdminCooldownMenuItems({
	userId,
	username,
	disabled,
	onDone,
	className
}: {
	userId: number;
	username?: string;
	disabled?: boolean;
	onDone?: () => void;
	className?: string;
}) {
	return (
		<div className={cn(className)}>
			<div className="my-1 h-px bg-border" />
			<div className="px-2 py-1 text-xs font-medium text-muted-foreground">发言冷却</div>
			{ADMIN_COOLDOWN_OPTIONS.map((opt) => (
				<button
					key={opt.hours}
					type="button"
					disabled={disabled}
					className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
					onClick={() => {
						void adminSetUserCooldown({ userId, hours: opt.hours, username })
							.then(() => onDone?.())
							.catch((e: any) => alert(String(e?.message || e)));
					}}
				>
					<Timer className="h-4 w-4" />
					{opt.label}
				</button>
			))}
		</div>
	);
}

/** 评论行用的紧凑下拉 */
export function AdminCooldownTrigger({
	userId,
	username,
	className
}: {
	userId: number;
	username?: string;
	className?: string;
}) {
	const [open, setOpen] = React.useState(false);
	const ref = React.useRef<HTMLDivElement | null>(null);

	React.useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent | TouchEvent) => {
			const el = ref.current;
			if (!el) return;
			if (e.target instanceof Node && !el.contains(e.target)) setOpen(false);
		};
		document.addEventListener('mousedown', onDoc);
		document.addEventListener('touchstart', onDoc);
		return () => {
			document.removeEventListener('mousedown', onDoc);
			document.removeEventListener('touchstart', onDoc);
		};
	}, [open]);

	return (
		<div className={cn('relative', className)} ref={ref}>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				title="发言冷却"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
			>
				<Timer className="h-4 w-4" />
				<span className="sr-only">发言冷却</span>
			</Button>
			{open ? (
				<div className="absolute right-0 top-full z-[60] mt-1 w-36 overflow-hidden rounded-md border bg-background p-1 shadow-lg">
					{ADMIN_COOLDOWN_OPTIONS.map((opt) => (
						<button
							key={opt.hours}
							type="button"
							className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
							onClick={() => {
								void adminSetUserCooldown({ userId, hours: opt.hours, username })
									.then(() => setOpen(false))
									.catch((e: any) => alert(String(e?.message || e)));
							}}
						>
							{opt.label}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
