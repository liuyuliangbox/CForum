# 绑定 bbs.aridjaya.eu.org 到 CForum

论坛已部署：

- Pages 项目名：**`cforum`**
- 生产子域：https://cforum-cae.pages.dev
- 自定义域：https://bbs.aridjaya.eu.org
- Worker：https://cforum.563021874.workers.dev

> 账号里另有试验项目 `cforum-cae`（`cforum-cae-8ng.pages.dev`）。线上与 bbs 以项目 **`cforum`** 为准。

## 1. 绑定自定义域

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**
2. 进入 Pages 项目 **`cforum`**
3. **Custom domains** → 确认已有 `bbs.aridjaya.eu.org`
4. 若没有：Set up a domain → 输入 `bbs.aridjaya.eu.org`

## 2. 去掉旧的 GitHub 跳转

若之前把 `bbs` 301 到 GitHub Discussions：

1. **Rules** → **Redirect Rules**
2. 删除/禁用 hostname = `bbs.aridjaya.eu.org` 且目标为 GitHub 的规则

## 3. 默认管理员（登录后立刻改密）

- 邮箱：`admin@adysec.com`
- 密码：`Admin@123`

## 4. 验收

- https://cforum-cae.pages.dev 与 https://bbs.aridjaya.eu.org 打开同一套论坛
- 首页可见分类芯片（默认展开）与置顶区
