# 2026-10-24 上线记录

用户明确授权“上线吧”后，已将本轮公开博客迁移、Markdown 正式源与首页导航调整推送到 `origin/main`。

- 网站：[个人主页](https://pku-xht.github.io/) · [博客](https://pku-xht.github.io/blog/)
- 页面与资源内容版本：[3435528](https://github.com/pku-xht/pku-xht.github.io/commit/34355283f7fbbf5d9d9c20b3a1b3fc916535f9c4)。后续上线记录的文档提交不改变这些静态产物。
- GitHub Pages：仓库为 public，使用 `main` 分支的 `/` 根目录；Pages API 返回该内容提交 `status: built`。
- 内容：211 篇公开文章、1 个独立历史页面、4 个分类页，沿用 C 设计与原 WordPress ID 路由。首页“博客 ↗”靠右，并与论文、教育等导航同行。

## 验证

发布前原快照对照校验退出码为 0：全部 212 篇正文、日期、分类和逐篇标签一致；8,961 处原公式、609 个代码块、940 个 code 元素、1,680 个标题、5 张表格、63 个旧锚点与 45 个资源通过。待推送文件未发现明显凭据、会话数据或意外缓存。

发布后直接读取线上 HTTPS 响应，以下 **15 个文件的 SHA-256 与本地已提交文件一致**：

- 首页与首页样式：`/`、`/styles.css?v=11`。
- 博客首页、样式、脚本与归档：`/blog/`、`/blog/blog.css`、`/blog/blog.js`、`/blog/archive/`。
- 全部 4 个分类页：`/blog/categories/4/`、`/blog/categories/11/`、`/blog/categories/13/`、`/blog/categories/15/`。
- 代表文章与历史页：`/blog/posts/1154/`、`/blog/posts/994/`、`/blog/pages/215/`。
- 原图与公式字体：`/blog/media/1077980-20180401083928510-472522990.png`、`/assets/vendor/katex/fonts/KaTeX_AMS-Regular.woff2`。

全部 **45 个公开图片和附件**的线上 HEAD 响应均为 HTTP 200，Content-Length 与本地记录一致。除上述代表图片与字体外，此项没有重新下载全部资源作远端 SHA-256 比较；本地 45 个文件的完整哈希已由发布前校验核对。

逐文件线上响应证据保存在本地忽略目录 `output/deployment-2026-10-24.json`。浏览器线上预览读回曾超时，未据此声称完成新的线上视觉验收；界面布局此前在本地实测，线上静态产物通过上述字节核对。

## 边界

公开文章与历史页面已上线；隐藏内容和评论继续留在旧站。没有登录旧站后台，没有发布隐藏内容、设置旧站重定向或停用旧站。JSON／HTML 原始快照继续仅作历史校验，日常维护仍以 `content/blog/` 的 Markdown／YAML 为正式源。
