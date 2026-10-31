# 博客交互与文章编辑 API

Cloudflare Worker + D1；运行时代码无 npm 依赖。注册范围是 `collection.yaml` 中的 211 篇文章和 1 个页面。评论统一存储、读取和管理于 D1；文章仍以仓库内每篇 Markdown + YAML 为正式源。读者填写昵称和正文即可提交评论，所有新提交必须由站主审核后公开。

统一评论、密码表单与在线文章编辑已于 **2026-10-26 部署**。真实编辑接口已完成保存、自动构建与 Pages 发布、版本冲突拒绝和原文恢复验证；Chrome 到 Worker 的连接问题也已修复，实测公开评论正常加载，见[统一博客批次](../../migration/unified-blog-2026-10-25.md)。全部评论工作台、共享样式与 30 天会话也已于 2026-10-26 正式发布，生产核验见[管理后台批次](../../migration/admin-workspace-2026-10-26.md)。正式运行命令只维护在[根 README](../../README.md#build-and-check)，本文件说明当前源码接口与不变量。

## 接口

公开 POST 要求允许的 `Origin` 和 `Content-Type: application/json`。默认允许正式站来源；本地验收只显式加入指定的 8791 来源，不允许任意 localhost 端口。管理页面先以账号、密码调用登录接口，随后统一使用 `Authorization: Bearer <session-token>`；原 `ADMIN_TOKEN` Bearer 保留给已有管理脚本。昵称、GitHub 账号和前端开关都不授予管理权限，接口不使用 Cookie 登录。

| 请求 | 行为 |
|---|---|
| `GET /v1/comments?document=1154&cursor=0` | 返回同文全部已公开评论，按创建时间及稳定序号分页，每页最多 100 条 |
| `POST /v1/comments` | 创建待审核评论，成功为 `202 {id,status:"pending"}` |
| `POST /v1/admin/login` | 接受 `{username:"admin",password}`，成功返回随机会话、绝对到期时间与编辑配置状态 |
| `GET /v1/admin/session` | 验证会话并返回 `authenticated`、`article_editing` 和 `expires_at`；原密码 Bearer 的兼容响应不含到期时间 |
| `DELETE /v1/admin/session` | 撤销当前会话，成功返回 `{logged_out:true}`；不撤销其他设备的独立会话 |
| `GET /v1/admin/comments?status=all&document=1154&q=关键词&cursor=0` | 全部评论管理，`status` 默认 `all`，可选三种状态、文章和昵称/正文子串搜索；按序号倒序，每页最多 100 条 |
| `POST /v1/admin/comments/<ID>/approve` | 公开评论；其父评论须仍在同文且已公开 |
| `POST /v1/admin/comments/<ID>/reject` | 拒绝该评论，连同文内全部回复后代一起隐藏 |
| `DELETE /v1/admin/comments/<ID>` | 删除该评论及同文全部回复后代 |
| `DELETE /v1/admin/comments/<ID>?only_if_no_replies=true` | 原子删除单条无回复评论，有回复时返回 `409 comment_has_replies` |
| `GET /v1/admin/articles/<ID>` | 读取正式 `main` 同一修订下的完整 Markdown/YAML、blob SHA 和修订号 |
| `POST /v1/admin/articles/<ID>` | 提交一个文档的候选修改，成功为 `202`，等待受信工作流发布 |
| `GET /v1/admin/articles/<ID>/publication?revision=<SHA>` | 查询保存返回的候选修订，状态为 `pending`、`success` 或 `failure` |
| `GET /v1/visits?document=1154` | 返回统计开关及基线加增量；省略文档 ID 时只返回全站数 |
| `POST /v1/visits` | 明确启用且已有完整基线后，按单次加载 nonce 幂等计数 |
| `POST /v1/admin/visits/baseline` | 显式确认并原子导入完整独立基线；不同基线禁止覆盖 |
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

错误形状为 `{error:"稳定错误码",message:"说明"}`。常见状态：内容错误 `400`、未认证 `401`、来源不允许 `403`、未注册文档 `404`、版本/回复/幂等冲突 `409`、频控 `429`、配置缺失 `503`。响应均不缓存，真实凭据和上游错误正文不会返回客户端。

## 统一评论与公开校验材料

`content/blog/comments/` 的 117 条已公开评论是原始校验材料，其中 43 条为回复。离线导入工具只从正式公开集合与这些白名单 YAML 读取数据，安全化正文、将已注册文内/资源链接映射到本地，并保留姓名、作者网址、完整时间和父子关系。不读取 WordPress 后台，不接受邮箱、IP、账户、用户代理或审核导出。

生成的 `data/unified-comments.json` 和 `.sql` 是公开导入资产，不是运行时评论源。`0002_unified_comments.sql` 为同一 `comments` 表增加 `body_html` 和 `author_url`，所有现有新评论仍保留。一次导入通过单条 SQL 及触发器事务完成；导入正文的临时 payload 随事务完成置空，仅保留批次/ID 哈希。

已导入记录不再被源快照覆盖。重复同批导入不改变审核、拒绝或删除结果；后续批次也不能重建已导入过的 ID。冲突哈希使整次操作失败回滚。删除评论后仍保留不可逆的最小导入标记以阻止复活，不保留第二份导入 payload。公开 YAML/JSON 保留原先已公开内容，仅供校验，不能回填新评论或未公开内容。

静态页面不嵌入评论正文兜底，防止拒绝/删除后在离线、无脚本或 API 失败时仍显示原评论。所有评论由同一公开接口读取，并在同一个 `/blog/comment/` 界面管理。

## 管理密码与浏览器

站内入口为 [评论管理](https://pku-xht.github.io/blog/comment)；GitHub Pages 会补末尾 `/`。固定账号为 `admin`，密码仍是原 `ADMIN_TOKEN`，本次不更换其值。编辑文章使用同一个密码。标准表单提供 `autocomplete="username"` 与 `autocomplete="current-password"`，成功认证后在支持的浏览器请求保存凭据。

Chrome 可依其设置提示保存并在以后自动填入；不能保证每台机器或每次登录都出现提示。密码保存由浏览器密码管理器负责，站点不把原密码写入 URL、Cookie、localStorage 或 sessionStorage。

登录成功返回 `{authenticated:true,token:"bs_...",expires_at:"ISO时间",article_editing:boolean}`。会话由 32 个随机字节生成，有效期为创建后 30 天，恢复或使用不延长到期时间。D1 的 `admin_sessions` 仅保存以当前 `ADMIN_TOKEN` 为密钥的 token HMAC、创建及到期时间，不保存原密码、原 token、浏览器或账号资料。修改当前密码会改变会话查找的 HMAC；主动撤销则删除对应记录。

同一来源的评论管理和全部编辑页仅在 localStorage 保存会话 token 与到期时间，键同时绑定固定 API 地址。每次重新打开先通过 session 接口验证，再载入管理数据。离页只清内存，不撤销浏览器保存的会话；主动退出清除本机缓存并请求服务器撤销，其他页面通过 storage 事件同步退出。网络失败只报告本机已退出、服务器撤销未确认。迟到的登录、恢复或旧请求不能重新写入已退出或已替换的会话。浏览器禁用存储时允许本页操作，但不能跨次保持登录。

评论页失效后清除管理列表；编辑页保留内存中的未保存正文，显示重新登录表单。重新认证保留当前草稿和原 SHA，即使远端正文已变也不自动重设基准。正文、草稿和原密码都不进入网站存储。

本机 DPAPI 备份在仓库外 `%USERPROFILE%\.config\xht37-blog-api\admin-token.dpapi`，只可由创建它的 Windows 用户解密。取用命令见[密码说明](../../README.md#administrator-password)，不要把密码发到聊天或写入仓库。`RATE_LIMIT_SALT` 的加密备份也保存在该私有目录。

界面共享源码为 `src/admin.mjs`、`src/admin-client.mjs`、`src/admin-auth.mjs`、`src/admin-session-client.mjs`、`src/admin-style.mjs` 与 `src/article-editor.mjs`。两类后台沿用博客 C 的纸色、蓝色与中文衬线标题。生成页只含空界面、文档 ID 和固定 API，不包含实际密码、待审评论或文章草稿。脚本用原始字符串共享，避免 Wrangler 打包器注入辅助函数后再被序列化的问题。CSP 限定本地资源及固定 Worker，页面 `noindex`、无 referrer，外站 iframe 禁止输入密码。LF 和生成器哈希防止跨平台字节漂移。

## 在线文章编辑与发布

每篇文章/页面后追加 `exit`，如 `/blog/posts/1154/exit/`、`/blog/pages/215/exit/`。当前 212 篇全部使用相同编辑流程，不分来源。GET 响应包含 `{document,path,revision,source,sha}`；POST 仅接受：

```json
{"source":"完整 Markdown 与 YAML","sha":"载入时的40位blob SHA","request_id":"本次保存与重试复用的UUID"}
```

后端固定目标仓库 `pku-xht/pku-xht.github.io`、基准分支 `main` 和注册文档路径；请求不能指定其他仓库、分支或文件。不得修改文档 `id`、`type`。提交最多 1MiB，源文件最多 950,000 字节。原 SHA 已变更时返回 `409 source_conflict`，保留本地编辑内容供比较；重复请求标识只能对应同一份修改。

保存先创建只包含该 Markdown 修改的 `codex/article-edit/<UUID>` 候选分支，返回 `202` 和候选修订号。受信工作流 `.github/workflows/publish-blog-edit.yml` 从 `main` 读取发布代码，不能执行候选分支提交的工作流或任意脚本。`tools/publish_blog_edit.py` 复核候选范围和基准版本，执行完整构建与校验，把源和生成页在一个提交内写入 `main`，随后显式触发并验证对应 Pages 构建。只有发布成功后才为候选修订的 `blog-publish` 状态报告成功。

不同保存请求进入串行队列，不能以“取消上次任务”丢弃文章修改。同文竞争修改须重新比较，不能自动覆盖。浏览器轮询 publication 接口显示提交、失败或已上线；候选分支创建、主干提交和实际上线是不同状态。`source_saved` 区分正文已保存但 Pages 失败与尚未写入正式源；前者需重新载入版本，并在 Actions 详情重新运行失败工作流。相同 `request_id` 重试只复用原候选，不会重新触发发布。`revision` 必须属于指定文章的保存记录。失败详情只给固定仓库的 Actions 链接，不向页面暴露 GitHub 凭据。

编辑后端使用 Worker secret `GITHUB_EDIT_TOKEN`，只允许目标仓库的 Contents 读写、Commit statuses 只读和默认 Metadata 只读，已由站主在 Cloudflare 中加密保存。管理员密码不具有 GitHub 写权限，也不充当此 secret。工作流自带令牌仅授予 contents/statuses/pages write。完整设置与部署顺序见[根 README](../../README.md#cloudflare-and-editor-configuration)；真实授权已通过文章读取和两次候选发布验证。

GitHub 子请求使用 Workers 支持的 `redirect: manual`，任何非成功响应都停止处理，不跟随重定向或转发凭据。浏览器支持的 `redirect: error` 在 Workers 中会在请求发出前抛出异常；部署前须执行真实 workerd 回归，不能仅用 Node 模拟 fetch 代替运行时兼容性验证。

## 频控、本地验证与部署边界

评论每个地址 15 分钟最多 5 次新请求，管理员登录每个地址 15 分钟最多 10 次尝试（成功和失败均计入），Visits 预备限制每分钟 120 次。新评论与频控配额在同一事务中提交，并发重试只占一次。仅在短期桶中保存带私密盐的地址 SHA-256，不保存原 IP；后续写请求清理过期一天以上桶。Cloudflare 使用可信入口的 `CF-Connecting-IP`；本机桥接强制连接地址，忽略调用者伪造的头。JSON 流式限长，不能靠遗漏 Content-Length 绕过。登录请求限 2048 字节，除 loopback 开发外要求 HTTPS。

这是基础频控与蜜罐，不表示能够抵御所有分布式自动化；所有新评论仍须审核。`ADMIN_TOKEN`、`RATE_LIMIT_SALT` 和 GitHub 编辑凭据只存 Worker secrets 或仓库外私有位置。待审内容、数据库导出和会话也不能进入仓库，包括忽略目录。

本地测试运行真实 SQLite 外键、唯一约束、事务、JSON1 与触发器，另测管理/编辑客户端、会话绝对到期/撤销/跨页恢复、固定接口、权限、幂等、重导防复活、混合回复删除和发布保护。实际 workerd 回归还覆盖临时 D1 的登录、恢复和撤销。实际运行命令与工具链要求见[构建与校验](../../README.md#build-and-check)。本机桥接只监听 loopback，自动导入公开集合和统一评论，SQLite 强制位于仓库外；未配置编辑 secret 时明确不可用。

发布本轮前必须按[正式部署顺序](../../README.md#authorized-deployment-order)先应用 `0003_admin_sessions.sql`，再部署读取会话表的 Worker，最后推送生成页面。既有服务保留原 secrets 和评论，不因会话升级重新设置密码或重导评论；新服务的完整初始化仍按根 README 操作。读取现存待审数据不能保存到本仓库或作为公开测试证据。远程冒烟只可在授权窗口使用虚构留言和精确叶节点清理，命令见[远程检查](../../README.md#remote-smoke-check)。本地 SQLite 和浏览器结果不能替代 Cloudflare D1、GitHub 发布及 Pages 的实证。

## Visits

2026-10-31 正式切流已完成：完整的 212 篇文档与独立全站 1,869,365 PV 基线已导入，Worker 和网页统计均已开启，旧域名公开白名单已 301 跳转；精确发布与线上核验见[切流记录](../../migration/domain-visits-2026-10-31.md)。GET 返回基线加增量，POST 对同一 nonce 只计一次；无文档 ID 的博客索引页只增加全站 PV。全站访问量显示在博客主页，个人主页、管理和编辑页不参与计数；刷新博客阅读页产生新 PV。关闭配置仍能停用：GET 返回 `{enabled:false,seeded:false,site:null,document:null,document_id:...}`，POST 返回 `404 visits_disabled`；启用但缺基线仍返回 `null` 并拒绝计数，不冒充 0。

原始基线包含旧站独立全站数、每个已注册公开文档的完整计数、采集时间和切换批次。全站数不能以逐文求和代替，也不能复用过时快照。离线导入器在 dry-run 和 apply 发请求前均核对本地公开文档注册表，缺失、额外或重复 ID 拒绝，不能补零；实际导入时 Worker 再独立核对 D1 的真实注册表。完整基线单事务导入，同批同内容重试无副作用，不同基线禁止覆盖；单次访问 nonce、全站增量和单文增量保持原子性。已完成操作的入口见[访问量切换](../../README.md#visits-cutover)，日常部署不得重新覆盖基线。隐藏内容继续留在旧站，不进入公开基线。
