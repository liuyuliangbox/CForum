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

/** Previous seed text (pre cite/relate docs). Used only to migrate untouched installs. */
export const LEGACY_OPS_PLAYBOOK = `【研发日志】
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

export const DEFAULT_OPS_PLAYBOOK = `# 运营备忘

给管理员自己看的提示（Markdown）。不会展示给普通用户。可随时在本页编辑补充。

---

## 日常节奏

### 研发日志
- 建议周更或双周更「开发进度」，节奏可预期。
- 重要节点可同步 **官网精选**。

### FAQ 置顶
- 每测一版更新置顶 FAQ：已知问题、计划改动、反馈入口。
- 减少重复 Bug，让玩家感到官方在听。

### 低门槛活动
- 回帖类：「一句话形容本周战斗」「最想要的系统」。
- 征集类：配队 / 开荒 / 截图，汇总后置顶展示。

### 构筑 / 配队
- 用 **发帖模板** 约定：职业、阵容、关键技能、截图。
- 优质内容可官网精选或置顶。

---

## 分类开关怎么用

在「分类管理」里按版块勾选，互不冲突，可组合。

### 帖子状态
- **状态列表**（一行一个）：空 = 不启用；有内容则发帖带默认第一项，详情可改。
- **作者可改状态**：适合问答「已解决」；Bug 流转一般只给管理员改。
- **进度邮件**：他人（通常是管理员）改状态时，会邮件通知作者（受系统设置「帖子状态变更时邮件通知作者」与用户「接收邮件通知」约束；作者自改不发）。
- **场景**：Bug/体验、玩法建议建议开；闲聊/招募通常关。

### 引用（出处，每帖最多 1 个）
- **可被引用**：源帖显示「引用发帖」；别人引用后本帖出现「被引用」列表。
- **可引用他人**：该分类发新帖时允许携带引用来源。
- **用法**：打开要当出处的帖 → 点「引用发帖」→ 写新帖发布（无需搜索）。
- **权限**：用户只能在发帖时带上引用；**仅管理员**可事后改 / 清除。
- **场景**：跟帖讨论、重复反馈指向正本、答疑挂官方说明。

### 关联（平级相关，最多 10 个）
- **启用关联**：本分类帖可参与「相关帖子」；**仅管理员**在枢纽帖上搜索管理。
- 两边都显示「相关帖子」（无向）。
- **场景**：活动规则 ↔ FAQ ↔ 报名；专题导航打包。不要和「引用」混用。

### 发帖模板
- 后台可建模板并 **多选绑定分类**；用户发帖选分类后可一键插入正文。
- **场景**：Bug 报告结构、构筑格式、活动投稿字段。

---

## 列表与巡查

### 零评论筛选
- 首页开「零评论」巡查新帖，及时轻回，避免石沉大海。

### 冷却与限流
- 管理员可在帖子 / 评论菜单对用户设发言冷却（不对管理员生效）。
- 命中敏感词或短时刷帖可能触发冷却；管理员可清除。

### 链接白名单
- 普通用户外链仅白名单域名；管理员发帖不受限。在本页「链接域名白名单」维护。

### 内容审查
- 敏感词对普通用户发帖 / 评论生效；管理员跳过。

---

## 版块建议（可按项目改）

| 版块倾向 | 状态 | 可被引用 | 可引用 | 关联 |
| --- | --- | --- | --- | --- |
| Bug / 体验 | 建议开 | 建议开 | 可选 | 汇总帖可开关联 |
| 玩法建议 | 建议开 | 建议开 | 可选 | 可选 |
| 公告 / FAQ | 通常关 | 建议开 | 关或开 | 建议开（当枢纽） |
| 闲聊 / 招募 | 关 | 按需 | 按需 | 通常关 |

求资格 / 兑换码尽量单独分类，避免污染主讨论。
`;
