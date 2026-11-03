# 绑定 bbs.aridjaya.eu.org 到 CForum

论坛已部署：

- Pages：https://cforum-cae.pages.dev
- Worker：https://cforum.563021874.workers.dev

## 1. 绑定自定义域

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**
2. 进入 Pages 项目 **`cforum-cae`**（不是空的 `cforum`）
3. **Custom domains** → **Set up a domain** → 输入 `bbs.aridjaya.eu.org`
4. 按提示完成 DNS（域名已在 Cloudflare 时通常自动添加 CNAME）

## 2. 去掉旧的 GitHub 跳转

若之前把 `bbs` 301 到 GitHub Discussions：

1. **Rules** → **Redirect Rules**
2. 删除/禁用 hostname = `bbs.aridjaya.eu.org` 且目标为 GitHub 的规则

否则自定义域会一直跳到 Discussions，进不了论坛。

## 3. 默认管理员（登录后立刻改密）

- 邮箱：`admin@adysec.com`
- 密码：`Admin@123`

## 4. 验收

- https://cforum-cae.pages.dev 能看帖
- https://bbs.aridjaya.eu.org 打开的是同一套论坛（不再跳 GitHub）
- 官网 https://game.aridjaya.eu.org/community/ 的论坛链接可新窗口打开
