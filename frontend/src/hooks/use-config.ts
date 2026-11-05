import * as React from 'react';

import type { ForumConfig } from '@/lib/api';

type ConfigState = {
	config: ForumConfig | null;
	error: string;
};

let cached: ConfigState | null = null;
let inflight: Promise<ConfigState> | null = null;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

async function loadConfig(): Promise<ConfigState> {
	if (cached) return cached;
	if (inflight) return inflight;

	inflight = (async () => {
		try {
			const res = await fetch('/api/config');
			if (!res.ok) throw new Error('无法加载站点配置');
			const data = (await res.json()) as ForumConfig;
			cached = { config: data, error: '' };
		} catch (e: any) {
			cached = { config: null, error: String(e?.message || e) };
		} finally {
			inflight = null;
			emit();
		}
		return cached!;
	})();

	return inflight;
}

/** Drop cache (e.g. after admin saves site settings). Next useConfig() will refetch once. */
export function invalidateConfigCache() {
	cached = null;
	inflight = null;
	emit();
}

export function useConfig() {
	const [state, setState] = React.useState<ConfigState>(() => cached || { config: null, error: '' });

	React.useEffect(() => {
		const sync = () => setState(cached || { config: null, error: '' });
		listeners.add(sync);
		void loadConfig().then(sync);
		return () => {
			listeners.delete(sync);
		};
	}, []);

	return state;
}
