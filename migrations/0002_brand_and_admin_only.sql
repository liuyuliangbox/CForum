-- Brand settings (admin_only column is added at runtime in ensureSchema for compat)
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_title', 'liuyuliangbox / Project Turn');
INSERT OR IGNORE INTO settings (key, value) VALUES ('site_tagline', '由 Cloudflare Workers、Pages、D1、R2 提供服务。');

INSERT OR IGNORE INTO categories (name) VALUES ('开发进度');
INSERT OR IGNORE INTO categories (name) VALUES ('玩法建议');
INSERT OR IGNORE INTO categories (name) VALUES ('Bug/体验');
INSERT OR IGNORE INTO categories (name) VALUES ('美术氛围');
INSERT OR IGNORE INTO categories (name) VALUES ('闲聊/招募');
