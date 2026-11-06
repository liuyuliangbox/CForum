/**
 * Cloudflare Pages 部署配置
 * 支持本地开发和部署
 * 
 * 使用说明：
 * - 本地开发: npm run dev:pages
 * - 部署 Pages: wrangler pages deploy
 */

export default {
	// Pages 项目配置
	projectName: 'cforum-cae',
	
	// 构建配置
	build: {
		command: 'npm run build:frontend',
		outputDir: 'public'
	},
	
	// 开发配置
	dev: {
		port: 3010,
		local: true
	},
	
	// 路由配置
	routing: {
		// API 路由转发到 Functions
		'/api/*': 'functions/[[path]]',
		'/r2/*': 'functions/[[path]]',
		'/user': 'functions/[[path]]',
		'/user/*': 'functions/[[path]]',
		'/post/*': 'functions/[[path]]',
		'/settings': 'functions/[[path]]',
		'/admin': 'functions/[[path]]',
		'/admin.html': 'functions/[[path]]',
		'/c-ops-k7m2xq': 'functions/[[path]]',
		'/c-ops-k7m2xq.html': 'functions/[[path]]',
		
		// 静态资源从 public 返回
		'*': 'public/*'
	}
};
