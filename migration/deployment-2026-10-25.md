# 2026-10-25 互动功能上线记录

用户明确授权“推送上线吧”后，已将本批公开历史评论、友链、标签导航和审核制新评论推送至 `origin/main`。

- 网站：[博客](https://pku-xht.github.io/blog/) · [标签](https://pku-xht.github.io/blog/tags/) · [友链](https://pku-xht.github.io/blog/friends/)。
- 页面与资源内容版本：[7154771](https://github.com/pku-xht/pku-xht.github.io/commit/7154771b74212f956498926a64c051cf1bd5a9d1)，包含此前本地实现提交 `e60d782`。后续上线记录的文档提交不改变静态页面与运行脚本。
- GitHub Pages 使用 `main` 分支的 `/` 根目录；认证后的 Pages API 返回上述完整提交 `status: built`，构建记录更新时间为 2026-10-25 14:16:11（北京时间）。
- 本批包括 117 条原本公开的历史评论（含 43 条回复）、25 条原友链、91 个标签及静态标签页，共 311 个博客页面。211 篇文章与 1 个历史页正文、日期、原路由、公式、代码和资源未改变。
- 新评论读者免注册，昵称与正文必填；提交后待站主审核，审核通过才公开。Cloudflare 后端与密钥取用入口见 [服务说明](../services/blog-api/README.md)，本轮完整验证见 [实现记录](interactive-2026-10-25.md)。

## 发布核验

发布前确认工作区干净、远端没有未合并的新提交；待发布的两个提交与既定范围一致，没有跟踪真实凭据、本地绑定配置、待审评论、数据库、依赖或临时输出。沿用内容版本已通过的原快照完整性、前后端行为及真实 Cloudflare 验证，没有在发布时重新导入正文或原站资料。

发布后直接读取正式 HTTPS 响应，以下 **20 个文件均为 HTTP 200，SHA-256 与本地提交版本一致**：

- 首页与首页样式：`/`、`/styles.css?v=11`。
- 博客首页、归档、标签云、代表标签页及友链：`/blog/`、`/blog/archive/`、`/blog/tags/`、`/blog/tags/143/`、`/blog/friends/`。
- 全部 4 个分类页：`/blog/categories/4/`、`/blog/categories/11/`、`/blog/categories/13/`、`/blog/categories/15/`。
- 有历史讨论、评论公式、零历史评论的代表文章及历史页：`/blog/posts/46/`、`/blog/posts/429/`、`/blog/posts/1154/`、`/blog/pages/215/`。
- 实际页面引用的样式与脚本：`/blog/blog.css?v=2`、`/blog/blog.js?v=2`、`/blog/interactions.js?v=1`。
- 一张原图与公式字体：`/blog/media/1077980-20180401083928510-472522990.png`、`/assets/vendor/katex/fonts/KaTeX_AMS-Regular.woff2`。

线上文章包含启用的新评论表单、昵称必填属性和正确的真实 API 地址。带正式网站 Origin 的公开评论 GET 返回 200，CORS 精确匹配 `https://pku-xht.github.io`；无令牌的管理请求返回 401。Visits GET 确认关闭、未初始化且计数为 null，所核对的 HTML 没有 Visits 脚本。未访问任何后台评论正文，也没有保存凭据。

逐文件响应、字节数与哈希保存在本地忽略目录 `output/deployment-2026-10-25.json`。本次没有重新下载全部 311 页或 45 个资源作远端哈希比较；它们的本地完整性已在内容版本验证。

正式网站的浏览器预览导航超时，未据此声称本轮完成了新的线上视觉或表单提交验收。页面布局、标签交互以及浏览器直连真实后端的提交与审核显示已在发布前实测；本次正式站以 Pages 构建状态、实际 HTTPS 文件字节及后端只读请求核验上线结果。

## 站内评论管理入口

站主随后指定通过 `https://pku-xht.github.io/blog/comment` 管理评论。该入口已随 [61419ce](https://github.com/pku-xht/pku-xht.github.io/commit/61419ceb76bf7425a103f137a4a3d659781466ae) 推送并由 Pages 成功构建，新增管理页后共 312 个博客 HTML。它与 Worker 备用入口共用唯一客户端和原管理密码；没有转往另一个后台或嵌入 iframe，也不在公开导航中列出。

- 无尾斜杠地址返回 301 到 `https://pku-xht.github.io/blog/comment/`；该页面、`admin.js?v=1`、`admin.css?v=1` 均为 HTTP 200，字节哈希与提交中的资产一致。
- 更新后的 Worker 版本为 `5cee45c0-4ee2-4db1-9e4e-d6e9fb0364a0`。实际 `/admin` 响应中的客户端与共享脚本一致，在独立浏览器作用域执行正常；原管理员密码返回 200，CORS 精确匹配正式博客 origin。仅检查授权状态，没有读取或保存待审正文，没有改动密码或评论记录。
- 本地浏览器已检查桌面和真实 390px iframe，后者视口、正文和滚动宽均为 390px，无横向溢出；真实后端拒绝虚构错误密码，清除后须重新输入。审核动作、分页和私密响应清除由共享客户端测试覆盖；本轮没有在管理页面载入真实待审评论作截图。
- 13 项源隔离测试、28 项后端／管理界面测试全部通过，包含实际 esbuild 打包的回归；官方 Wrangler dry-run 产出的内联脚本也在独立作用域执行通过。管理页、脚本、样式和共享源的哈希已登记，跨平台检出统一 LF。

站内入口的逐文件响应与哈希保存在本地忽略目录 `output/comment-admin-deployment-2026-10-25.json`，本地布局截图为 `output/comment-admin-desktop.jpg`、`output/comment-admin-390.jpg`。正式站入口已通过 HTTPS 校验；没有把本地浏览器截图当成新的公网浏览器操作验收。

## 保留的边界

Visits 继续在前端与 Worker 中关闭，没有导入任何旧基线或启用访问统计；旧站后台独立全站数及逐篇旧数留待未来切换时核实。隐藏内容和未公开评论仍不迁入，旧站没有重定向或停用。后续新评论和审核数据只保存在后端，不回写这个 public 仓库。
