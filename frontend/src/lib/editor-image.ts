import type { ClipboardEvent } from 'react';

import { getSecurityHeaders } from '@/lib/api';

/** Upload a post image via /api/upload. Throws Error with server message. */
export async function uploadPostImage(file: File): Promise<string> {
	if (!file.type.startsWith('image/')) throw new Error('仅支持图片文件');
	if (file.size > 2 * 1024 * 1024) throw new Error('文件过大 (最大 2MB)');
	const formData = new FormData();
	formData.append('file', file);
	formData.append('type', 'post');
	const res = await fetch('/api/upload', {
		method: 'POST',
		headers: getSecurityHeaders('POST', null),
		body: formData
	});
	const data = (await res.json()) as { error?: string; url?: string };
	if (!res.ok) throw new Error(data?.error || '上传失败');
	if (!data.url) throw new Error('上传失败');
	return data.url;
}

/** If clipboard paste contains an image, upload it and return markdown; otherwise null. */
export async function handleEditorImagePaste(
	e: ClipboardEvent<HTMLTextAreaElement>
): Promise<string | null> {
	const items = e.clipboardData?.items;
	if (!items?.length) return null;
	for (const item of Array.from(items)) {
		if (!item.type.startsWith('image/')) continue;
		const file = item.getAsFile();
		if (!file) continue;
		e.preventDefault();
		const url = await uploadPostImage(file);
		return `\n\n![](${url})\n\n`;
	}
	return null;
}
