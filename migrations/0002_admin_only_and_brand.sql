-- Brand settings (safe to re-run via INSERT OR IGNORE in worker; this is for wrangler migrate)
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_title', 'liuyuliangbox / Project Turn');
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_tagline', '由 Cloudflare Workers、Pages、D1、R2 提供服务。');
