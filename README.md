# 香港写字楼研究工作台 · 公开版

本版本直接展示公开研究资料，无邮箱、密码、ChatGPT 登录或服务器账号。研究内容由维护者更新；访问者可以筛选、查看来源、导出 CSV/PPT，并在自己的浏览器保存收藏与月报快照。浏览器收藏和快照不会同步到其他设备，清除网站存储会删除这些个人记录，请下载 JSON 备份。共享研究资料不能由访问者写入。

这是可部署的完整源码。压缩包本身不等于已经发布的网址；必须完成下述发布步骤，才会获得真正独立于 ChatGPT 的公开链接。

交付部署包还包含已构建的 `dist/` 网页目录，可以直接交给静态托管服务上传；网页内下载的源码ZIP只包含源码，便于后续维护。两种方式都无需为访问者建立账号。

## 发布到 GitHub Pages

1. 在自己的 GitHub 账号下新建一个公开仓库，建议名称 `hk-office-workbench`，默认分支使用 `main`。把本目录的内容上传到仓库根目录，包含 `.github/workflows/pages.yml`，不要再套一层同名目录。
2. 打开仓库 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。在 **Settings → Actions → General** 允许 Actions 运行；若组织策略禁止工作流写入仓库，需要管理员允许此工作流的 `contents: write`，用于记录每日公开数据版本。
3. 在 **Actions → Publish research desk → Run workflow** 执行第一次发布。构建和 deploy 都成功后，从该任务的 `github-pages` 环境取得实际网址。不要把 GitHub 仓库源码页当成网站地址。
4. 使用一个未登录 GitHub、也未登录 ChatGPT 的浏览器打开实际网站链接，确认首页、新闻和地图，再发送给同事。访问者不需要 GitHub 账号。网站源码与公开研究数据也会公开。

工作流已配置香港时间每日09:00（UTC 01:00）检查17个来源并发布。GitHub 的计划任务可能排队，不能保证严格09:00完成；公开仓库长期没有活动时，计划任务也可能停用。网页只有在首次真实 `schedule` 事件运行后才标记定时更新已验证，手动运行成功不等于已经验证定时运行。若组织分支保护阻止机器提交，任务会明确失败，需在仓库政策中配置允许的更新路径。

GitHub 官方说明：[Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[自定义部署](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[定时任务](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。GitHub Free 支持公开仓库的 Pages；此方案不需要付费 Workers、数据库或身份服务。

## 本地运行

安装 Node.js 22.13 或以上，以及 Python 3。首次运行：

```bash
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm dev
```

打开终端返回的本机地址。不要双击 `index.html`：浏览器的本地文件模式不能正常执行模块和读取资料。其他静态托管也可使用：

```bash
pnpm typecheck
pnpm test
pnpm package:source
pnpm build
```

把整个 `dist/` 目录部署到支持 HTTPS 的静态网站托管。默认构建使用相对路径；GitHub Actions 会自动设置仓库子路径。迁移到自定义子路径可在构建时设置 `PAGES_BASE_PATH=/目录/`。

## 数据与更新边界

`public/data/workbench.json` 是页面读取的公共资料，只包含 `market`、`news`、`buildings`、`updates`。初始资料包括69条指标序列、102条新闻记录、24幢公开资料楼宇；这些是资料库覆盖数，不表示全港完整覆盖，也不代表所有来源都更新至同一天。

`pnpm update:data` 使用差估署九份官方 CSV、政府三语新闻、港台中英财经新闻、统计处新闻，以及 JLL/C&W 报告入口。数值观察期、发布日期、检查时间分别保存；源网站失败时保留已有数据并记录失败状态。报表入口发现不等于自动可靠提取商业报告数字，相关数字和楼宇/租户记录仍需要维护者复核。每日检查也不会把月度或季度指数变成每日指数。

“载入最新数据”仅重新读取最近发布的 JSON，不会由访问者触发抓取或修改共享资料。GitHub 工作流会提交更新后的 JSON，历史可在仓库中追溯。原网站的私人账号、收藏、月报快照、密钥及服务权限没有迁入。此前 ChatGPT 托管的调度不属于这个公开版；新版本首次定时执行及外部访问验证后，再停用旧调度。

新闻的方向箭头为辅助研究判断；自动发现的新闻保留低置信、待复核标记。楼宇没有披露的租金和出租率保持缺失，不用分区数据填补单幢空白。地图使用地政总署街道和中文标签图层，并提供 OpenStreetMap 备用底图，保留来源署名；不同网络可能仍限制地图源访问。

## 校验

`pnpm test` 检查公开资料读取、本浏览器保存、快照冻结、来源失败保留和定时状态；`pnpm typecheck` 检查类型；`pnpm build` 检查生产构建。离线测试不能代替首次公开部署后的匿名浏览器实测。部署后应在香港和同事的常用网络检查首页、新闻筛选、地图、CSV/PPT下载和本浏览器快照保存。

`pnpm package:source` 生成网页内下载用的 `public/downloads/source.zip`，按明确目录清单打包，不包含依赖、编译缓存、仓库凭证或私人数据。包内保留原有锁定依赖以便复现；页面构建产物只包括实际使用的客户端模块。
