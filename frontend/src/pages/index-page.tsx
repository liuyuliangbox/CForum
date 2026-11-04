import * as React from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Eye, EyeOff, Heart, MessageCircle, MoreVertical, Pin, RefreshCw, Search, Shield, Star, Trash2, User, X } from 'lucide-react';

import { TurnstileWidget } from '@/components/turnstile';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useConfig } from '@/hooks/use-config';
import { apiFetch, formatDate, getSecurityHeaders, type Category, type Post } from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { attachFancybox, highlightCodeBlocks, renderMarkdownToHtml } from '@/lib/markdown';
import { validateText } from '@/lib/validators';

export function IndexPage() {
	const { config } = useConfig();
	const token = getToken();
	const user = React.useMemo(() => getUser(), [token]);
	const [banner, setBanner] = React.useState<string>('');
	const [categories, setCategories] = React.useState<Category[]>([]);
	const [selectedCategory, setSelectedCategory] = React.useState<string>('');
	const [siteFeaturedOnly, setSiteFeaturedOnly] = React.useState(false);
	const [searchInput, setSearchInput] = React.useState<string>('');
	const [searchQuery, setSearchQuery] = React.useState<string>('');
	const [posts, setPosts] = React.useState<Post[]>([]);
	const [totalPosts, setTotalPosts] = React.useState<number>(0);
	const [pageOffset, setPageOffset] = React.useState<number>(0);
	const [loading, setLoading] = React.useState<boolean>(true);
	const [error, setError] = React.useState<string>('');
	const pageLimit = 10;
	const [jumpTo, setJumpTo] = React.useState<string>('');

	const [newTitle, setNewTitle] = React.useState('');
	const [newContent, setNewContent] = React.useState('');
	const [newCategoryId, setNewCategoryId] = React.useState<string>('');
	const [newVisible, setNewVisible] = React.useState(true);
	const [previewOpen, setPreviewOpen] = React.useState(() =>
		typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : false
	);
	const [categoriesOpen, setCategoriesOpen] = React.useState(true);
	const [createOpen, setCreateOpen] = React.useState(false);
	const [createLoading, setCreateLoading] = React.useState(false);
	const [createError, setCreateError] = React.useState('');
	const [uploadLoading, setUploadLoading] = React.useState(false);
	const [uploadError, setUploadError] = React.useState('');

	// insert text at current cursor position in the textarea (or append)
	function insertIntoContent(insertText: string) {
		if (newContentRef.current) {
			const el = newContentRef.current;
			const start = el.selectionStart;
			const end = el.selectionEnd;
			const before = newContent.slice(0, start);
			const after = newContent.slice(end);
			const updated = before + insertText + after;
			setNewContent(updated);
			// reposition cursor immediately after inserted text
			setTimeout(() => {
				el.selectionStart = el.selectionEnd = start + insertText.length;
				el.focus();
			}, 0);
		} else {
			setNewContent(newContent + insertText);
		}
	}

	function applyEdit(transform: (text: string, start: number, end: number) => { text: string; selectionStart: number; selectionEnd: number }) {
		const el = newContentRef.current;
		const start = el ? el.selectionStart : newContent.length;
		const end = el ? el.selectionEnd : newContent.length;
		const result = transform(newContent, start, end);
		setNewContent(result.text);
		setTimeout(() => {
			const target = newContentRef.current;
			if (!target) return;
			target.selectionStart = result.selectionStart;
			target.selectionEnd = result.selectionEnd;
			target.focus();
		}, 0);
	}

	function wrapSelection(prefix: string, suffix: string, placeholder: string) {
		applyEdit((text, start, end) => {
			const selected = text.slice(start, end) || placeholder;
			const next = text.slice(0, start) + prefix + selected + suffix + text.slice(end);
			const selectionStart = start + prefix.length;
			const selectionEnd = selectionStart + selected.length;
			return { text: next, selectionStart, selectionEnd };
		});
	}

	function wrapBlock(fence: string) {
		applyEdit((text, start, end) => {
			const selected = text.slice(start, end);
			const block = `${fence}\n${selected}\n${fence}`;
			const next = text.slice(0, start) + block + text.slice(end);
			const selectionStart = start + fence.length + 1;
			const selectionEnd = selectionStart + selected.length;
			return { text: next, selectionStart, selectionEnd };
		});
	}

	function transformLines(transform: (line: string, index: number, lines: string[]) => string) {
		applyEdit((text, start, end) => {
			const lineStart = text.lastIndexOf('\n', start - 1) + 1;
			const lineEnd = text.indexOf('\n', end);
			const endIndex = lineEnd === -1 ? text.length : lineEnd;
			const segment = text.slice(lineStart, endIndex);
			const lines = segment.split('\n');
			const nextSegment = lines.map(transform).join('\n');
			const next = text.slice(0, lineStart) + nextSegment + text.slice(endIndex);
			return { text: next, selectionStart: lineStart, selectionEnd: lineStart + nextSegment.length };
		});
	}

	function setHeading(level: number) {
		transformLines((line) => {
			const cleaned = line.replace(/^\s{0,3}#{1,6}\s+/, '');
			if (level === 0) return cleaned;
			return `${'#'.repeat(level)} ${cleaned}`;
		});
	}

	function toggleLinePrefix(prefix: string, matcher: RegExp) {
		transformLines((line) => {
			if (matcher.test(line)) return line.replace(matcher, '');
			return `${prefix}${line}`;
		});
	}

	function toggleBlockquote() {
		transformLines((line) => (line.startsWith('> ') ? line.slice(2) : `> ${line}`));
	}

	function toggleList(ordered: boolean) {
		transformLines((line, index, lines) => {
			if (ordered) {
				if (/^\d+\.\s+/.test(line)) return line.replace(/^\d+\.\s+/, '');
				return `${index + 1}. ${line}`;
			}
			if (/^[-*+]\s+/.test(line)) return line.replace(/^[-*+]\s+/, '');
			return `- ${line}`;
		});
	}

	function indentLines() {
		transformLines((line) => `  ${line}`);
	}

	function outdentLines() {
		transformLines((line) => line.replace(/^(\t| {1,2})/, ''));
	}

	function insertLink(isImage: boolean) {
		applyEdit((text, start, end) => {
			const selected = text.slice(start, end) || (isImage ? 'alt' : 'text');
			const link = isImage ? `![${selected}](url)` : `[${selected}](url)`;
			const next = text.slice(0, start) + link + text.slice(end);
			const urlStart = start + (isImage ? 2 : 1) + selected.length + 2;
			const urlEnd = urlStart + 3;
			return { text: next, selectionStart: urlStart, selectionEnd: urlEnd };
		});
	}

	function insertTable() {
		applyEdit((text, start, end) => {
			const table = `| Header | Header |\n| --- | --- |\n| Cell | Cell |`;
			const next = text.slice(0, start) + table + text.slice(end);
			const selectionStart = start + 2;
			const selectionEnd = selectionStart + 6;
			return { text: next, selectionStart, selectionEnd };
		});
	}

	function handleEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		const isMod = e.ctrlKey || e.metaKey;
		if (!isMod) return;
		const key = e.key.toLowerCase();
		const shift = e.shiftKey;
		if (!shift && key === 'b') {
			e.preventDefault();
			wrapSelection('**', '**', 'text');
			return;
		}
		if (!shift && key === 'i') {
			e.preventDefault();
			wrapSelection('*', '*', 'text');
			return;
		}
		if (!shift && key === 'u') {
			e.preventDefault();
			wrapSelection('<u>', '</u>', 'text');
			return;
		}
		if (!shift && key === 'k') {
			e.preventDefault();
			insertLink(false);
			return;
		}
		if (!shift && key === 't') {
			e.preventDefault();
			insertTable();
			return;
		}
		if (shift && key === 'i') {
			e.preventDefault();
			insertLink(true);
			return;
		}
		if (!shift && key === '0') {
			e.preventDefault();
			setHeading(0);
			return;
		}
		if (!shift && key === '1') {
			e.preventDefault();
			setHeading(1);
			return;
		}
		if (!shift && key === '2') {
			e.preventDefault();
			setHeading(2);
			return;
		}
		if (!shift && key === '3') {
			e.preventDefault();
			setHeading(3);
			return;
		}
		if (shift && key === 'k') {
			e.preventDefault();
			wrapBlock('```');
			return;
		}
		if (shift && key === 'm') {
			e.preventDefault();
			wrapBlock('$$');
			return;
		}
		if (shift && key === 'q') {
			e.preventDefault();
			toggleBlockquote();
			return;
		}
		if (shift && key === '[') {
			e.preventDefault();
			toggleList(true);
			return;
		}
		if (shift && key === ']') {
			e.preventDefault();
			toggleList(false);
			return;
		}
		if (!shift && key === '[') {
			e.preventDefault();
			outdentLines();
			return;
		}
		if (!shift && key === ']') {
			e.preventDefault();
			indentLines();
			return;
		}
		if (shift && (e.code === 'Backquote' || key === '`')) {
			e.preventDefault();
			wrapSelection('`', '`', 'code');
			return;
		}
		if (e.altKey && shift && e.code === 'Digit5') {
			e.preventDefault();
			wrapSelection('~~', '~~', 'text');
			return;
		}
	}
	const [turnstileToken, setTurnstileToken] = React.useState('');
	const [turnstileResetKey, setTurnstileResetKey] = React.useState(0);
	const previewRef = React.useRef<HTMLDivElement | null>(null);
	const newContentRef = React.useRef<HTMLTextAreaElement | null>(null);
	const [adminMenuPostId, setAdminMenuPostId] = React.useState<number | null>(null);
	const [adminActionPostId, setAdminActionPostId] = React.useState<number | null>(null);
	const [sortOption, setSortOption] = React.useState('time_desc');
	const listTopRef = React.useRef<HTMLDivElement | null>(null);
	const lastOffsetRef = React.useRef<number | null>(null);

	const enabled = !!config?.turnstile_enabled;
	const siteKey = config?.turnstile_site_key || '';
	const turnstileActive = enabled && !!siteKey;

	const fetchCategories = React.useCallback(async () => {
		try {
			const list = await apiFetch<Category[]>('/categories');
			setCategories(list);
		} catch {
			setCategories([]);
		}
	}, []);

	const fetchPosts = React.useCallback(
		async (offset: number) => {
			setLoading(true);
			setError('');
			try {
				const sortBy =
					sortOption === 'likes_desc'
						? 'likes'
						: sortOption === 'comments_desc'
							? 'comments'
							: sortOption === 'views_desc'
								? 'views'
								: 'time';
				const sortDir = sortOption === 'time_asc' ? 'asc' : 'desc';
				const categoryParam = selectedCategory ? `&category_id=${encodeURIComponent(selectedCategory)}` : '';
				const featuredParam = siteFeaturedOnly ? '&site_featured=1' : '';
				const searchParam = searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : '';
				const sortParam = `&sort_by=${encodeURIComponent(sortBy)}&sort_dir=${encodeURIComponent(sortDir)}`;
				const headers = getSecurityHeaders('GET', null);
				const res = await fetch(
					`/api/posts?limit=${pageLimit}&offset=${offset}${categoryParam}${featuredParam}${searchParam}${sortParam}`,
					{ headers }
				);
				if (!res.ok) {
					let msg = `加载帖子失败 (${res.status})`;
					try {
						const body = await res.text();
						if (body) msg += `: ${body}`;
					} catch {}
					throw new Error(msg);
				}
				const data = (await res.json()) as any;
				const list: Post[] = Array.isArray(data) ? data : (data.posts as Post[]);
				const total = Array.isArray(data) ? list.length : Number(data.total || 0);

				const processed = list.map((p) => ({
					...p,
					like_count: p.like_count || 0,
					comment_count: p.comment_count || 0
				}));

				setPosts(processed);
				setTotalPosts(total);
				setPageOffset(offset);
			} catch (e: any) {
				setError(String(e?.message || e));
			} finally {
				setLoading(false);
			}
		},
		[selectedCategory, siteFeaturedOnly, searchQuery, sortOption, token]
	);

	React.useEffect(() => {
		fetchCategories();
	}, [fetchCategories]);

	React.useEffect(() => {
		fetchPosts(0);
	}, [fetchPosts]);

	React.useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		if (params.get('verified') === 'true') {
			setBanner('邮箱验证成功，现在可以登录。');
			params.delete('verified');
			window.history.replaceState({}, document.title, `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`);
		} else if (params.get('email_changed') === 'true') {
			setBanner('邮箱更换成功。');
			params.delete('email_changed');
			window.history.replaceState({}, document.title, `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`);
		}
	}, []);

	React.useEffect(() => {
		if (!previewOpen) return;
		const el = previewRef.current;
		if (!el) return;
		highlightCodeBlocks(el);
		const cleanup = attachFancybox(el);
		return cleanup;
	}, [previewOpen, newContent]);

	React.useEffect(() => {
		if (adminMenuPostId == null) return;
		function close() {
			setAdminMenuPostId(null);
		}
		document.addEventListener('mousedown', close);
		document.addEventListener('touchstart', close);
		return () => {
			document.removeEventListener('mousedown', close);
			document.removeEventListener('touchstart', close);
		};
	}, [adminMenuPostId]);

	React.useEffect(() => {
		if (lastOffsetRef.current !== null && lastOffsetRef.current !== pageOffset && !loading) {
			listTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
		lastOffsetRef.current = pageOffset;
	}, [pageOffset, loading]);

	async function adminTogglePin(post: Post) {
		if (!user || user.role !== 'admin') return;
		setAdminActionPostId(post.id);
		try {
			const next = !post.is_pinned;
			await apiFetch(`/admin/posts/${post.id}/pin`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({ pinned: next })
			});
			setAdminMenuPostId(null);
			await fetchPosts(pageOffset);
		} catch {
			return;
		} finally {
			setAdminActionPostId(null);
		}
	}

	async function togglePostVisibility(post: Post) {
		if (!user) return;
		const isAdmin = user.role === 'admin';
		const isOwner = user.id === post.author_id;
		if (!isAdmin && !isOwner) return;
		const nextVisible = !(Number(post.is_visible ?? 1) === 1);
		if (!isAdmin && Number(post.site_featured ?? 0) === 1 && !nextVisible) {
			alert('官网精选帖不可由作者隐藏');
			return;
		}
		if (!isAdmin && nextVisible) {
			alert('隐藏后不可再设为可见，请联系管理员');
			return;
		}
		if (!nextVisible) {
			const ok = confirm(
				isAdmin
					? '确定隐藏这篇帖子吗？'
					: '确定隐藏这篇帖子吗？隐藏后将不可再设置为可见，仅管理员可恢复。'
			);
			if (!ok) return;
		}
		setAdminActionPostId(post.id);
		try {
			await apiFetch(`/posts/${post.id}/visibility`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({ visible: nextVisible })
			});
			setAdminMenuPostId(null);
			alert(nextVisible ? '已设为可见' : '已隐藏');
			await fetchPosts(pageOffset);
		} catch (e: any) {
			alert(String(e?.message || e));
		} finally {
			setAdminActionPostId(null);
		}
	}

	async function adminToggleSiteFeature(post: Post) {
		if (!user || user.role !== 'admin') return;
		setAdminActionPostId(post.id);
		try {
			const next = !(Number(post.site_featured ?? 0) === 1);
			await apiFetch(`/admin/posts/${post.id}/site-feature`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({ featured: next })
			});
			setAdminMenuPostId(null);
			alert(next ? '已设为官网精选' : '已取消官网精选');
			await fetchPosts(pageOffset);
		} catch (e: any) {
			alert(String(e?.message || e));
		} finally {
			setAdminActionPostId(null);
		}
	}

	async function deletePostFromList(post: Post) {
		if (!user) return;
		const isAdmin = user.role === 'admin';
		const isOwner = user.id === post.author_id;
		if (!isAdmin && !isOwner) return;
		if (!isAdmin && Number(post.site_featured ?? 0) === 1) {
			alert('官网精选帖不可由作者删除');
			return;
		}
		if (!confirm('确定要删除这个帖子吗？此操作无法撤销。')) return;
		setAdminActionPostId(post.id);
		try {
			const path = isAdmin ? `/admin/posts/${post.id}` : `/posts/${post.id}`;
			await apiFetch(path, {
				method: 'DELETE',
				headers: getSecurityHeaders('DELETE')
			});
			setAdminMenuPostId(null);
			alert('已删除');
			await fetchPosts(pageOffset);
		} catch (e: any) {
			alert(String(e?.message || e));
		} finally {
			setAdminActionPostId(null);
		}
	}

	async function adminMovePost(post: Post, categoryId: number) {
		if (!user || user.role !== 'admin') return;
		setAdminActionPostId(post.id);
		try {
			await apiFetch(`/admin/posts/${post.id}/move`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({ category_id: categoryId })
			});
			setAdminMenuPostId(null);
			await fetchPosts(pageOffset);
		} catch (e: any) {
			alert(String(e?.message || e));
		} finally {
			setAdminActionPostId(null);
		}
	}

	async function createPost(e: React.FormEvent) {
		e.preventDefault();
		if (!user) {
			window.location.href = '/login';
			return;
		}

		setCreateError('');
		const titleErr = validateText(newTitle, '标题');
		if (titleErr) return setCreateError(titleErr);
		const contentErr = validateText(newContent, '内容');
		if (contentErr) return setCreateError(contentErr);
		if (!newCategoryId) return setCreateError('请选择分类');
		if (newTitle.length > 30) return setCreateError('标题过长 (最多 30 字符)');
		if (newContent.length > 3000) return setCreateError('内容过长 (最多 3000 字符)');
		if (turnstileActive && !turnstileToken) return setCreateError('请完成验证码验证');

		setCreateLoading(true);
		try {
			await apiFetch<{ success: boolean }>('/posts', {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({
					title: newTitle,
					content: newContent,
					category_id: Number(newCategoryId),
					is_visible: newVisible,
					'cf-turnstile-response': turnstileToken
				})
			});
			setNewTitle('');
			setNewContent('');
			setNewCategoryId('');
			setNewVisible(true);
			setTurnstileToken('');
			setTurnstileResetKey((v) => v + 1);
			setCreateOpen(false);
			alert(newVisible ? '发布成功（可见帖作者不可再编辑）' : '发布成功（已隐藏）');
			await fetchPosts(0);
		} catch (e: any) {
			setCreateError(String(e?.message || e));
			setTurnstileToken('');
			setTurnstileResetKey((v) => v + 1);
		} finally {
			setCreateLoading(false);
		}
	}

	const currentPage = Math.floor(pageOffset / pageLimit) + 1;
	const totalPages = Math.max(1, Math.ceil(totalPosts / pageLimit));
	const pages: Array<number | 'ellipsis'> = [];
	if (totalPages <= 7) {
		for (let p = 1; p <= totalPages; p++) pages.push(p);
	} else {
		const start = Math.max(2, currentPage - 2);
		const end = Math.min(totalPages - 1, currentPage + 2);
		pages.push(1);
		if (start > 2) pages.push('ellipsis');
		for (let p = start; p <= end; p++) pages.push(p);
		if (end < totalPages - 1) pages.push('ellipsis');
		pages.push(totalPages);
	}

	function getCoverImageUrl(markdown: string) {
		const mdMatch = markdown.match(/!\[[^\]]*\]\(([^)\s]+)\)/i);
		const htmlMatch = markdown.match(/<img[^>]+src=["']([^"']+)["']/i);
		let url = mdMatch?.[1] || htmlMatch?.[1] || '';
		if (!url) return '';
		if (!/^https?:\/\//i.test(url) && !url.startsWith('/') && !url.startsWith('data:')) {
			url = `/r2/${url.replace(/^\/+/, '')}`;
		}
		return url;
	}

	const pinnedPosts = posts.filter((p) => !!p.is_pinned);
	const feedPosts = posts.filter((p) => !p.is_pinned);
	const showPinnedBlock = !loading && pinnedPosts.length > 0 && pageOffset === 0 && !searchQuery;

	return (
		<PageShell>
			<div className="space-y-6">
				{banner ? <div className="rounded-md border bg-muted/40 p-3 text-sm">{banner}</div> : null}
				<div className="space-y-4">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<div>
							<h1 className="text-2xl font-semibold tracking-tight">
								{config?.site_title || 'liuyuliangbox / Project Turn'}
							</h1>
							<p className="text-sm text-muted-foreground">
								{config?.site_tagline || '由 Cloudflare Workers、Pages、D1、R2 提供服务。'}
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<label className="text-sm text-muted-foreground" htmlFor="sort-filter">
								排序
							</label>
							<select
								id="sort-filter"
								className="h-9 rounded-md border bg-background px-3 text-sm"
								value={sortOption}
								onChange={(e) => {
									setSortOption(e.target.value);
									setPageOffset(0);
								}}
							>
								<option value="time_desc">最新发布</option>
								<option value="time_asc">最早发布</option>
								<option value="likes_desc">最多点赞</option>
								<option value="comments_desc">最多评论</option>
								<option value="views_desc">最多观看</option>
							</select>
							<button
								type="button"
								aria-pressed={siteFeaturedOnly}
								className={
									siteFeaturedOnly
										? 'inline-flex h-9 items-center gap-1 rounded-md border border-sky-600 bg-sky-600 px-3 text-sm font-medium text-white'
										: 'inline-flex h-9 items-center gap-1 rounded-md border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted/60'
								}
								onClick={() => {
									setSiteFeaturedOnly((v) => !v);
									setPageOffset(0);
								}}
							>
								<Star className="h-3.5 w-3.5" />
								官网精选
							</button>
							<Button variant="outline" size="sm" onClick={() => fetchPosts(0)} disabled={loading}>
								<RefreshCw className="h-4 w-4" />
								<span className="sr-only">刷新</span>
							</Button>
						</div>
					</div>

					<form
						className="flex w-full items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							setPageOffset(0);
							setSearchQuery(searchInput.trim());
						}}
					>
						<Input
							value={searchInput}
							onChange={(e) => setSearchInput(e.target.value)}
							placeholder="搜索标题/内容"
							className="h-9 min-w-0 flex-1"
						/>
						<Button variant="outline" size="sm" type="submit" disabled={loading}>
							<Search className="h-4 w-4" />
							<span className="sr-only">搜索</span>
						</Button>
						{searchInput || searchQuery ? (
							<Button
								variant="outline"
								size="sm"
								type="button"
								onClick={() => {
									setSearchInput('');
									setSearchQuery('');
									setPageOffset(0);
								}}
								disabled={loading}
							>
								<X className="h-4 w-4" />
								<span className="sr-only">清除</span>
							</Button>
						) : null}
					</form>

					<div className="space-y-2">
						<button
							type="button"
							className="inline-flex items-center gap-1 text-sm font-medium text-foreground"
							onClick={() => setCategoriesOpen((v) => !v)}
							aria-expanded={categoriesOpen}
						>
							分类
							{categoriesOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
						</button>
						{categoriesOpen ? (
							<div className="flex flex-wrap gap-2" role="listbox" aria-label="分类筛选">
								{(
									[
										{ id: '', label: '全部', adminOnly: false },
										...categories
											.filter(
												(c) =>
													user?.role === 'admin' ||
													!(c.show_on_forum === false || c.show_on_forum === 0)
											)
											.map((c) => ({
												id: String(c.id),
												label: c.name,
												adminOnly: !!(c.admin_only === true || c.admin_only === 1)
											}))
									] as Array<{ id: string; label: string; adminOnly: boolean }>
								).map((chip) => {
									const active = selectedCategory === chip.id;
									return (
										<button
											key={chip.id || 'all'}
											type="button"
											role="option"
											aria-selected={active}
											className={
												active
													? 'inline-flex items-center gap-1 rounded-full border border-foreground bg-foreground px-3 py-1 text-xs font-medium text-background'
													: 'inline-flex items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs font-medium text-foreground hover:bg-muted/60'
											}
											onClick={() => {
												setSelectedCategory(chip.id);
												setPageOffset(0);
											}}
										>
											{chip.label}
											{chip.adminOnly ? (
												<span
													className={
														active
															? 'rounded bg-background/20 px-1 py-px text-[10px]'
															: 'rounded bg-amber-500/15 px-1 py-px text-[10px] text-amber-700 dark:text-amber-300'
													}
												>
													公告
												</span>
											) : null}
										</button>
									);
								})}
							</div>
						) : null}
					</div>
				</div>

				{user ? (
					<Card className={createOpen ? undefined : 'border-dashed'}>
						<CardHeader className="p-0">
							<button
								type="button"
								className={
									createOpen
										? 'flex w-full items-center justify-between gap-3 px-6 py-4 text-left transition-colors hover:bg-muted/40'
										: 'flex w-full items-center justify-between gap-3 rounded-xl bg-gradient-to-r from-sky-500/15 via-violet-500/10 to-fuchsia-500/15 px-6 py-4 text-left transition hover:from-sky-500/25 hover:via-violet-500/20 hover:to-fuchsia-500/25'
								}
								onClick={() => setCreateOpen((v) => !v)}
								aria-expanded={createOpen}
							>
								<div className="min-w-0 space-y-1">
									<CardTitle className="text-base sm:text-lg">发布新帖</CardTitle>
									<p className="text-sm font-normal text-muted-foreground">
										{createOpen ? '再次点击可收起编辑器' : '点这里展开，写标题和内容后发布'}
									</p>
								</div>
								<span
									className={
										createOpen
											? 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background'
											: 'inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-foreground/20 bg-background px-3 text-sm font-medium shadow-sm'
									}
								>
									{createOpen ? <ChevronUp className="h-4 w-4" /> : <>展开 <ChevronDown className="h-4 w-4" /></>}
								</span>
							</button>
						</CardHeader>
						{createOpen ? (
						<CardContent>
								<form className="space-y-4" onSubmit={createPost}>
								{createError ? <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">{createError}</div> : null}
								<div className="space-y-4">
									<div className="space-y-2">
										<Label htmlFor="new-title">标题</Label>
										<Input id="new-title" maxLength={30} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} required />
									</div>
									<div className="space-y-2">
										<Label htmlFor="new-category">分类</Label>
										<select
											id="new-category"
											className="h-9 w-full rounded-md border bg-background px-3 text-sm"
											value={newCategoryId}
											onChange={(e) => setNewCategoryId(e.target.value)}
											required
										>
											<option value="">请选择分类</option>
											{categories
												.filter(
													(c) =>
														(!c.admin_only || user?.role === 'admin') &&
														(user?.role === 'admin' || !(c.show_on_forum === false || c.show_on_forum === 0))
												)
												.map((c) => (
													<option key={c.id} value={String(c.id)}>
														{c.name}
														{c.admin_only ? '（仅管理员）' : ''}
													</option>
												))}
										</select>
									</div>
									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											className="h-4 w-4"
											checked={newVisible}
											onChange={(e) => setNewVisible(e.target.checked)}
										/>
										设置可见（勾选后作者不可再编辑，仍可隐藏）
									</label>
								</div>
								<div className="space-y-2">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<Label htmlFor="new-content">内容 (支持 Markdown)</Label>
									<div className="flex items-center gap-2">
										<span className="hidden text-xs text-muted-foreground lg:inline">快捷键：Ctrl+1/2/3、Ctrl+B/I/U、Ctrl+K、Ctrl+Shift+K</span>
										<Button type="button" variant="outline" size="sm" onClick={() => setPreviewOpen((v) => !v)}>
											{previewOpen ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
											<span className="sr-only">{previewOpen ? '关闭预览' : '打开预览'}</span>
										</Button>
									</div>
								</div>
								<div className={previewOpen ? 'grid gap-3 lg:grid-cols-2' : 'space-y-2'}>
									<div className="space-y-2">
										<Textarea
											id="new-content"
											ref={newContentRef}
											value={newContent}
											onChange={(e) => setNewContent(e.target.value)}
											onKeyDown={handleEditorKeyDown}
											rows={10}
											className="min-h-[220px]"
											required
										/>
										<div className="text-xs text-muted-foreground">Ctrl+T 表格，Ctrl+Shift+M 公式，Ctrl+Shift+Q 引用，Alt+Shift+5 删除线</div>
									</div>
									{previewOpen ? (
										<div className="rounded-md border bg-muted/20 p-3">
											<div className="mb-2 text-xs font-medium text-muted-foreground">预览</div>
											<div
												ref={previewRef}
												className="prose max-w-none break-words [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1"
												dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(newContent || '') }}
											/>
										</div>
									) : null}
								</div>
							</div>
								{/* image upload button */}
		<div className="space-y-2">
			<label className="block text-sm font-medium text-muted-foreground">上传图片</label>
			<input
				type="file"
				accept="image/*"
				className="block w-full text-sm"
				onChange={async (e) => {
					const file = e.target.files && e.target.files[0];
					if (!file) return;
					setUploadError('');
					// allow up to 2MB
					if (file.size > 2 * 1024 * 1024) {
						setUploadError('文件过大 (最大 2MB)');
						return;
					}
					setUploadLoading(true);
					try {
						const formData = new FormData();
						formData.append('file', file);
						formData.append('type', 'post');
						const res = await fetch('/api/upload', {
							method: 'POST',
							headers: getSecurityHeaders('POST', null),
							body: formData
						});
						const data = await res.json();
						if (!res.ok) throw new Error(data?.error || '上传失败');
                        // insert markdown link at cursor and ensure preview is visible
                        insertIntoContent(`

![](${data.url})

`);
                        setPreviewOpen(true);
					} catch (err: any) {
						setUploadError(String(err?.message || err));
					} finally {
						setUploadLoading(false);
					}
				}}
			/>
			{uploadError ? <div className="text-sm text-destructive">{uploadError}</div> : null}
			{uploadLoading ? <div className="text-sm text-muted-foreground">上传中…</div> : null}
		</div>
		<TurnstileWidget enabled={turnstileActive} siteKey={siteKey} onToken={setTurnstileToken} resetKey={turnstileResetKey} />

								<Button type="submit" disabled={createLoading}>
									{createLoading ? '发布中...' : '发布'}
								</Button>
							</form>
						</CardContent>
						) : null}
					</Card>
				) : (
					<Card>
						<CardContent className="py-6 text-sm text-muted-foreground">
							<a className="text-foreground underline" href="/login">
								登录
							</a>{' '}
							后可发布、点赞和评论。
						</CardContent>
					</Card>
				)}

				{error ? <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">{error}</div> : null}

				{showPinnedBlock ? (
					<div className="space-y-3">
						<div className="flex items-center gap-2 text-sm font-semibold">
							<span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-sm">
								<Pin className="h-3.5 w-3.5" />
							</span>
							置顶
						</div>
						<div className="space-y-2">
							{pinnedPosts.map((p, idx) => {
								const tones = [
									'from-amber-500/20 via-orange-400/10 to-rose-400/15 border-amber-500/30',
									'from-violet-500/20 via-fuchsia-400/10 to-sky-400/15 border-violet-500/30',
									'from-emerald-500/20 via-teal-400/10 to-cyan-400/15 border-emerald-500/30'
								];
								const tone = tones[idx % tones.length];
								return (
									<a
										key={`pin-${p.id}`}
										href={`/post?id=${p.id}`}
										className={`block rounded-xl border bg-gradient-to-r p-3 shadow-sm transition hover:brightness-[1.03] sm:p-4 ${tone}`}
									>
										<div className="flex flex-wrap items-center gap-2">
											{p.category_name ? (
												<span className="inline-flex items-center rounded-full border border-white/40 bg-background/70 px-2 py-0.5 text-[11px] font-medium text-foreground backdrop-blur">
													{p.category_name}
												</span>
											) : null}
											<span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200">
												<Pin className="h-3 w-3" />
												置顶
											</span>
											{Number(p.site_featured ?? 0) === 1 ? (
												<span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-800 dark:text-sky-200">
													<Star className="h-3 w-3" />
													官网精选
												</span>
											) : null}
											{Number(p.is_visible ?? 1) === 0 ? (
												<span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
													<EyeOff className="h-3 w-3" />
													已隐藏
												</span>
											) : null}
										</div>
										<div className="mt-2 text-base font-semibold text-foreground sm:text-lg">{p.title}</div>
										<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
											<span>{p.author_name}</span>
											<span>·</span>
											<span>{formatDate(p.created_at)}</span>
										</div>
									</a>
								);
							})}
						</div>
					</div>
				) : null}

				<div className="space-y-4">
					<div ref={listTopRef} />
					{loading ? (
						<Card>
							<CardContent className="py-6 text-sm text-muted-foreground">加载中...</CardContent>
						</Card>
					) : posts.length === 0 ? (
						<Card>
							<CardContent className="py-6 text-sm text-muted-foreground">暂无帖子</CardContent>
						</Card>
					) : feedPosts.length === 0 && showPinnedBlock ? (
						<Card>
							<CardContent className="py-6 text-sm text-muted-foreground">本页其余帖子已在置顶区展示</CardContent>
						</Card>
					) : (
						(showPinnedBlock ? feedPosts : posts).map((p) => {
							const coverUrl = getCoverImageUrl(p.content || '');
							const isAdmin = user?.role === 'admin';
							const isOwner = !!user && user.id === p.author_id;
							const isFeatured = Number(p.site_featured ?? 0) === 1;
							const isHidden = Number(p.is_visible ?? 1) === 0;
							const canHide = isAdmin || (isOwner && !isFeatured && !isHidden);
							const canShow = isAdmin && isHidden;
							const canDelete = isAdmin || (isOwner && !isFeatured);
							const canManage = isAdmin || isOwner;
							const menuOpen = adminMenuPostId === p.id;
							const actionLoading = adminActionPostId === p.id;
							return (
								<Card
									key={p.id}
									className="group relative transition hover:border-foreground/25 hover:shadow-sm"
								>
									<a
										href={`/post?id=${p.id}`}
										className="absolute inset-0 z-0 rounded-xl"
										aria-label={`查看帖子：${p.title}`}
									/>
									<CardContent className="relative z-10 py-5 pointer-events-none">
										<div className="flex gap-4">
											{coverUrl ? (
												<img
													src={coverUrl}
													alt=""
													className="h-20 w-28 shrink-0 rounded-md object-cover"
													loading="lazy"
													referrerPolicy="no-referrer"
												/>
											) : null}
											<div className="min-w-0 flex-1 space-y-1">
												<div className="flex items-start justify-between gap-2">
													<div className="flex min-w-0 flex-wrap items-center gap-2">
														{p.is_pinned ? (
															<span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
																<Pin className="h-3.5 w-3.5" />
																置顶
															</span>
														) : null}
														{isFeatured ? (
															<span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs font-medium text-sky-700 dark:text-sky-300">
																<Star className="h-3.5 w-3.5" />
																官网精选
															</span>
														) : null}
														{isHidden ? (
															<span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
																<EyeOff className="h-3.5 w-3.5" />
																已隐藏
															</span>
														) : null}
														<span className="truncate text-lg font-semibold group-hover:underline">{p.title}</span>
													</div>
													{canManage ? (
														<div className="relative z-20 pointer-events-auto">
															<Button
																type="button"
																variant="ghost"
																size="sm"
																disabled={actionLoading}
																onMouseDown={(e) => e.stopPropagation()}
																onTouchStart={(e) => e.stopPropagation()}
																onClick={(e) => {
																	e.preventDefault();
																	e.stopPropagation();
																	setAdminMenuPostId((cur) => (cur === p.id ? null : p.id));
																}}
																aria-haspopup="menu"
																aria-expanded={menuOpen}
															>
																<MoreVertical className="h-4 w-4" />
																<span className="sr-only">更多</span>
															</Button>
															{menuOpen ? (
																<div
																	className="absolute right-0 top-full z-[60] mt-1 max-h-64 w-44 overflow-y-auto rounded-md border bg-background p-1 shadow-lg"
																	onMouseDown={(e) => e.stopPropagation()}
																	onTouchStart={(e) => e.stopPropagation()}
																	onClick={(e) => e.stopPropagation()}
																>
																	{canHide || canShow ? (
																		<button
																			type="button"
																			disabled={actionLoading}
																			className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
																			onClick={() => void togglePostVisibility(p)}
																		>
																			{isHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
																			{isHidden ? '设为可见' : '隐藏'}
																		</button>
																	) : null}
																	{isAdmin ? (
																		<button
																			type="button"
																			disabled={actionLoading}
																			className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
																			onClick={() => void adminToggleSiteFeature(p)}
																		>
																			<Star className="h-4 w-4" />
																			{isFeatured ? '取消官网精选' : '官网精选'}
																		</button>
																	) : null}
																	{isAdmin ? (
																		<button
																			type="button"
																			disabled={actionLoading}
																			className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
																			onClick={() => void adminTogglePin(p)}
																		>
																			<Pin className="h-4 w-4" />
																			{p.is_pinned ? '取消置顶' : '置顶'}
																		</button>
																	) : null}
																	{canDelete ? (
																		<button
																			type="button"
																			disabled={actionLoading}
																			className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
																			onClick={() => void deletePostFromList(p)}
																		>
																			<Trash2 className="h-4 w-4" />
																			删除
																		</button>
																	) : null}
																	{isAdmin ? (
																		<>
																	<div className="my-1 h-px bg-border" />
																	<div className="px-2 py-1 text-xs font-medium text-muted-foreground">移动到分类</div>
																	{categories.map((c) => (
																		<button
																			key={c.id}
																			type="button"
																			disabled={actionLoading}
																			className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
																			onClick={() => void adminMovePost(p, c.id)}
																		>
																			{c.name}
																		</button>
																	))}
																		</>
																	) : null}
																</div>
															) : null}
														</div>
													) : null}
												</div>
												<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
													<span className="inline-flex items-center gap-2">
														{p.author_avatar ? (
															<img
																src={p.author_avatar}
																alt=""
																className="h-6 w-6 rounded-full object-cover"
																loading="lazy"
																referrerPolicy="no-referrer"
															/>
														) : (
															<span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
																<User className="h-4 w-4" />
															</span>
														)}
														<span className="truncate text-foreground">{p.author_name}</span>
														{p.author_role === 'admin' ? (
															<span className="inline-flex items-center gap-1 rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
																<Shield className="h-3 w-3" />
																<span className="sr-only">管理员</span>
															</span>
														) : null}
													</span>
													{p.category_name ? (
														<>
															<span>·</span>
															<span className="truncate">{p.category_name}</span>
														</>
													) : null}
													<span>·</span>
													<span className="whitespace-nowrap">{formatDate(p.created_at)}</span>
												</div>
												<div className="flex items-center gap-4 text-xs text-muted-foreground">
													<span className="inline-flex items-center gap-1">
														<Heart className="h-4 w-4 text-rose-600" />
														{p.like_count || 0}
													</span>
													<span className="inline-flex items-center gap-1">
														<MessageCircle className="h-4 w-4 text-sky-600" />
														{p.comment_count || 0}
													</span>
													<span className="inline-flex items-center gap-1">
														<Eye className="h-4 w-4 text-emerald-600" />
														{p.view_count || 0}
													</span>
												</div>
											</div>
										</div>
									</CardContent>
								</Card>
							);
						})
					)}
				</div>

				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={currentPage <= 1 || loading}
							onClick={() => fetchPosts(Math.max(0, pageOffset - pageLimit))}
						>
							<ChevronLeft className="h-4 w-4" />
							<span className="sr-only">上一页</span>
						</Button>
						<div className="flex items-center gap-1">
							{pages.map((p, idx) =>
								p === 'ellipsis' ? (
									<span key={`e-${idx}`} className="px-2 text-sm text-muted-foreground">
										…
									</span>
								) : (
									<Button
										key={p}
										variant={p === currentPage ? 'secondary' : 'outline'}
										size="sm"
										disabled={loading}
										onClick={() => fetchPosts((p - 1) * pageLimit)}
									>
										{p}
									</Button>
								)
							)}
						</div>
						<Button
							variant="outline"
							size="sm"
							disabled={currentPage >= totalPages || loading}
							onClick={() => fetchPosts(pageOffset + pageLimit)}
						>
							<ChevronRight className="h-4 w-4" />
							<span className="sr-only">下一页</span>
						</Button>
					</div>
					<form
						className="flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							const parsed = Number.parseInt(jumpTo, 10);
							if (!Number.isFinite(parsed)) return;
							const next = Math.min(Math.max(parsed, 1), totalPages);
							setJumpTo(String(next));
							fetchPosts((next - 1) * pageLimit);
						}}
					>
						<div className="text-sm text-muted-foreground">
							第 {currentPage} / {totalPages} 页
						</div>
						<Input
							value={jumpTo}
							onChange={(e) => setJumpTo(e.target.value)}
							inputMode="numeric"
							placeholder="跳页"
							className="h-9 w-20"
						/>
						<Button variant="outline" size="sm" type="submit" disabled={loading}>
							跳转
						</Button>
					</form>
				</div>
			</div>
		</PageShell>
	);
}
