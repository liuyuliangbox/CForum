import type * as React from 'react';

export type EditResult = { text: string; selectionStart: number; selectionEnd: number };

export function applyMarkdownEdit(
	text: string,
	start: number,
	end: number,
	transform: (text: string, start: number, end: number) => EditResult
): EditResult {
	return transform(text, start, end);
}

export function wrapSelection(text: string, start: number, end: number, prefix: string, suffix: string, placeholder: string): EditResult {
	const selected = text.slice(start, end) || placeholder;
	const next = text.slice(0, start) + prefix + selected + suffix + text.slice(end);
	const selectionStart = start + prefix.length;
	const selectionEnd = selectionStart + selected.length;
	return { text: next, selectionStart, selectionEnd };
}

export function wrapBlock(text: string, start: number, end: number, fence: string): EditResult {
	const selected = text.slice(start, end);
	const block = `${fence}\n${selected}\n${fence}`;
	const next = text.slice(0, start) + block + text.slice(end);
	const selectionStart = start + fence.length + 1;
	const selectionEnd = selectionStart + selected.length;
	return { text: next, selectionStart, selectionEnd };
}

export function transformLines(
	text: string,
	start: number,
	end: number,
	transform: (line: string, index: number, lines: string[]) => string
): EditResult {
	const lineStart = text.lastIndexOf('\n', start - 1) + 1;
	const lineEnd = text.indexOf('\n', end);
	const endIndex = lineEnd === -1 ? text.length : lineEnd;
	const segment = text.slice(lineStart, endIndex);
	const lines = segment.split('\n');
	const nextSegment = lines.map(transform).join('\n');
	const next = text.slice(0, lineStart) + nextSegment + text.slice(endIndex);
	return { text: next, selectionStart: lineStart, selectionEnd: lineStart + nextSegment.length };
}

export function setHeading(text: string, start: number, end: number, level: number): EditResult {
	return transformLines(text, start, end, (line) => {
		const cleaned = line.replace(/^\s{0,3}#{1,6}\s+/, '');
		if (level === 0) return cleaned;
		return `${'#'.repeat(level)} ${cleaned}`;
	});
}

export function toggleBlockquote(text: string, start: number, end: number): EditResult {
	return transformLines(text, start, end, (line) => (line.startsWith('> ') ? line.slice(2) : `> ${line}`));
}

export function toggleList(text: string, start: number, end: number, ordered: boolean): EditResult {
	return transformLines(text, start, end, (line, index) => {
		if (ordered) {
			if (/^\d+\.\s+/.test(line)) return line.replace(/^\d+\.\s+/, '');
			return `${index + 1}. ${line}`;
		}
		if (/^[-*+]\s+/.test(line)) return line.replace(/^[-*+]\s+/, '');
		return `- ${line}`;
	});
}

export function indentLines(text: string, start: number, end: number): EditResult {
	return transformLines(text, start, end, (line) => `  ${line}`);
}

export function outdentLines(text: string, start: number, end: number): EditResult {
	return transformLines(text, start, end, (line) => line.replace(/^(\t| {1,2})/, ''));
}

export function insertTable(text: string, start: number, end: number): EditResult {
	const table = `| Header | Header |\n| --- | --- |\n| Cell | Cell |`;
	const next = text.slice(0, start) + table + text.slice(end);
	const selectionStart = start + 2;
	const selectionEnd = selectionStart + 6;
	return { text: next, selectionStart, selectionEnd };
}

export type MarkdownEditorAction =
	| 'bold'
	| 'strike'
	| 'underline'
	| 'h2'
	| 'h3'
	| 'quote'
	| 'ul'
	| 'ol'
	| 'indent'
	| 'outdent'
	| 'inlineCode'
	| 'codeBlock'
	| 'table'
	| 'formula';

export function runMarkdownAction(text: string, start: number, end: number, action: MarkdownEditorAction): EditResult {
	switch (action) {
		case 'bold':
			return wrapSelection(text, start, end, '**', '**', 'text');
		case 'strike':
			return wrapSelection(text, start, end, '~~', '~~', 'text');
		case 'underline':
			return wrapSelection(text, start, end, '<u>', '</u>', 'text');
		case 'h2':
			return setHeading(text, start, end, 2);
		case 'h3':
			return setHeading(text, start, end, 3);
		case 'quote':
			return toggleBlockquote(text, start, end);
		case 'ul':
			return toggleList(text, start, end, false);
		case 'ol':
			return toggleList(text, start, end, true);
		case 'indent':
			return indentLines(text, start, end);
		case 'outdent':
			return outdentLines(text, start, end);
		case 'inlineCode':
			return wrapSelection(text, start, end, '`', '`', 'code');
		case 'codeBlock':
			return wrapBlock(text, start, end, '```');
		case 'table':
			return insertTable(text, start, end);
		case 'formula':
			return wrapBlock(text, start, end, '$$');
		default:
			return { text, selectionStart: start, selectionEnd: end };
	}
}

export function handleMarkdownEditorKeyDown(
	e: React.KeyboardEvent<HTMLTextAreaElement>,
	opts: {
		isAdmin: boolean;
		text: string;
		apply: (result: EditResult) => void;
	}
) {
	const el = e.currentTarget;
	const start = el.selectionStart;
	const end = el.selectionEnd;
	const { isAdmin, text, apply } = opts;
	const shift = e.shiftKey;

	const run = (action: MarkdownEditorAction) => {
		e.preventDefault();
		apply(runMarkdownAction(text, start, end, action));
	};

	// 删除线：Alt+Shift+5（不依赖 Ctrl）
	if (e.altKey && shift && e.code === 'Digit5') {
		run('strike');
		return;
	}

	const isMod = e.ctrlKey || e.metaKey;
	if (!isMod) return;
	const key = e.key.toLowerCase();

	if (!shift && key === 'b') {
		run('bold');
		return;
	}
	if (!shift && key === 'u') {
		if (!isAdmin) return;
		run('underline');
		return;
	}
	if (!shift && key === 't') {
		if (!isAdmin) return;
		run('table');
		return;
	}
	if (!shift && key === '2') {
		run('h2');
		return;
	}
	if (!shift && key === '3') {
		run('h3');
		return;
	}
	if (shift && key === 'k') {
		if (!isAdmin) return;
		run('codeBlock');
		return;
	}
	if (shift && key === 'm') {
		if (!isAdmin) return;
		run('formula');
		return;
	}
	if (shift && key === 'q') {
		run('quote');
		return;
	}
	if (shift && key === '[') {
		run('ol');
		return;
	}
	if (shift && key === ']') {
		run('ul');
		return;
	}
	if (!shift && key === '[') {
		run('outdent');
		return;
	}
	if (!shift && key === ']') {
		run('indent');
		return;
	}
	if (shift && (e.code === 'Backquote' || key === '`')) {
		if (!isAdmin) return;
		run('inlineCode');
	}
}
