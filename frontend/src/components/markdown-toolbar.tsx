import * as React from 'react';
import {
	Bold,
	Code,
	Eye,
	EyeOff,
	FileCode2,
	Heading2,
	Heading3,
	Image as ImageIcon,
	IndentDecrease,
	IndentIncrease,
	List,
	ListOrdered,
	Quote,
	Sigma,
	Strikethrough,
	Table,
	Underline
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { MarkdownEditorAction } from '@/lib/markdown-editor';
import { cn } from '@/lib/utils';

type ToolbarItem = {
	action?: MarkdownEditorAction;
	label: string;
	title: string;
	icon: React.ReactNode;
	adminOnly?: boolean;
	kind?: 'action' | 'image' | 'preview';
};

const ITEMS: ToolbarItem[] = [
	{ action: 'bold', label: '粗体', title: '粗体 (Ctrl+B)', icon: <Bold className="h-4 w-4" /> },
	{ action: 'strike', label: '删除线', title: '删除线 (Alt+Shift+5)', icon: <Strikethrough className="h-4 w-4" /> },
	{ action: 'h2', label: 'H2', title: '二级标题 (Ctrl+2)', icon: <Heading2 className="h-4 w-4" /> },
	{ action: 'h3', label: 'H3', title: '三级标题 (Ctrl+3)', icon: <Heading3 className="h-4 w-4" /> },
	{ action: 'quote', label: '引用', title: '引用 (Ctrl+Shift+Q)', icon: <Quote className="h-4 w-4" /> },
	{ action: 'ul', label: '无序列表', title: '无序列表 (Ctrl+Shift+])', icon: <List className="h-4 w-4" /> },
	{ action: 'ol', label: '有序列表', title: '有序列表 (Ctrl+Shift+[)', icon: <ListOrdered className="h-4 w-4" /> },
	{ action: 'outdent', label: '减少缩进', title: '减少缩进 (Ctrl+[)', icon: <IndentDecrease className="h-4 w-4" /> },
	{ action: 'indent', label: '增加缩进', title: '增加缩进 (Ctrl+])', icon: <IndentIncrease className="h-4 w-4" /> },
	{ kind: 'image', label: '图片', title: '上传图片', icon: <ImageIcon className="h-4 w-4" /> },
	{ action: 'underline', label: '下划线', title: '下划线 (Ctrl+U)', icon: <Underline className="h-4 w-4" />, adminOnly: true },
	{ action: 'inlineCode', label: '行内代码', title: '行内代码 (Ctrl+Shift+`)', icon: <Code className="h-4 w-4" />, adminOnly: true },
	{ action: 'codeBlock', label: '代码块', title: '代码块 (Ctrl+Shift+K)', icon: <FileCode2 className="h-4 w-4" />, adminOnly: true },
	{ action: 'table', label: '表格', title: '表格 (Ctrl+T)', icon: <Table className="h-4 w-4" />, adminOnly: true },
	{ action: 'formula', label: '公式', title: '公式 (Ctrl+Shift+M)', icon: <Sigma className="h-4 w-4" />, adminOnly: true }
];

export function MarkdownToolbar({
	isAdmin,
	previewOpen,
	onTogglePreview,
	onAction,
	onPickImage,
	className
}: {
	isAdmin: boolean;
	previewOpen: boolean;
	onTogglePreview: () => void;
	onAction: (action: MarkdownEditorAction) => void;
	onPickImage?: () => void;
	className?: string;
}) {
	const visible = ITEMS.filter((item) => !item.adminOnly || isAdmin);

	return (
		<div className={cn('flex flex-wrap items-center gap-1', className)}>
			{visible.map((item) => {
				if (item.kind === 'image') {
					if (!onPickImage) return null;
					return (
						<Button key="image" type="button" variant="outline" size="sm" title={item.title} onClick={onPickImage}>
							{item.icon}
							<span className="sr-only">{item.label}</span>
						</Button>
					);
				}
				return (
					<Button
						key={item.action}
						type="button"
						variant="outline"
						size="sm"
						title={item.title}
						onClick={() => item.action && onAction(item.action)}
					>
						{item.icon}
						<span className="sr-only">{item.label}</span>
					</Button>
				);
			})}
			<Button type="button" variant="outline" size="sm" title={previewOpen ? '关闭预览' : '打开预览'} onClick={onTogglePreview}>
				{previewOpen ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
				<span className="sr-only">{previewOpen ? '关闭预览' : '打开预览'}</span>
			</Button>
		</div>
	);
}
