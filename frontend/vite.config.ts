import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAdminPanelPath } from '../shared/admin-panel-path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADMIN_PANEL_PATH = getAdminPanelPath(process.env.VITE_ADMIN_PANEL_PATH || process.env.ADMIN_PANEL_PATH);

function copyStaticSiteFiles(): Plugin {
	return {
		name: 'copy-static-site-files',
		closeBundle() {
			const staticDir = path.resolve(__dirname, '..', 'static');
			const publicDir = path.resolve(__dirname, '..', 'public');
			// Vite emits admin.html from source name; rename to obscure public entry
			const builtAdmin = path.join(publicDir, 'admin.html');
			const obscureAdmin = path.join(publicDir, `${ADMIN_PANEL_PATH}.html`);
			if (fs.existsSync(builtAdmin)) {
				fs.renameSync(builtAdmin, obscureAdmin);
			}
			for (const name of ['_redirects', '_headers', 'robots.txt']) {
				const src = path.join(staticDir, name);
				const dest = path.join(publicDir, name);
				if (fs.existsSync(src)) {
					fs.copyFileSync(src, dest);
				}
			}
			// Keep robots.txt in sync with the actual admin slug
			const robotsPath = path.join(publicDir, 'robots.txt');
			if (fs.existsSync(robotsPath)) {
				let robots = fs.readFileSync(robotsPath, 'utf8');
				robots = robots
					.replace(/Disallow: \/c-ops-k7m2xq(\.html)?/g, '')
					.replace(/\n{3,}/g, '\n\n');
				if (!robots.includes(`Disallow: /${ADMIN_PANEL_PATH}`)) {
					robots = robots.replace(
						'Disallow: /admin.html\n',
						`Disallow: /admin.html\nDisallow: /${ADMIN_PANEL_PATH}\nDisallow: /${ADMIN_PANEL_PATH}.html\n`
					);
				}
				fs.writeFileSync(robotsPath, robots);
			}
			const headersPath = path.join(publicDir, '_headers');
			if (fs.existsSync(headersPath) && ADMIN_PANEL_PATH !== 'c-ops-k7m2xq') {
				let headers = fs.readFileSync(headersPath, 'utf8');
				headers = headers.replaceAll('c-ops-k7m2xq', ADMIN_PANEL_PATH);
				fs.writeFileSync(headersPath, headers);
			}
		}
	};
}

export default defineConfig({
	plugins: [react(), copyStaticSiteFiles()],
	root: path.resolve(__dirname, 'pages'),
	publicDir: false,
	build: {
		outDir: path.resolve(__dirname, '..', 'public'),
		emptyOutDir: true,
		assetsDir: 'assets',
		modulePreload: {
			polyfill: false
		},
		rollupOptions: {
			input: {
				index: path.resolve(__dirname, 'pages', 'index.html'),
				login: path.resolve(__dirname, 'pages', 'login.html'),
				register: path.resolve(__dirname, 'pages', 'register.html'),
				forgot: path.resolve(__dirname, 'pages', 'forgot.html'),
				reset: path.resolve(__dirname, 'pages', 'reset.html'),
				post: path.resolve(__dirname, 'pages', 'post.html'),
				settings: path.resolve(__dirname, 'pages', 'settings.html'),
				// Obscure filename so /admin is not auto-served by Pages
				[ADMIN_PANEL_PATH]: path.resolve(__dirname, 'pages', 'admin.html')
			}
		}
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, 'src')
		}
	}
});
