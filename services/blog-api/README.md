# 博客交互 API

Cloudflare Worker + D1；运行时代码无 npm 依赖。这里只登记正式集合中的 211 篇公开文章与 1 个历史页面。新评论必须由读者自行填写昵称，提交后先进入待审核状态，管理员通过后才出现在公开接口。旧评论正文仍由静态归档提供，Worker 只保存可回复的旧评论 ID 与所属公开文档。

`wrangler.toml` 中没有实际数据库 ID 或密钥，`VISITS_ENABLED` 明确为 `false`。真实后端已于 2026-10-25 部署并验证；静态页面的发布状态与实际核验见 [本批记录](../../migration/interactive-2026-10-25.md)。没有从旧快照提取或导入 Visits 正式基线。

## 接口

所有请求／响应均为 UTF-8 JSON。公开 POST 必须带允许的 `Origin`，使用 `Content-Type: application/json`；不使用 Cookie 或浏览器登录。默认只允许 `https://pku-xht.github.io`，需要本地验收时明确加入 `http://127.0.0.1:8791` 和／或 `http://localhost:8791`，不会泛化允许任意 localhost 端口。

| 请求 | 行为 |
|---|---|
| `GET /v1/comments?document=1154&cursor=0` | 仅返回已审核的新评论，按创建次序每页最多 100 条 |
| `POST /v1/comments` | 创建待审核评论；成功为 `202 {id, status:"pending"}` |
| `GET /v1/admin/comments?status=pending&cursor=0` | 管理员查看 `pending`／`approved`／`rejected` 队列 |
| `POST /v1/admin/comments/<UUID>/approve` | 公开新评论；其新父评论必须仍已公开 |
| `POST /v1/admin/comments/<UUID>/reject` | 拒绝该新评论，并将它在同文中的新评论后代一并隐藏 |
| `DELETE /v1/admin/comments/<UUID>` | 删除该新评论及同文新评论后代；不操作旧历史评论 |
| `DELETE /v1/admin/comments/<UUID>?only_if_no_replies=true` | 原子删除单条无新回复的评论；已有回复时返回 `409 comment_has_replies`，不删除任何记录 |
| `GET /v1/visits?document=1154` | 统计状态和基线加增量；未初始化时值为 `null` |
| `POST /v1/visits` | 仅在明确启用并已导入基线时记录幂等访问事件 |
| `POST /v1/admin/visits/baseline` | 未来切换时，显式确认并原子导入完整基线 |
| `GET /admin` | Worker 自带的轻量评论审核页 |

公开评论形状：

```json
{"comments":[{"id":"新评论 UUID","document":"1154","nickname":"读者自己填写","body":"纯文本正文","parent_id":null,"created_at":"ISO 时间"}],"next_cursor":null}
```

`next_cursor` 非空时继续带此整数请求下一页。`document` 为 WordPress ID **字符串**。`parent_id` 是已公开同文新评论的 UUID，或已导入同文旧公开评论的 `wp-<旧评论ID>`；不能回复待审、拒绝或其他文档的评论。

评论提交字段仅允许：

```json
{"document":"1154","nickname":"读者","body":"评论正文","parent_id":null,"request_id":"客户端生成并在重试时复用的 UUID","website":""}
```

昵称 trim 后必填，最多 40 个 Unicode 字符；正文 trim 后必填，最多 10,000 个 Unicode 字符，保留纯文本换行。拒绝控制字符及额外的 `status`、`approved`、IP 等字段。HTML 标签按文字存储；公开站与管理页必须用 `textContent` 展示。`website` 为隐藏蜜罐，非空时接受表面请求但不入库。

重复 `request_id` 与相同内容返回原 ID；复用它提交不同内容返回 `409 request_conflict`。公开响应从不返回待审正文、IP、令牌或内部请求哈希。错误形状为 `{error:"稳定错误码",message:"说明"}`：无效内容 `400`，管理员未授权 `401`，来源不允许 `403`，未知公开文档 `404`，回复／幂等冲突 `409`，频控 `429`，配置缺失 `503`。

## 管理与频控

管理接口统一要求 `Authorization: Bearer <ADMIN_TOKEN>`。`ADMIN_TOKEN` 与 `RATE_LIMIT_SALT` 均至少 32 个字符，放在 Worker secrets 或本机进程环境中，不能写入本公开仓库（包括忽略目录）。不要用 GitHub OAuth、昵称或前端开关冒充管理员权限。

`/admin` 的令牌输入在载入后清空；令牌仅存在当前页面内存，刷新或离开即失效，不放 URL、Cookie、localStorage 或 sessionStorage。用户评论通过 DOM `textContent` 渲染；页面有 nonce CSP，禁止外部脚本、嵌入与表单提交。删除会明确提示同文新回复一并删除。

当前审核入口为 [评论管理页](https://xht37-blog-api.pku-xht-github-io.workers.dev/admin)。本机管理员令牌的备份位于仓库外 `%USERPROFILE%\.config\xht37-blog-api\admin-token.dpapi`，由 Windows DPAPI 加密，只能在创建它的 Windows 用户下解密。在仓库根目录亲自执行以下命令，取出令牌后粘贴到管理页，点击“载入”；选择待审核评论后点击“公开”或“拒绝及隐藏回复”。不要把令牌发到聊天或写入本仓库：

```powershell
pwsh -NoProfile -File services/blog-api/scripts/admin-token.ps1 -Reveal
```

不带 `-Reveal` 的脚本只显示取用说明，不显示令牌。`rate-limit-salt.dpapi` 同样保存在该私有目录中。Cloudflare 的真实 secrets 已通过 stdin 设置，公开源文件中不包含它们。

评论初始限制为每个地址 15 分钟最多 5 次新请求，Visits 为每分钟最多 120 次。新评论入库与占用频控额度在同一事务中完成，相同请求并发重试只占一次额度。数据库只在频控桶中保存带私密盐的地址 SHA-256，不保存或输出原 IP；在后续写请求中清理过期一天以上的桶，无后续请求时没有额外定时清理。Cloudflare 入口的 `CF-Connecting-IP` 作为地址来源；本地桥接强制使用本机连接地址，忽略调用者伪造的该头。所有 JSON 请求都以流式读取强制限制在 64KiB 内，不依赖客户端声明的 Content-Length。

这是一层基础频控和蜜罐，不能证明可抵御所有机器人或分布式滥用。所有新评论审核后公开，因而自动化提交也不会直接进入公开评论列表。自托管反向代理必须自行保证客户端地址头可信，不能直接把公开请求传来的地址头视作可信。

## 本地验证与预览

使用 Node 24.6+：

```sh
node --test services/blog-api/test/worker.test.mjs
```

测试执行真实 SQLite 的外键、唯一约束、事务、JSON1 和访问计数触发器；`node:sqlite` 仅用于本地适配，Worker 运行时代码不依赖它。测试覆盖待审隔离、审核权限、同文父节点、子树处理、XSS 文字、CORS、频控、幂等及并发计数、基线防覆盖和默认关闭零写库。它不是线上 D1／Cloudflare 实际部署验收。

无需 npm 的本地 API 桥接：先在启动进程的环境中设置仅供本地的 `ADMIN_TOKEN` 与 `RATE_LIMIT_SALT`，再运行：

```sh
node services/blog-api/scripts/dev.mjs --port 8787
```

它只监听 `127.0.0.1`，默认数据库在系统临时目录 `xht37-blog-api-local.sqlite`，也可用 `--database <仓库外路径>` 指定。凭据不写磁盘，Visits 强制关闭。首页静态服务继续使用 8791 端口，审核页为 `http://127.0.0.1:8787/admin`。此桥接仅供本地联调，不是生产服务器或完整 Cloudflare 模拟器。

## 公开文档及旧父节点的离线导入

生成注册数据：

```sh
node services/blog-api/scripts/import-public.mjs
```

工具读取正式 `content/blog/collection.yaml` 和已登记 Markdown 的 ID，输出 `data/public-documents.json`、最小 `data/legacy-parents.json` 与 `data/register-public.sql`。默认复用已登记的最小旧父节点清单，避免普通重建清空已有投影；更新历史评论范围时需显式传入新清单。不扫描 WordPress 后台，不提取 Visits，不导入正文、用户档案、凭据、邮箱或 IP。

旧评论归档确定后，可另外提供最小公开父节点清单：

```json
{"version":1,"parents":[{"id":"wp-123","document":"1154"}]}
```

```sh
node services/blog-api/scripts/import-public.mjs --legacy <公开父节点清单.json>
```

工具拒绝任何额外字段、重复 ID、未登记文档或非法父 ID。必须先由静态归档流程验证这些确为公开且已批准的历史评论，不能将后台导出交给此工具后再过滤。生成的 SQL 只添加注册成员，已有 ID 不重新归属；上线后移除文档／旧父节点需单独审查现有回复关系。

## Cloudflare 配置与部署入口

本机已完成以下配置，绑定信息保存在忽略的 `wrangler.local.toml`；重建其他环境时，将 `wrangler.toml` 复制为本地配置，填入实际 D1 binding `DB`、数据库名与 ID，并保持 `VISITS_ENABLED = "false"`。不要向受版本管理的配置写入实际部署标识或 secret。`workers_dev` 开启，版本预览 URL 关闭；本次没有配置域名转移、旧站重定向或付费升级。

Wrangler 4.152.0 使用站主亲自批准的 OAuth 授权，范围为 `account:read`、`user:read`、`workers_scripts:write` 和 `d1:write`，以及自动附加的离线刷新权限。它可能提示缺少其他默认权限；当前部署与 D1 操作已验证无需额外扩权。Windows 上通过 `--use-keyring` 将登录凭据加密保存在仓库外，密钥存入 Windows Credential Manager。首次认证可执行：

```sh
wrangler login --device --use-keyring --scopes account:read user:read workers_scripts:write d1:write
```

设备码只有 5 分钟有效，站主必须在官方页面完成“允许”。本机曾出现令牌接口 `UND_ERR_CONNECT_TIMEOUT`：Windows 已设置的系统代理没有自动用于命令行。为 Wrangler 进程设置实际代理地址的 `HTTP_PROXY`／`HTTPS_PROXY`，并用 `NO_PROXY=localhost,127.0.0.1,::1` 排除本机后，登录和部署均正常。此项是连接配置问题，不能仅凭网页登录成功判断 CLI 已授权。

使用官方 Wrangler CLI，按具体账户授权分别执行迁移、公开注册数据和 Worker 部署：

```sh
wrangler d1 migrations apply <数据库名> --remote --config services/blog-api/wrangler.local.toml
wrangler d1 execute <数据库名> --remote --config services/blog-api/wrangler.local.toml --file services/blog-api/data/register-public.sql
wrangler secret put ADMIN_TOKEN --config services/blog-api/wrangler.local.toml
wrangler secret put RATE_LIMIT_SALT --config services/blog-api/wrangler.local.toml
wrangler deploy --config services/blog-api/wrangler.local.toml
```

运行命令时由操作者交互输入 secret；不要把它放命令行参数或仓库内 `.dev.vars`。正式开通前仍需在实际 Worker 域名验证 CORS、待审流程、权限和 D1 行为，网站 API 地址由前端配置明确指定。启用评论与部署 Worker 均不自动授权开启 Visits。

### 实际服务冒烟检查

`scripts/smoke-remote.mjs` 需要 `BLOG_ADMIN_TOKEN` 环境变量及明确的 `--confirm-test-writes`；缺少开关时零网络请求退出。它会创建两条虚构留言，短暂公开其中一条以核验审核流程，并在 `finally` 中按本轮唯一正文、昵称、文档、父节点与 ID 精确清理。清理只使用服务端 `only_if_no_replies=true` 条件删除；无回复检查与单条删除在同一 SQL 内完成，避免真实回复在检查后插入而被连带删除。它不导出待审内容、不记录令牌；遇到回复时保留测试评论并报告 UUID。

在获准的验收窗口运行，Windows 上可直接从加密备份载入进程环境：

```powershell
$env:BLOG_ADMIN_TOKEN = & services/blog-api/scripts/admin-token.ps1 -Reveal
try {
    node services/blog-api/scripts/smoke-remote.mjs --api https://xht37-blog-api.pku-xht-github-io.workers.dev --confirm-test-writes
} finally {
    Remove-Item Env:BLOG_ADMIN_TOKEN -ErrorAction SilentlyContinue
}
```

检查覆盖精确 CORS、无令牌管理请求、管理页 CSP、昵称必填、待审不可见、审核后可见、旧 `wp-2` 回复和跨文回复拒绝、Visits 关闭及未初始化。终端只输出检查名、计数和必要的未清理测试 UUID。D1 文档登记数量、外键以及 Visits 各表为空仍需另作只读核对；一次通过不代表后续任意配置均已验收。

## Visits：未来切换才初始化

前端 Visits 开关关闭或 API 未配置时，不能发出任何 Visits 请求。Worker 默认关闭时，GET 返回 `{enabled:false,seeded:false,site:null,document:null,document_id:请求ID或null}`，POST 返回 `404 visits_disabled`，数据库不写入。即使配置启用，未完成基线导入时 GET 仍为 `null`，POST 返回 `409 visits_not_seeded`，不能把未知旧数显示成 0。

未来的切换基线必须同时包含：旧站**独立全站数** `site_base`、每个已登记公开文档的 `document_bases:[{document,base}]`、采集时间 `captured_at`。全站旧数不从各文档旧数求和。文档集合必须完整且精确，数值为核实的非负整数。数据来源、切换窗口与避免两边重复计数须在实际切换时重新确认，不能使用现有迁移快照中的旧 Visits 冒充届时基线。

准备好仓库外的已核实 JSON 后，离线核对：

```sh
node services/blog-api/scripts/import-baseline.mjs --input <已核实基线.json> --batch <切换批次ID>
```

默认只 dry-run，网络请求为 0。未来获准切换后，操作者在进程环境设置 `BLOG_ADMIN_TOKEN`，再明确加上 `--apply --confirm-cutover --api <Worker origin>`。服务端也要求 `confirm_cutover:true` 和批次 ID；基线及全部文档基础数在同一 D1 batch 事务中导入。已有不同基线禁止覆盖，相同批次、相同内容重试无副作用；不能先开启计数，再补一个会抹掉增量的基线。

基线导入后仍需另行明确将 Worker 与前端开关启用。访问事件 `{nonce,document?}` 由客户端为每次页面访问生成 nonce；文章传文档 ID，博客首页／归档等页面省略文档，仅全站加 1。SQLite 触发器确保事件与单文／全站增量原子提交；nonce 只计一次，不删除事件记录后重新计数。对外统计始终为独立旧基线加新增计数，单次响应的全站与单文数在一条 SQL 的同一快照中读取。
