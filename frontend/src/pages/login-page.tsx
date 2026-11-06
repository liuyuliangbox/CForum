import * as React from 'react';

import { TurnstileWidget } from '@/components/turnstile';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useConfig } from '@/hooks/use-config';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { getSecurityHeaders } from '@/lib/api';
import { setToken, setUser } from '@/lib/auth';

type LoginStep = 'credentials' | 'totp';

export function LoginPage() {
	const { config } = useConfig();
	useDocumentTitle('登录');
	const [step, setStep] = React.useState<LoginStep>('credentials');
	const [email, setEmail] = React.useState('');
	const [password, setPassword] = React.useState('');
	const [totpCode, setTotpCode] = React.useState('');
	const [turnstileToken, setTurnstileToken] = React.useState('');
	const [turnstileResetKey, setTurnstileResetKey] = React.useState(0);
	const [loading, setLoading] = React.useState(false);
	const [error, setError] = React.useState('');

	const enabled = !!config?.turnstile_enabled;
	const siteKey = config?.turnstile_site_key || '';
	const turnstileActive = enabled && !!siteKey;

	function resetTurnstile() {
		setTurnstileToken('');
		setTurnstileResetKey((v) => v + 1);
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError('');
		if (turnstileActive && !turnstileToken) {
			setError('请完成验证码验证');
			return;
		}
		if (step === 'totp' && !totpCode.trim()) {
			setError('请输入 2FA 验证码');
			return;
		}
		setLoading(true);
		try {
			const res = await fetch('/api/login', {
				method: 'POST',
				headers: getSecurityHeaders('POST'),
				body: JSON.stringify({
					email,
					password,
					...(step === 'totp' ? { totp_code: totpCode.trim() } : {}),
					'cf-turnstile-response': turnstileToken
				})
			});
			const data = (await res.json()) as any;
			if (!res.ok) {
				resetTurnstile();
				if (data?.error === 'TOTP_REQUIRED') {
					setStep('totp');
					setTotpCode('');
					setError('');
					return;
				}
				if (data?.error === 'Invalid TOTP code') {
					setError('验证码错误，请重试');
					return;
				}
				throw new Error(data?.error || '登录失败');
			}

			setUser(data.user);
			setToken(data.token);
			window.location.href = '/';
		} catch (err: any) {
			setError(String(err?.message || err));
		} finally {
			setLoading(false);
		}
	}

	function backToCredentials() {
		setStep('credentials');
		setTotpCode('');
		setError('');
		resetTurnstile();
	}

	return (
		<div className="min-h-dvh bg-muted/20">
			<main className="mx-auto flex max-w-5xl justify-center px-4 py-10">
				<Card className="w-full max-w-md">
					<CardHeader>
						<CardTitle>{step === 'totp' ? '两步验证' : '登录'}</CardTitle>
					</CardHeader>
					<CardContent>
						<form className="space-y-4" onSubmit={handleSubmit}>
							{error ? (
								<div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
									{error}
								</div>
							) : null}

							{step === 'credentials' ? (
								<>
									<div className="space-y-2">
										<Label htmlFor="login-email">邮箱</Label>
										<Input
											id="login-email"
											name="email"
											type="email"
											autoComplete="username"
											value={email}
											onChange={(e) => setEmail(e.target.value)}
											required
										/>
									</div>

									<div className="space-y-2">
										<Label htmlFor="login-password">密码</Label>
										<Input
											id="login-password"
											name="password"
											type="password"
											autoComplete="current-password"
											value={password}
											onChange={(e) => setPassword(e.target.value)}
											required
										/>
									</div>
								</>
							) : (
								<>
									<p className="text-sm text-muted-foreground">
										账号 <span className="font-medium text-foreground">{email}</span> 已开启两步验证，请输入验证器中的 6 位验证码。
									</p>
									<div className="space-y-2">
										<Label htmlFor="login-totp">验证码</Label>
										<Input
											id="login-totp"
											name="totp_code"
											type="text"
											inputMode="numeric"
											pattern="\d*"
											maxLength={6}
											placeholder="000000"
											autoComplete="one-time-code"
											autoFocus
											value={totpCode}
											onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
											required
										/>
									</div>
								</>
							)}

							<TurnstileWidget
								enabled={turnstileActive}
								siteKey={siteKey}
								onToken={setTurnstileToken}
								resetKey={turnstileResetKey}
							/>

							<Button className="w-full" type="submit" disabled={loading}>
								{loading ? '处理中...' : step === 'totp' ? '验证并登录' : '登录'}
							</Button>

							{step === 'totp' ? (
								<Button type="button" variant="ghost" className="w-full" onClick={backToCredentials} disabled={loading}>
									返回上一步
								</Button>
							) : (
								<div className="flex justify-between text-sm">
									<a className="text-muted-foreground hover:underline" href="/register">
										没有账号？注册
									</a>
									<a className="text-muted-foreground hover:underline" href="/forgot">
										忘记密码？
									</a>
								</div>
							)}
						</form>
					</CardContent>
				</Card>
			</main>
		</div>
	);
}
