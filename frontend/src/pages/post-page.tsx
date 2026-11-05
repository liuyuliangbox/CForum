import * as React from 'react';
import { ArrowLeft, Eye, EyeOff, Heart, MoreVertical, Pin, Pencil, Reply, Shield, Star, Trash2, User, X } from 'lucide-react';

import { MarkdownToolbar } from '@/components/markdown-toolbar';
import { TurnstileWidget } from '@/components/turnstile';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useConfig } from '@/hooks/use-config';
import {
	apiFetch,
	formatCountdown,
	formatDate,
	getAuthorPublishRemainingMs,
	getSecurityHeaders,
	type Category,
	type Comment,
	type Post
} from '@/lib/api';
import { getToken, getUser } from '@/lib/auth';
import { attachFancybox, highlightCodeBlocks, renderMarkdownToHtml } from '@/lib/markdown';
import {
	handleMarkdownEditorKeyDown,
	runMarkdownAction,
	type EditResult,
	type MarkdownEditorAction
} from '@/lib/markdown-editor';
import { validateText } from '@/lib/validators';

export function PostPage() {
	const token = getToken();
	const user = React.useMemo(() => getUser(), [token]);
	const { config } = useConfig();
	const enabled = !!config?.turnstile_enabled;
	const siteKey = config?.turnstile_site_key || '';
	const turnstileActive = enabled && !!siteKey;

	const [post, setPost] = React.useState<Post | null>(null);
	const [comments, setComments] = React.useState<Comment[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [error, setError] = React.useState('');

	const [newComment, setNewComment] = React.useState('');
	const [replyTo, setReplyTo] = React.useState<Comment | null>(null);
	const [commentLoading, setCommentLoading] = React.useState(false);
	const [commentError, setCommentError] = React.useState('');
	const [turnstileToken, setTurnstileToken] = React.useState('');
	const [turnstileResetKey, setTurnstileResetKey] = React.useState(0);

	const [isEditing, setIsEditing] = React.useState(false);
	const [editTitle, setEditTitle] = React.useState('');
	const [editContent, setEditContent] = React.useState('');
	const [editLoading, setEditLoading] = React.useState(false);
	const [editError, setEditError] = React.useState('');
	const [uploadLoading, setUploadLoading] = React.useState(false);
	const [uploadError, setUploadError] = React.useState('');
	const editContentRef = React.useRef<HTMLTextAreaElement | null>(null);
	const editImageInputRef = React.useRef<HTMLInputElement | null>(null);
	const isAdminEditor = user?.role === 'admin';

	function applyEditResult(result: EditResult) {
		setEditContent(result.text);
		setTimeout(() => {
			const target = editContentRef.current;
			if (!target) return;
			target.selectionStart = result.selectionStart;
			target.selectionEnd = result.selectionEnd;
			target.focus();
		}, 0);
	}

	function insertIntoEditContent(insertText: string) {
		const el = editContentRef.current;
		const start = el ? el.selectionStart : editContent.length;
		const end = el ? el.selectionEnd : editContent.length;
		applyEditResult({
			text: editContent.slice(0, start) + insertText + editContent.slice(end),
			selectionStart: start + insertText.length,
			selectionEnd: start + insertText.length
		});
	}

	function onEditorAction(action: MarkdownEditorAction) {
		const el = editContentRef.current;
		const start = el ? el.selectionStart : editContent.length;
		const end = el ? el.selectionEnd : editContent.length;
		applyEditResult(runMarkdownAction(editContent, start, end, action));
	}

	async function handleEditImageFile(file: File) {
		setUploadError('');
		setEditError('');
		if (file.size > 2 * 1024 * 1024) {
			setEditError('文件过大 (最大 2MB)');
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
			insertIntoEditContent(`

![](${data.url})

`);
			setEditPreviewOpen(true);
		} catch (err: any) {
			setEditError(String(err?.message || err));
		} finally {
			setUploadLoading(false);
		}
	}
	const contentRef = React.useRef<HTMLDivElement | null>(null);
	const [editPreviewOpen, setEditPreviewOpen] = React.useState(true);
	const editPreviewRef = React.useRef<HTMLDivElement | null>(null);
	const [adminMenuOpen, setAdminMenuOpen] = React.useState(false);
	const adminMenuRef = React.useRef<HTMLDivElement | null>(null);
	const [allCategories, setAllCategories] = React.useState<Category[]>([]);
	const [publishNowMs, setPublishNowMs] = React.useState(() => Date.now());
	const needsPublishTick =
		!!user &&
		!!post &&
		user.id === post.author_id &&
		getAuthorPublishRemainingMs(post, publishNowMs) > 0;
	React.useEffect(() => {
		if (!needsPublishTick) return;
		const id = window.setInterval(() => setPublishNowMs(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [needsPublishTick]);

	function getPostIdFromPath() {
		const params = new URLSearchParams(window.location.search);
		const q = params.get('id') || params.get('post_id');
		if (q && /^\d+$/.test(q)) return q;
		const m = window.location.pathname.match(/^\/posts\/(\d+)$/);
		if (m) return m[1];
		const m2 = window.location.pathname.match(/^\/post\/(\d+)$/);
		return m2 ? m2[1] : null;
	}

	const postId = getPostIdFromPath();

	const userId = user?.id ?? null;

	const refresh = React.useCallback(async () => {
		if (!postId) {
			setError('帖子不存在');
			setLoading(false);
			return;
		}
		setLoading(true);
		setError('');
		try {
			const userParam = userId ? `?user_id=${userId}` : '';
			const authHeaders = getSecurityHeaders('GET', null);
			const [p, cs] = await Promise.all([
				apiFetch<Post>(`/posts/${postId}${userParam}`, { headers: authHeaders }),
				apiFetch<Comment[]>(`/posts/${postId}/comments`, { headers: authHeaders })
			]);
			setPost(p);
			setComments(cs);
			setEditTitle(p.title);
			setEditContent(p.content);
		} catch (e: any) {
			setError(String(e?.message || e));
		} finally {
			setLoading(false);
		}
	}, [postId, userId]);

	React.useEffect(() => {
		refresh();
	}, [refresh]);

	React.useEffect(() => {
		void apiFetch<Category[]>('/categories')
			.then((list) => setAllCategories(Array.isArray(list) ? list : []))
			.catch(() => setAllCategories([]));
	}, []);

	React.useEffect(() => {
		if (isEditing) return;
		const el = contentRef.current;
		if (!el) return;
		highlightCodeBlocks(el);
		const cleanup = attachFancybox(el);
		return cleanup;
	}, [post, comments.length, isEditing]);

	React.useEffect(() => {
		if (!isEditing) return;
		if (!editPreviewOpen) return;
		const el = editPreviewRef.current;
		if (!el) return;
		highlightCodeBlocks(el);
		const cleanup = attachFancybox(el);
		return cleanup;
	}, [isEditing, editPreviewOpen, editContent]);

	React.useEffect(() => {
		if (!adminMenuOpen) return;
		function onPointerDown(e: MouseEvent | TouchEvent) {
			const target = e.target as Node | null;
			if (!target) return;
			const menu = adminMenuRef.current;
			if (menu && !menu.contains(target)) setAdminMenuOpen(false);
		}
		document.addEventListener('mousedown', onPointerDown);
		document.addEventListener('touchstart', onPointerDown);
		return () => {
			document.removeEventListener('mousedown', onPointerDown);
			document.removeEventListener('touchstart', onPointerDown);
		};
	}, [adminMenuOpen]);

	function organizeComments(list: Comment[]) {
		const roots: Array<Comment & { replies?: Comment[] }> = [];
		const map = new Map<number, Comment & { replies?: Comment[] }>();
		list.forEach((c) => map.set(c.id, { ...c, replies: [] }));
		map.forEach((c) => {
			if (c.parent_id && map.has(c.parent_id)) map.get(c.parent_id)!.replies!.push(c);
			else roots.push(c);
		});
		return roots;
	}

	async function toggleLike() {
		if (!post) return;
		if (!user) {
			window.location.href = '/login';
			return;
		}
		try {
			const data = await apiFetch<{ liked: boolean }>(`/posts/${post.id}/like`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({})
			});
			setPost((prev) =>
				prev
					? {
							...prev,
							liked: data.liked,
							like_count: (prev.like_count || 0) + (data.liked ? 1 : -1)
						}
					: prev
			);
		} catch {
			return;
		}
	}

	async function submitComment(e: React.FormEvent) {
		e.preventDefault();
		if (!postId) return;
		if (!user) {
			window.location.href = '/login';
			return;
		}
		setCommentError('');
		const err = validateText(newComment, '评论');
		if (err) return setCommentError(err);
		if (newComment.length > 3000) return setCommentError('评论过长 (最多 3000 字符)');
		if (turnstileActive && !turnstileToken) return setCommentError('请完成验证码验证');

		setCommentLoading(true);
		try {
			await apiFetch(`/posts/${postId}/comments`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({
					content: newComment,
					parent_id: replyTo ? replyTo.id : null,
					'cf-turnstile-response': turnstileToken
				})
			});
			setNewComment('');
			setReplyTo(null);
			setTurnstileToken('');
			setTurnstileResetKey((v) => v + 1);
			await refresh();
		} catch (e: any) {
			setCommentError(String(e?.message || e));
			setTurnstileToken('');
			setTurnstileResetKey((v) => v + 1);
		} finally {
			setCommentLoading(false);
		}
	}

	async function deleteComment(id: number) {
		if (!confirm('确定要删除此评论吗？此操作无法撤销。')) return;
		try {
			await apiFetch(`/comments/${id}`, {
				method: 'DELETE',
				headers: getSecurityHeaders('DELETE')
			});
			await refresh();
		} catch (e: any) {
			alert(String(e?.message || e));
		}
	}

	async function deletePost() {
		if (!post) return;
		const isAdmin = user?.role === 'admin';
		if (!isAdmin && Number(post.site_featured ?? 0) === 1) {
			alert('官网精选帖不可由作者删除');
			return;
		}
		if (!confirm('确定要删除这个帖子吗？此操作无法撤销。')) return;
		try {
			const path = isAdmin ? `/admin/posts/${post.id}` : `/posts/${post.id}`;
			await apiFetch(path, {
				method: 'DELETE',
				headers: getSecurityHeaders('DELETE')
			});
			alert('已删除');
			window.location.href = '/';
		} catch (e: any) {
			alert(String(e?.message || e));
		}
	}

	async function togglePin() {
		if (!post) return;
		if (!user || user.role !== 'admin') return;
		try {
			const next = !post.is_pinned;
			await apiFetch(`/admin/posts/${post.id}/pin`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({ pinned: next })
			});
			setPost((prev) => (prev ? { ...prev, is_pinned: next ? 1 : 0 } : prev));
			alert(next ? '已置顶' : '已取消置顶');
		} catch (e: any) {
			alert(String(e?.message || e));
		} finally {
			setAdminMenuOpen(false);
		}
	}

	async function toggleVisibility() {
		if (!post) return;
		if (!user || (user.role !== 'admin' && user.id !== post.author_id)) return;
		const isAdmin = user.role === 'admin';
		const nextVisible = !(Number(post.is_visible ?? 1) === 1);
		if (!isAdmin && Number(post.site_featured ?? 0) === 1 && !nextVisible) {
			alert('官网精选帖不可由作者隐藏');
			return;
		}
		if (!isAdmin && nextVisible) {
			const remain = getAuthorPublishRemainingMs(post);
			if (remain <= 0) {
				alert(
					post.author_publish_until
						? '超过 15 分钟未设为可见，已失去设为可见权限，请联系管理员'
						: '隐藏后不可再设为可见，请联系管理员'
				);
				return;
			}
		}
		if (!nextVisible) {
			const ok = confirm(
				isAdmin
					? '确定隐藏这篇帖子吗？'
					: '确定隐藏这篇帖子吗？隐藏后将不可再设置为可见，仅管理员可恢复。'
			);
			if (!ok) return;
		} else if (!isAdmin) {
			const ok = confirm('设为可见后将不可再编辑，请确认内容已核对无误。');
			if (!ok) return;
		}
		try {
			await apiFetch(`/posts/${post.id}/visibility`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({ visible: nextVisible })
			});
			setPost((prev) =>
				prev
					? {
							...prev,
							is_visible: nextVisible ? 1 : 0,
							author_publish_until: nextVisible ? null : prev.author_publish_until
						}
					: prev
			);
			alert(nextVisible ? '已设为可见' : '已隐藏');
		} catch (e: any) {
			alert(String(e?.message || e));
		} finally {
			setAdminMenuOpen(false);
		}
	}

	async function toggleSiteFeature() {
		if (!post || !user || user.role !== 'admin') return;
		try {
			const next = !(Number(post.site_featured ?? 0) === 1);
			await apiFetch(`/admin/posts/${post.id}/site-feature`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({ featured: next })
			});
			setPost((prev) => (prev ? { ...prev, site_featured: next ? 1 : 0 } : prev));
			alert(next ? '已设为官网精选' : '已取消官网精选');
		} catch (e: any) {
			alert(String(e?.message || e));
		} finally {
			setAdminMenuOpen(false);
		}
	}

	async function toggleCommentFeature(commentId: number, currentlyFeatured: boolean) {
		if (!user || user.role !== 'admin') return;
		try {
			await apiFetch(`/admin/comments/${commentId}/feature`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({ featured: !currentlyFeatured })
			});
			alert(!currentlyFeatured ? '已设为官网精选评论' : '已取消官网精选评论');
			await refresh();
		} catch (e: any) {
			alert(String(e?.message || e));
		}
	}

	async function adminMovePostCategory(categoryId: number) {
		if (!post) return;
		if (!user || user.role !== 'admin') return;
		try {
			await apiFetch(`/admin/posts/${post.id}/move`, {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({ category_id: categoryId })
			});
			setAdminMenuOpen(false);
			alert('已移动分类');
			await refresh();
		} catch (e: any) {
			alert(String(e?.message || e));
		}
	}

	async function saveEdit() {
		if (!post) return;
		setEditError('');
		const titleErr = validateText(editTitle, '标题');
		if (titleErr) return setEditError(titleErr);
		const contentErr = validateText(editContent, '内容');
		if (contentErr) return setEditError(contentErr);
		if (editTitle.length > 30) return setEditError('标题过长 (最多 30 字符)');
		if (editContent.length > 3000) return setEditError('内容过长 (最多 3000 字符)');

		setEditLoading(true);
		try {
			await apiFetch(`/posts/${post.id}`, {
				method: 'PUT',
				headers: getSecurityHeaders('PUT'),
				body: JSON.stringify({ title: editTitle, content: editContent, category_id: post.category_id })
			});
			setIsEditing(false);
			await refresh();
		} catch (e: any) {
			setEditError(String(e?.message || e));
		} finally {
			setEditLoading(false);
		}
	}

	return (
		<PageShell title={post?.title || '帖子'}>
			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<Button asChild variant="ghost" size="sm">
						<a href="/">
							<ArrowLeft className="h-4 w-4" />
							<span className="sr-only">返回首页</span>
						</a>
					</Button>
				</div>

				{error ? <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">{error}</div> : null}

				{loading ? (
					<Card>
						<CardContent className="py-6 text-sm text-muted-foreground">加载中...</CardContent>
					</Card>
				) : !post ? (
					<Card>
						<CardContent className="py-6 text-sm text-muted-foreground">帖子不存在</CardContent>
					</Card>
				) : (
					<>
						<Card className="border-violet-500/25 bg-gradient-to-br from-sky-500/15 via-violet-500/10 to-fuchsia-500/15 shadow-sm">
							<CardHeader>
								<CardTitle className="flex flex-col gap-2">
									<div className="flex flex-wrap items-center gap-2">
										{post.is_pinned ? (
											<span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200">
												<Pin className="h-3 w-3" />
												置顶
											</span>
										) : null}
										{Number(post.site_featured ?? 0) === 1 ? (
											<span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-cyan-500 to-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm">
												<Star className="h-3 w-3 fill-white" />
												官网精选
											</span>
										) : null}
										{user && user.id === post.author_id ? (
											<span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 px-2 py-0.5 text-[11px] font-medium text-white shadow-sm">
												<User className="h-3 w-3" />
												由我发布
											</span>
										) : null}
										{Number(post.is_visible ?? 1) === 0 ? (
											<span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
												<EyeOff className="h-3 w-3" />
												已隐藏
											</span>
										) : null}
										{user &&
										user.id === post.author_id &&
										getAuthorPublishRemainingMs(post, publishNowMs) > 0 ? (
											<span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:text-amber-100">
												核对倒计时 {formatCountdown(getAuthorPublishRemainingMs(post, publishNowMs))}
											</span>
										) : null}
										{post.category_name ? (
											<span className="inline-flex items-center rounded-full border border-white/40 bg-background/70 px-2 py-0.5 text-[11px] font-medium text-foreground backdrop-blur">
												{post.category_name}
											</span>
										) : null}
									</div>
									<span>{post.title}</span>
									<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-normal text-muted-foreground">
										<span className="inline-flex items-center gap-2">
											{post.author_avatar ? (
												<img
													src={post.author_avatar}
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
											<span className="text-foreground">{post.author_name}</span>
											{post.author_role === 'admin' ? (
												<span className="inline-flex items-center gap-1 rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
													<Shield className="h-3 w-3" />
													<span className="sr-only">管理员</span>
												</span>
											) : null}
										</span>
										<span>·</span>
										<span className="whitespace-nowrap">{formatDate(post.created_at)}</span>
									</span>
								</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="flex flex-wrap items-center gap-2">
									<Button variant={post.liked ? 'secondary' : 'outline'} size="sm" onClick={toggleLike} disabled={!user}>
										<Heart className="h-4 w-4 text-rose-600" fill={post.liked ? 'currentColor' : 'none'} />
										<span className="tabular-nums">{post.like_count || 0}</span>
										<span className="sr-only">{post.liked ? '取消点赞' : '点赞'}</span>
									</Button>
									<span className="inline-flex items-center gap-1 rounded-md border bg-muted/20 px-2 py-1 text-xs text-muted-foreground">
										<Eye className="h-4 w-4 text-emerald-600" />
										<span className="tabular-nums">{post.view_count || 0}</span>
										<span className="sr-only">观看数</span>
									</span>

									{user &&
									(user.role === 'admin' ||
										(user.id === post.author_id && Number(post.is_visible ?? 1) === 0)) ? (
										<>
											<Button variant="outline" size="sm" onClick={() => setIsEditing((v) => !v)}>
												{isEditing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
												<span className="sr-only">{isEditing ? '取消编辑' : '编辑'}</span>
											</Button>
										</>
									) : null}

									{user && (user.role === 'admin' || user.id === post.author_id) ? (
										<div className="relative z-30" ref={adminMenuRef}>
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() => setAdminMenuOpen((v) => !v)}
												aria-haspopup="menu"
												aria-expanded={adminMenuOpen}
											>
												<MoreVertical className="h-4 w-4" />
												<span className="sr-only">更多</span>
											</Button>
											{adminMenuOpen ? (
												<div className="absolute right-0 top-full z-[60] mt-2 max-h-64 w-44 overflow-y-auto rounded-md border bg-background p-1 shadow-lg">
													{(user.role === 'admin' ||
														(Number(post.is_visible ?? 1) === 1 &&
															Number(post.site_featured ?? 0) !== 1) ||
														(user.id === post.author_id &&
															getAuthorPublishRemainingMs(post, publishNowMs) > 0)) ? (
														<button
															type="button"
															className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
															onClick={() => void toggleVisibility()}
														>
															{Number(post.is_visible ?? 1) === 0 ? (
																<>
																	<Eye className="h-4 w-4" />
																	设为可见
																</>
															) : (
																<>
																	<EyeOff className="h-4 w-4" />
																	隐藏
																</>
															)}
														</button>
													) : null}
													{user.role === 'admin' ? (
														<button
															type="button"
															className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
															onClick={() => void toggleSiteFeature()}
														>
															<Star className="h-4 w-4" />
															{Number(post.site_featured ?? 0) === 1 ? '取消官网精选' : '官网精选'}
														</button>
													) : null}
													{user.role === 'admin' ? (
														<button
															type="button"
															className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
															onClick={togglePin}
														>
															<Pin className="h-4 w-4" />
															{post.is_pinned ? '取消置顶' : '置顶'}
														</button>
													) : null}
													{user.role === 'admin' || Number(post.site_featured ?? 0) !== 1 ? (
														<button
															type="button"
															className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
															onClick={() => {
																setAdminMenuOpen(false);
																void deletePost();
															}}
														>
															<Trash2 className="h-4 w-4" />
															删除
														</button>
													) : null}
													{user.role === 'admin' ? (
														<>
															<div className="my-1 h-px bg-border" />
															<div className="px-2 py-1 text-xs font-medium text-muted-foreground">移动到分类</div>
															{allCategories.map((c) => (
																<button
																	key={c.id}
																	type="button"
																	className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
																	onClick={() => void adminMovePostCategory(c.id)}
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

								{isEditing ? (
									<div className="space-y-3">
										{editError ? <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">{editError}</div> : null}
										<div className="space-y-2">
											<Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={30} />
										</div>
										<div className="space-y-2">
											<div className="flex flex-wrap items-center justify-end gap-2">
												<MarkdownToolbar
													isAdmin={!!isAdminEditor}
													previewOpen={editPreviewOpen}
													onTogglePreview={() => setEditPreviewOpen((v) => !v)}
													onAction={onEditorAction}
													onPickImage={() => editImageInputRef.current?.click()}
												/>
											</div>
											<input
												ref={editImageInputRef}
												type="file"
												accept="image/*"
												className="hidden"
												onChange={async (e) => {
													const file = e.target.files && e.target.files[0];
													e.target.value = '';
													if (!file) return;
													await handleEditImageFile(file);
												}}
											/>
											{uploadError ? <div className="text-sm text-destructive">{uploadError}</div> : null}
											{uploadLoading ? <div className="text-sm text-muted-foreground">上传中…</div> : null}
											<div className={editPreviewOpen ? 'grid gap-3 lg:grid-cols-2' : 'space-y-2'}>
												<Textarea
													ref={editContentRef}
													value={editContent}
													onChange={(e) => setEditContent(e.target.value)}
													onKeyDown={(e) =>
														handleMarkdownEditorKeyDown(e, {
															isAdmin: !!isAdminEditor,
															text: editContent,
															apply: applyEditResult
														})
													}
													rows={10}
												/>
												{editPreviewOpen ? (
													<div className="rounded-md border bg-muted/20 p-3">
														<div className="mb-2 text-xs font-medium text-muted-foreground">预览</div>
														<div
															ref={editPreviewRef}
															className="prose max-w-none break-words [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1"
															dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(editContent || '') }}
														/>
													</div>
												) : null}
											</div>
										</div>
										<Button onClick={saveEdit} disabled={editLoading}>
											{editLoading ? '保存中...' : '保存'}
										</Button>
									</div>
								) : (
									<div className="rounded-xl border border-white/40 bg-background/60 p-4 backdrop-blur-sm sm:p-5">
										<div
											className="prose max-w-none break-words [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1"
											ref={contentRef}
											dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(post.content || '') }}
										/>
									</div>
								)}
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>评论</CardTitle>
							</CardHeader>
							<CardContent className="space-y-4">
								{comments.length === 0 ? (
									<div className="text-sm text-muted-foreground">暂无评论</div>
								) : (
									<div className="space-y-3">
										{organizeComments(comments).map((c) => (
											<div key={c.id} className="rounded-md border p-3">
												<div className="flex gap-2">
													{c.avatar_url ? (
														<img
															src={c.avatar_url}
															alt=""
															className="mt-0.5 h-7 w-7 shrink-0 rounded-full object-cover"
															loading="lazy"
															referrerPolicy="no-referrer"
														/>
													) : (
														<span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
															<User className="h-4 w-4" />
														</span>
													)}
													<div className="min-w-0 flex-1">
														<div className="flex items-start justify-between gap-2">
															<div className="min-w-0 space-y-1">
																<div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
																	<span className="font-medium text-foreground">{c.username}</span>
																	{c.role === 'admin' ? (
																		<span className="inline-flex items-center gap-1 rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
																			<Shield className="h-3 w-3" />
																			<span className="sr-only">管理员</span>
																		</span>
																	) : null}
																	{Number(c.is_featured ?? 0) === 1 ? (
																		<span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-cyan-500 to-indigo-600 px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm">
																			<Star className="h-3 w-3 fill-white" />
																			官网精选
																		</span>
																	) : null}
																</div>
																<div className="text-xs text-muted-foreground">{formatDate(c.created_at)}</div>
															</div>
															<div className="-mr-1 -mt-1 flex shrink-0 items-center">
																<Button variant="ghost" size="sm" onClick={() => setReplyTo(c)}>
																	<Reply className="h-4 w-4" />
																	<span className="sr-only">回复</span>
																</Button>
																{user?.role === 'admin' ? (
																	<Button
																		variant="ghost"
																		size="sm"
																		onClick={() => void toggleCommentFeature(c.id, Number(c.is_featured ?? 0) === 1)}
																		title={Number(c.is_featured ?? 0) === 1 ? '取消官网精选' : '设为官网精选'}
																	>
																		<Star className={`h-4 w-4 ${Number(c.is_featured ?? 0) === 1 ? 'fill-sky-500 text-sky-600' : ''}`} />
																		<span className="sr-only">
																			{Number(c.is_featured ?? 0) === 1 ? '取消官网精选' : '设为官网精选'}
																		</span>
																	</Button>
																) : null}
																{user && (user.role === 'admin' || user.id === c.author_id) ? (
																	<Button variant="ghost" size="sm" onClick={() => deleteComment(c.id)}>
																		<Trash2 className="h-4 w-4" />
																		<span className="sr-only">删除</span>
																	</Button>
																) : null}
															</div>
														</div>
														<div className="mt-2 whitespace-pre-wrap text-sm">{c.content}</div>
														{c.replies && c.replies.length ? (
															<div className="mt-3 space-y-2 border-l pl-3">
																{c.replies.map((r) => (
																	<div key={r.id} className="rounded-md bg-muted/30 p-2">
																		<div className="flex gap-2">
																			{r.avatar_url ? (
																				<img
																					src={r.avatar_url}
																					alt=""
																					className="mt-0.5 h-5 w-5 shrink-0 rounded-full object-cover"
																					loading="lazy"
																					referrerPolicy="no-referrer"
																				/>
																			) : (
																				<span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
																					<User className="h-3.5 w-3.5" />
																				</span>
																			)}
																			<div className="min-w-0 flex-1">
																				<div className="flex items-start justify-between gap-2">
																					<div className="min-w-0 space-y-0.5">
																						<div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
																							<span className="font-medium text-foreground">{r.username}</span>
																							{r.role === 'admin' ? (
																								<span className="inline-flex items-center gap-1 rounded border border-indigo-500/30 bg-indigo-500/10 px-1 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
																									<Shield className="h-3 w-3" />
																									<span className="sr-only">管理员</span>
																								</span>
																							) : null}
																						</div>
																						<div className="text-[11px] text-muted-foreground">{formatDate(r.created_at)}</div>
																					</div>
																					{user && (user.role === 'admin' || user.id === r.author_id) ? (
																						<Button variant="ghost" size="sm" className="-mr-1 -mt-1 shrink-0" onClick={() => deleteComment(r.id)}>
																							<Trash2 className="h-4 w-4" />
																							<span className="sr-only">删除</span>
																						</Button>
																					) : null}
																				</div>
																				<div className="mt-1 whitespace-pre-wrap text-sm">{r.content}</div>
																			</div>
																		</div>
																	</div>
																))}
															</div>
														) : null}
													</div>
												</div>
											</div>
										))}
									</div>
								)}

								{replyTo ? (
									<div className="flex items-center justify-between rounded-md border bg-muted/30 p-2 text-sm">
										<span>
											回复 <span className="font-medium">{replyTo.username}</span>
										</span>
										<Button variant="ghost" size="sm" onClick={() => setReplyTo(null)}>
											取消
										</Button>
									</div>
								) : null}

								<form className="space-y-3" onSubmit={submitComment}>
									{commentError ? <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">{commentError}</div> : null}
									<Textarea value={newComment} onChange={(e) => setNewComment(e.target.value)} rows={4} placeholder="写下你的评论..." />
						<TurnstileWidget enabled={turnstileActive} siteKey={siteKey} onToken={setTurnstileToken} resetKey={turnstileResetKey} />
									<div className="flex items-center gap-2">
										<Button type="submit" disabled={commentLoading}>
											{commentLoading ? '发布中...' : '发布评论'}
										</Button>
										{!user ? (
											<Button type="button" variant="outline" onClick={() => (window.location.href = '/login')}>
												登录后评论
											</Button>
										) : null}
									</div>
								</form>
							</CardContent>
						</Card>
					</>
				)}
			</div>
		</PageShell>
	);
}