# 旧博客迁移

来源：[www.xht37.com](https://www.xht37.com/)。目标：[pku-xht.github.io](https://pku-xht.github.io/)。

## 已确认范围

- 公开旧文全部分批迁移。
- 隐藏内容本轮留在旧 WordPress；不登录后台、不导出隐藏内容，也不将非公开正文、图片或附件放入本仓库。
- 目标仓库为 public，Pages 已启用。改为私有仓库也不能直接保证 Pages 页面私有；参见 [GitHub Pages 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)。
- 推送与发布尚未授权。

## 公开盘点

2026-10-23 通过无登录、无 Cookie 的 WordPress 公开 REST API 核对：211 篇 `publish` 且非密码保护的文章，211 个不同 ID。

| 分类 | 篇数 |
|---|---:|
| 笔记 | 29 |
| 题解 | 167 |
| 游记 | 9 |
| 记录 | 6 |
| 合计 | 211 |

正文引用了 39 个不同的图片地址；图片尚未逐个验证。另有 1 个公开的“关于我”独立页面，须作为历史页面单独处理，不直接覆盖现有个人主页。上述数字不包含登录后可见的内容，也不代表旧站全部资料的完整备份。

完整文章清单见 [public-inventory.md](public-inventory.md)。清单只记录公开标题、日期、分类和原链接；原始公开响应暂存在被 Git 忽略的 `output/` 中，不作为已维护的正式备份。

接口入口使用 `https://www.xht37.com/index.php?rest_route=/wp/v2/posts&status=publish&context=view&per_page=100&page=1`，按响应分页读取。旧站的 `/wp-json/wp/v2/posts?page=…` 重写会吞掉首个查询参数，可能反复返回第一页；盘点必须同时核对总数与 ID 唯一性。

## 当前阶段

公开盘点完成，文章尚未迁入新站。推荐保留现有主页，新增独立博客区，保留原文与原日期，先以三篇代表文章验证图片、公式及代码排版；首批范围待用户选择。
