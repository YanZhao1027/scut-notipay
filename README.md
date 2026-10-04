# scut-notipay

基于 Node.js 与 node-napcat-ts 的应用程序，用于查询并提醒华南理工大学广州国际校区与大学城校区的宿舍缴费事项。

## 配置

`config.json` 内容如下：

```json
{
  "napcatWs": "ws://127.0.0.1:3001",
  "napcatToken": "your_napcat_token",
  "encryptionKey": "your_encryption_key",
  "commandNames": ["scut-notipay", "snp"],
  "billingRetryCount": 3
}
```

## 代理配置

如果需要通过代理访问网络，可以设置以下环境变量：

### HTTP/HTTPS 代理

```bash
# 支持基本认证的代理格式
export HTTP_PROXY=http://username:password@proxy-host:port
# 或
export HTTPS_PROXY=http://username:password@proxy-host:port
```

**HTTP 代理 URL 格式示例：**

- 无认证：`http://proxy.example.com:8080`
- 基本认证：`http://user:pass@proxy.example.com:8080`

### SOCKS5 代理

```bash
# 支持基本认证的 SOCKS5 代理格式
export SOCKS_PROXY=socks5://username:password@proxy-host:port
# 或
export SOCKS5_PROXY=socks5://username:password@proxy-host:port
```

**SOCKS5 代理 URL 格式示例：**

- 无认证：`socks5://proxy.example.com:1080`
- 基本认证：`socks5://user:pass@proxy.example.com:1080`

**注意：** SOCKS 代理优先级高于 HTTP 代理。如果同时设置了两种代理，将使用 SOCKS 代理。

应用程序将自动检测并使用配置的代理进行所有 HTTP/HTTPS 请求。

## Cloudflare Web 版本

Web 版与原 QQ Bot 使用独立的 `worker/index.ts` 入口。它不加载 Bot、SQLite、Node 原生模块或定时任务；在线查询只在浏览器发起 HTTP 请求时运行，不配置 Cron。

### 环境要求

- Node.js 20 或更新版本
- pnpm（仓库声明的版本为 10.15.0）
- Cloudflare 账户及 Wrangler 4

### 本地运行

```bash
pnpm install
pnpm web:dev
```

打开 Wrangler 输出的本地地址。登录功能需要本地 secret，可先生成 32 字节随机密钥，再运行 `wrangler secret put SESSION_SECRET` 并粘贴密钥：

```bash
openssl rand -hex 32
```

### 部署到 workers.dev

```bash
pnpm exec wrangler login
pnpm exec wrangler secret put SESSION_SECRET
pnpm web:deploy
```

`SESSION_SECRET` 必须是 32 字节随机值（64 位十六进制或标准 Base64），用于 AES-GCM 加密 HttpOnly 会话 Cookie。不要把它写进 Git、`.env` 或浏览器代码。部署默认启用 `workers.dev`。

### 自定义域名

先在 Cloudflare 控制台确认子域名没有现有生产路由，再进入 Worker 的 **Settings → Domains & Routes → Add → Custom Domain** 添加独立子域名，例如 `scut-pay.<你的域名>`。不要把自定义域名的根域或已有生产路由改绑到此 Worker。

### API 与会话

- `GET /api/health`
- `GET /api/auth/captcha`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/refresh`
- `GET /api/auth/session`
- `GET /api/bills`
- 调试时可用 `GET /api/debug/scut-egress`；仅在配置 `DEBUG_SECRET` 并通过 `X-Debug-Secret` 发送密钥时启用，不配置该 secret 时固定返回 404。响应只包含上游状态码及有限响应头元数据。

没有 D1。Worker 使用 AES-GCM 加密 Cookie 保存短期 token、必要 Cookie 与校区；Cookie 为 `HttpOnly; Secure; SameSite=Lax`。一卡通密码只用于 POST 登录，在请求处理完后清空，不写入数据库或浏览器存储。若 refresh 不可用，登录态过期后需要重新认证，不会自动重新提交密码。

登录页启动时会请求一次 `/api/auth/captcha`，并检查 keyboard 接口是否可用；只有两项依赖都可用时才启用账号与密码输入。此请求可能返回一次验证码供用户登录时使用。

### 自动刷新与缓存

自动刷新默认关闭，周期由用户选择。它只由当前打开的前端页面运行；页面不可见时暂停，返回前台或联网恢复后在超期时补查。API 响应使用 `Cache-Control: no-store`；当前没有 Service Worker，也不会缓存余额或认证响应。

### 检查

```bash
pnpm run check:web
pnpm run test:web
SCUT_INTEGRATION_TEST=1 pnpm run test:web
```

集成测试只获取一张验证码，不提交账号或密码。

### 已知限制

- **Cloudflare 出口实测（2026-10-04）：** 本机请求验证码与 keyboard 接口均为 HTTP 200；Cloudflare Worker 请求两者均为 HTTP 403（`text/html`, `Server: cloudflare`，分别约 1.8 秒和 0.8 秒）。`GET /api/auth/captcha` 因上游拒绝返回 HTTP 502 `UPSTREAM_UNAVAILABLE`。浏览器从 workers.dev 页面直接请求验证码接口时学校返回 HTTP 200，但未提供 `Access-Control-Allow-Origin`，Chrome 拦截响应，属于 `CLIENT_REACHABLE_BUT_CORS_BLOCKED`；整体架构结论为 **`PURE_CF_BLOCKED`**。Web 登录按钮现在会先预取验证码并检查 keyboard 依赖，任一失败就禁用账号/密码输入与登录按钮，并提示“当前服务器无法连接华工一卡通，请勿继续输入密码。”临时网络探测 Worker 已在测试后删除。
- Worker 请求 `dfyc.utc.scut.edu.cn/` 得到 HTTP 200（约 4.0 秒），随后两次 302 跳转到 `frontend_static/frontend/login/cas_login.html`。这只验证了 Cloudflare 到 DXC 登录入口的网络可达性；尚未验证有效账号登录、完整 SSO/JSESSIONID、水电查询或刷新后的会话重建。
- 已在 SCUT 官方 `plat-pc` JavaScript 中确认验证码读取接口，但该页面没有暴露一卡通账号登录表单。登录验证码字段仍需要真实账号的一次受控成功/失败验证；当前实现采用 `captcha_header_code` 与 `captcha_header_key` 候选字段。一次使用虚构账号、错误验证码的低频探测返回 HTTP 400 和通用凭据错误，不能证明字段已被学校端识别。
- `refresh_token` 的有效性、轮换行为与刷新后的 GZIC/DXC 查询尚未通过有效学生会话验证。刷新失败会返回 `REAUTH_REQUIRED`，不会触发密码重试。
- DXC SSO 重定向按 Bot 现有流程移植，需用有效大学城账号验证 302 链、JSESSIONID 和刷新后重建会话。若学校侧或 Cloudflare 出口拒绝请求，不会尝试绕过。

余额解析沿用 Bot 当前字段关系；展示保留接口返回的金额数值，不做单位换算。
