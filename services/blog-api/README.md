# 博客评论与访问量 API

Cloudflare Worker + D1；运行时代码无 npm 依赖。注册范围是 `collection.yaml` 中的 211 篇文章和 1 个页面。评论统一存储、读取和管理于 D1；文章仍以仓库内每篇 Markdown + YAML 为正式源。读者填写昵称和正文即可提交评论，所有新提交必须由站主审核后公开。

统一评论、评论管理和 30 天管理员会话已于 2026-10-26 部署，生产核验见[管理后台批次](../../migration/admin-workspace-2026-10-26.md)。运行命令见[根 README](../../README.md#build-and-check)。

## 接口

公开 POST 要求允许的 `Origin` 和 `Content-Type: application/json`。默认允许正式站来源；本地验收只显式加入指定的 8791 来源，不允许任意 localhost 端口。管理页面先以账号、密码调用登录接口，随后统一使用 `Authorization: Bearer <session-token>`；原 `ADMIN_TOKEN` Bearer 保留给已有管理脚本。昵称、GitHub 账号和前端开关都不授予管理权限，接口不使用 Cookie 登录。

| 请求 | 行为 |
|---|---|
| `GET /v1/comments?document=1154&cursor=0` | 返回同文全部已公开评论，按创建时间及稳定序号分页，每页最多 100 条 |
| `POST /v1/comments` | 创建待审核评论，成功为 `202 {id,status:"pending"}` |
| `POST /v1/admin/login` | 接受 `{username:"admin",password}`，成功返回随机会话和绝对到期时间 |
| `GET /v1/admin/session` | 验证会话并返回 `authenticated` 和 `expires_at`。原密码 Bearer 的兼容响应不含到期时间 |
| `DELETE /v1/admin/session` | 撤销当前会话，成功返回 `{logged_out:true}`；不撤销其他设备的独立会话 |
| `GET /v1/admin/comments?status=all&document=1154&q=关键词&cursor=0` | 全部评论管理，`status` 默认 `all`，可选三种状态、文章和昵称/正文子串搜索；按序号倒序，每页最多 100 条 |
| `POST /v1/admin/comments/<ID>/approve` | 公开评论；其父评论须仍在同文且已公开 |
| `POST /v1/admin/comments/<ID>/reject` | 拒绝该评论，连同文内全部回复后代一起隐藏 |
| `DELETE /v1/admin/comments/<ID>` | 删除该评论及同文全部回复后代 |
| `DELETE /v1/admin/comments/<ID>?only_if_no_replies=true` | 原子删除单条无回复评论，有回复时返回 `409 comment_has_replies` |
| `GET /v1/visits?document=1154` | 返回统计开关及基线加增量；省略文档 ID 时只返回全站数 |
| `GET /v1/visits/ranking` | 只读文章累计访问量前十，无查询参数；同量按数字 ID 升序 |
| `GET /v1/visits/daily?range=30` | 只读北京时间每日全站 PV；range 为 7、30、year 或 all，默认 30 |
| `POST /v1/visits` | 明确启用且已有完整基线后，按单次加载 nonce 幂等计数 |
| `POST /v1/admin/visits/baseline` | 显式确认并原子导入完整独立基线；不同基线禁止覆盖 |
| `POST /v1/admin/visits/history` | 管理员确认后原子导入逐日历史；内容一致可重复，不同内容禁止覆盖 |
| `GET /admin` | 与 `/blog/comment/` 共享界面源码的备用评论管理入口 |

公开评论形状：

```json
{"comments":[{"id":"wp-4379","document":"116","nickname":"读者","body":"纯文本正文","body_html":"<p>安全化的既有正文</p>","author_url":"","parent_id":null,"created_at":"2020-03-04T12:08:18.000Z"}],"next_cursor":null}
```

`document` 为已注册文档 ID 字符串。评论 ID 可以是原有稳定的 `wp-N` 或 UUID；界面不显示来源分类。公开接口不返回状态、请求哈希、待审内容或私人元数据。`next_cursor` 非空时作为整数传入下一页。公开分页以游标对应的创建时间和序号作锚，因此晚导入的较早评论也不会因序号较大而遗漏。锚记录已删除或不属于该文档时返回 `invalid_cursor`，调用者需重新加载。

管理员列表在评论中额外返回 `status`、`moderated_at`，并返回 `counts:{all,pending,approved,rejected}` 与 `documents:[{id,title,url}]`。`counts` 受 `document`、`q` 筛选影响，不受 `status` 影响；文档目录含所有已注册文章和页面，包括零评论文档。标题从维护源生成的公开注册表读取，链接由固定 ID 和类型构造。`q` 最多 200 个字符，按昵称或正文做数据库内的字面子串搜索，不把 `%` 等作为通配符。筛选参数不能重复。管理游标只在序号递减方向继续翻页，与公开评论的时间排序分别维护。

新评论仅接受：

```json
{"document":"1154","nickname":"读者","body":"评论正文","parent_id":null,"request_id":"本次提交与重试复用的 UUID","website":""}
```

昵称 trim 后必填，最多 40 个 Unicode 字符；正文 trim 后必填，最多 10,000 字符，保留换行。拒绝控制字符和额外字段，包括 `status`、`body_html`、`author_url`、IP 等。新提交的 HTML 按文字展示；公开界面仅为离线安全化的既有 HTML 做白名单 DOM 重建。动态 TeX 使用本地 KaTeX，`trust:false`。管理列表以纯文本显示评论。

`website` 是隐藏蜜罐，非空时返回表面接受但不入库。相同 `request_id` 与相同内容重试返回原 ID，不重复入库或计频控；内容不同时返回 `409 request_conflict`。回复父节点只能来自 `comments` 中同文已公开记录；最小 `legacy_parents` 投影不再授予回复权限，拒绝或删除过的父节点不能继续接收回复。

错误形状为 `{error:"稳定错误码",message:"说明"}`。常见状态包括内容错误 `400`、未认证 `401`、来源不允许 `403`、未注册文档 `404`、回复或幂等冲突 `409`、频控 `429` 和配置缺失 `503`。接口响应使用 `Cache-Control: no-store`，错误响应不返回真实凭据。

## 统一评论与公开校验材料

`content/blog/comments/` 的 117 条已公开评论是原始校验材料，其中 43 条为回复。离线导入工具只从正式公开集合与这些白名单 YAML 读取数据，安全化正文、将已注册文内/资源链接映射到本地，并保留姓名、作者网址、完整时间和父子关系。不读取 WordPress 后台，不接受邮箱、IP、账户、用户代理或审核导出。

生成的 `data/unified-comments.json` 和 `.sql` 是公开导入资产，不是运行时评论源。`0002_unified_comments.sql` 为同一 `comments` 表增加 `body_html` 和 `author_url`，所有现有新评论仍保留。一次导入通过单条 SQL 及触发器事务完成；导入正文的临时 payload 随事务完成置空，仅保留批次/ID 哈希。

已导入记录不再被源快照覆盖。重复同批导入不改变审核、拒绝或删除结果；后续批次也不能重建已导入过的 ID。冲突哈希使整次操作失败回滚。删除评论后仍保留不可逆的最小导入标记以阻止复活，不保留第二份导入 payload。公开 YAML/JSON 保留原先已公开内容，仅供校验，不能回填新评论或未公开内容。

静态页面不嵌入评论正文兜底，防止拒绝/删除后在离线、无脚本或 API 失败时仍显示原评论。所有评论由同一公开接口读取，并在同一个 `/blog/comment/` 界面管理。

## 管理密码与浏览器

评论管理入口为 `/blog/comment/`。固定账号为 `admin`，密码为 `ADMIN_TOKEN`。标准表单提供 `autocomplete="username"` 与 `autocomplete="current-password"`，成功认证后在支持的浏览器请求保存凭据。

Chrome 可依其设置提示保存并在以后自动填入；不能保证每台机器或每次登录都出现提示。密码保存由浏览器密码管理器负责，站点不把原密码写入 URL、Cookie、localStorage 或 sessionStorage。

登录成功返回 `{authenticated:true,token:"bs_...",expires_at:"ISO时间"}`。会话由 32 个随机字节生成，自创建起有效 30 天。D1 的 `admin_sessions` 仅保存以 `ADMIN_TOKEN` 为密钥的 token HMAC、创建和到期时间。修改密码使旧会话失效，主动撤销会删除对应记录。

同源评论管理页在 localStorage 保存会话 token 与到期时间，存储键绑定固定 API 地址。重新打开时先验证会话，再载入管理数据。主动退出清除本机缓存并请求服务器撤销，其他同源管理页通过 storage 事件同步。网络失败时提示本机已退出、服务器撤销未确认。迟到的登录或恢复响应不能重建已退出或已替换的会话。会话失效后清除管理列表并显示登录表单。禁用存储时会话仅在当前页面可用。

本机 DPAPI 备份在仓库外 `%USERPROFILE%\.config\xht37-blog-api\admin-token.dpapi`，只可由创建它的 Windows 用户解密。取用命令见[密码说明](../../README.md#administrator-password)，不要把密码发到聊天或写入仓库。`RATE_LIMIT_SALT` 的加密备份也保存在该私有目录。

静态页和 Worker 的评论管理界面共用 `src/admin*.mjs`。客户端脚本以原始字符串共享，避免 Wrangler 打包时注入辅助函数影响序列化。生成页只含空界面和固定 API 配置，CSP 限定资源和 API 来源。页面为 `noindex`，禁用 referrer，并阻止在外站 iframe 中输入密码。LF 和生成器哈希用于检查跨平台字节一致性。

## 频控、本地验证与部署边界

评论每个地址 15 分钟最多 5 次新请求，管理员登录每个地址 15 分钟最多 10 次尝试（成功和失败均计入），Visits 预备限制每分钟 120 次。新评论与频控配额在同一事务中提交，并发重试只占一次。仅在短期桶中保存带私密盐的地址 SHA-256，不保存原 IP；后续写请求清理过期一天以上桶。Cloudflare 使用可信入口的 `CF-Connecting-IP`；本机桥接强制连接地址，忽略调用者伪造的头。JSON 流式限长，不能靠遗漏 Content-Length 绕过。登录请求限 2048 字节，除 loopback 开发外要求 HTTPS。

所有新评论须审核。`ADMIN_TOKEN` 和 `RATE_LIMIT_SALT` 存在 Worker secrets 或仓库外私有位置。待审内容、数据库导出和会话同样不能进入仓库，包括忽略目录。

本地测试覆盖 SQLite 外键、唯一约束、事务、JSON1、触发器、评论客户端、会话绝对到期与撤销、权限、幂等、重复导入和回复删除。实际 workerd 回归覆盖临时 D1 的登录、恢复和撤销。运行命令与工具链要求见[构建与校验](../../README.md#build-and-check)。本机桥接只监听 loopback，自动导入公开集合和统一评论，SQLite 数据库位于仓库外。

部署遵循根 README 的[部署顺序](../../README.md#authorized-deployment-order)。远程冒烟只可在授权窗口使用虚构留言和精确叶节点清理，命令见[远程检查](../../README.md#remote-smoke-check)。待审评论不得作为公开测试证据。

## Visits

每日统计使用 Asia/Shanghai 日期，响应包含 `enabled`、`seeded`、`history_seeded`、`as_of`、首日与返回范围及 `items`。`7`／`30` 按日回溯；`year` 从 11 个月前的月初到今天（包含本月的最近 12 个自然月），并裁到实际首日；`all` 最多返回最近 20000 天。接口始终返回日明细，网页将 `year` 按月、`all` 按年求和，保留未知日和不完整时段提示。历史缺项保留 `visits:null`；首日、切流日、今天以及源标记的不完整日期标记 `partial:true`。切流日合并历史部分与切流后新站事件；新站每个事件只计一次，并排除响应时间之后的事件。历史未导入时返回空序列。查询不写数据库。前后统计方式不同，基线算术对账不证明访问采集完整性或口径一致；切流后 WordPress 记录是否与新站重复仍待核实。

历史导入接受 `confirm_import:true`、`batch_id` 和规范化内容 `timezone`、`captured_at`、`site_base`、`first_date`、`cutover_date`、`items`；每日连续、非空值之和等于原全站基线，且基线数值与原始时间须精确匹配。末日必须标记 partial；相同内容不受 batch ID 影响而幂等，不同内容拒绝。私有输入不得放进公开仓库。`scripts/import-history.mjs --input <仓库外规范化 JSON> --batch <id>` 默认离线检查；只有同时给出 `--apply --confirm-history --api <服务 origin>` 才发送，管理员令牌仅从 `BLOG_ADMIN_TOKEN` 环境变量读取。部署读取历史表的 Worker 前须先应用 `0004_visit_history.sql`；历史导入及部署需要单独授权。

2026-10-31 正式切流已完成：完整的 212 篇文档与独立全站 1,869,365 PV 基线已导入，Worker 和网页统计均已开启，旧域名公开白名单已 301 跳转；精确发布与线上核验见[切流记录](../../migration/domain-visits-2026-10-31.md)。GET 返回基线加增量，POST 对同一 nonce 只计一次；无文档 ID 的博客索引页只增加全站 PV。全站访问量显示在博客主页，个人主页和评论管理页不参与计数；刷新博客阅读页产生新 PV。关闭配置仍能停用：GET 返回 `{enabled:false,seeded:false,site:null,document:null,document_id:...}`，POST 返回 `404 visits_disabled`；启用但缺基线仍返回 `null` 并拒绝计数，不冒充 0。

`GET /v1/visits/ranking` 返回 `{enabled,seeded,items:[{document,visits}]}`，固定最多十篇。累计值为每篇继承基线加新站增量，按值降序、数值 ID 升序排列；文章必须同时属于代码公开注册表和 D1 的 `post` 集合，不含页面或未知文档。响应仅带公开文章 ID 和次数，标题与链接由博客主页的维护内容提供。关闭或未导入基线时 `items` 为空且 `seeded:false`；已有全站基线但合格文章基线缺失时返回 `503 baseline_incomplete`，不展示不完整排行。完整性与名次来自同一次 SQLite 读快照，读取不写计数、事件、频控或其他表；关闭时不访问数据库。端点不接受查询参数，除原有 CORS 预检外仅接受 GET。

原始基线包含旧站独立全站数、每个已注册公开文档的完整计数、采集时间和切换批次。全站数不能以逐文求和代替，也不能复用过时快照。离线导入器在 dry-run 和 apply 发请求前均核对本地公开文档注册表，缺失、额外或重复 ID 拒绝，不能补零；实际导入时 Worker 再独立核对 D1 的真实注册表。完整基线单事务导入，同批同内容重试无副作用，不同基线禁止覆盖；单次访问 nonce、全站增量和单文增量保持原子性。已完成操作的入口见[访问量切换](../../README.md#visits-cutover)，日常部署不得重新覆盖基线。隐藏内容继续留在旧站，不进入公开基线。
