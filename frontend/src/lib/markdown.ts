import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { highlightElement } from '@speed-highlight/core';

/** 渲染侧只拦危险协议；域名白名单在写入时由后端审查（管理员豁免）。 */
function isSafeRenderableUrl(raw: string): boolean {
	const value = String(raw || '').trim();
	if (!value) return false;
	if (value.startsWith('/') && !value.startsWith('//')) return true;
	if (value.startsWith('#')) return true;
	if (/^(javascript|vbscript|data):/i.test(value)) return false;
	if (/^https?:\/\//i.test(value)) return true;
	return false;
}

function escapeHtml(text: string) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function normalizeLang(lang: string) {
	const raw = (lang || '').trim().toLowerCase();
	const first = raw.split(/\s+/)[0] || '';
	if (!first) return 'plain';
	if (first === 'javascript' || first === 'js') return 'js';
	if (first === 'typescript' || first === 'ts') return 'ts';
	if (first === 'python' || first === 'py') return 'py';
	if (first === 'rust' || first === 'rs') return 'rs';
	if (first === 'golang' || first === 'go') return 'go';
	if (first === 'shell' || first === 'sh' || first === 'bash') return 'bash';
	if (first === 'md' || first === 'markdown') return 'md';
	if (first === 'yml') return 'yaml';
	return first;
}

const renderer = new marked.Renderer();
renderer.code = (({ text, lang }: { text: string; lang?: string }) => {
	const normalized = normalizeLang(lang || '');
	return `<div class="shj-lang-${normalized}">${escapeHtml(text)}</div>`;
}) as any;
renderer.codespan = (({ text }: { text: string }) => {
	return `<code class="shj-inline">${escapeHtml(text)}</code>`;
}) as any;
renderer.image = (({ href, title, text }: { href: string; title?: string | null; text: string }) => {
	let resolved = href || '';
	if (resolved && !/^https?:\/\//i.test(resolved) && !resolved.startsWith('/') && !resolved.startsWith('data:')) {
		resolved = `/r2/${resolved.replace(/^\/+/, '')}`;
	}
	if (!isSafeRenderableUrl(resolved)) {
		return `<span>${escapeHtml(text || resolved)}</span>`;
	}
	const src = escapeHtml(resolved);
	const alt = escapeHtml(text || '');
	const caption = escapeHtml(title || text || '');
	const captionAttr = caption ? ` data-caption="${caption}"` : '';
	if (!src) return '';
	return `<a href="${src}" data-fancybox="gallery"${captionAttr}><img src="${src}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer" /></a>`;
}) as any;
renderer.link = (({ href, title, text }: { href: string; title?: string | null; text: string }) => {
	const label = escapeHtml(text || href || '');
	if (!href || !isSafeRenderableUrl(href)) {
		return `<span>${label}</span>`;
	}
	const safeHref = escapeHtml(href);
	const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
	return `<a href="${safeHref}"${titleAttr} rel="noopener noreferrer">${label}</a>`;
}) as any;
marked.use({ renderer });

export function renderMarkdownToHtml(markdown: string) {
	const windowLike = window as unknown as Window;
	const DOMPurify = createDOMPurify(windowLike);
	return DOMPurify.sanitize(marked.parse(markdown) as string, {
		ADD_ATTR: ['data-fancybox', 'data-caption', 'referrerpolicy']
	});
}

export function highlightCodeBlocks(root: ParentNode | null) {
	if (!root) return;
	const nodes = Array.from((root as any).querySelectorAll?.('[class*="shj-lang-"]') || []) as Element[];
	if (!nodes.length) return;
	void Promise.all(nodes.map((el) => highlightElement(el, undefined, undefined, { hideLineNumbers: true })));
}

export function attachFancybox(root: HTMLElement | null) {
	if (!root) return () => {};
	if (!root.querySelector('a[data-fancybox]')) return () => {};
	let cancelled = false;
	void import('@fancyapps/ui').then(({ Fancybox }) => {
		if (cancelled) return;
		Fancybox.bind(root, 'a[data-fancybox]', { groupAll: false });
	});
	return () => {
		cancelled = true;
		void import('@fancyapps/ui').then(({ Fancybox }) => {
			Fancybox.unbind(root, 'a[data-fancybox]');
		});
	};
}
