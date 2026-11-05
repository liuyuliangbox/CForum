export function parseStatusOptions(raw: unknown): string[] {
	let list: unknown = raw;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) return [];
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
	if (!Array.isArray(list)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of list) {
		const s = String(item || '')
			.trim()
			.slice(0, 32);
		if (!s || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out.slice(0, 20);
}

export function serializeStatusOptions(raw: unknown): string {
	return JSON.stringify(parseStatusOptions(raw));
}

export function defaultStatusForOptions(options: string[]): string | null {
	return options.length ? options[0] : null;
}

export function isValidStatusForOptions(status: string | null | undefined, options: string[]): boolean {
	if (!options.length) return status == null || status === '';
	if (status == null || status === '') return false;
	return options.includes(status);
}

export const DEFAULT_OPS_PLAYBOOK = `【研发日志】
- 建议周更或双周更「开发进度」栏目，保持节奏可预期。
- 重要节点可同步官网精选。

【FAQ 置顶】
- 每测一版更新置顶 FAQ：已知问题、计划改动、反馈入口。
- 减少重复 Bug 帖，让玩家感到官方在听。

【低门槛活动】
- 回帖类：「一句话形容本周战斗」「最想要的系统」。
- 征集类：配队 / 开荒 / 截图，汇总后置顶展示。

【构筑 / 配队】
- 可用发帖模板约定：职业、阵容、关键技能、截图。
- 优质构筑可官网精选或置顶。

【版块用法】
- Bug/体验、玩法建议：建议配置状态流转，便于跟进。
- 闲聊/招募：通常可不启用状态，避免干扰。
- 求资格 / 兑换码类内容尽量单独分类，避免污染主讨论。

【零回复】
- 可用「零评论」筛选巡查，及时轻回，避免新帖石沉大海。
`;
