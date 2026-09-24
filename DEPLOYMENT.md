# 白桦大冒险：网站部署交接

本仓库有两个运行方式。根目录的 `index.html` + `social.js` 是游戏客户端；直接打开 HTML 可玩单机，但账号、排行榜、好友和 PvP 需要 HTTP 服务端。`website/` 是可部署的 Cloudflare Worker 网站，使用 D1 存数据。**GitHub Pages 只适合单机页面，不能运行此网站的 `/api`。**

## 当前已部署实例

- 网站：<https://baihua-arena.superxbw1229.chatgpt.site>
- Sites 项目 ID：`appgprj_6ab4d39d60348191a0bb45d4b0db947d`
- 站点清单：`website/.openai/hosting.json`，逻辑绑定为 D1 `DB`、R2 `BUCKET`。
- 当前站点允许持链接者访问。后续更新应保留现有访问范围，除非站主要求更改。

上述 ID 指向**已有线上实例**。更新该实例前，应通过 Sites 读取站点并核对项目 ID、权限和最新版本。若要另建网站，应先创建新的 Sites 项目，再把新项目 ID 写入该清单；不能把旧项目 ID 当成新站 ID。不要将 Git 凭据、会话 Cookie 或用户密码写入仓库。

## 代码位置与同步

| 路径 | 用途 |
| --- | --- |
| `index.html` | 游戏页面主源文件，包含主菜单、暂停菜单和死亡结算事件 |
| `social.js` | 账号、个人最佳、排行榜、好友与 PvP 前端 |
| `website/app/api/route.ts` | 注册登录、战绩、排行榜、好友、PvP 服务端 API |
| `website/db/schema.ts`、`website/drizzle/` | D1 结构与初始迁移 |
| `website/public/game.html`、`website/public/social.js` | 构建时从根目录同步的静态文件 |
| `website/.openai/hosting.json` | Sites 站点 ID 与逻辑存储绑定 |

编辑游戏或社交界面时，修改根目录 `index.html` 或 `social.js`。在 `website/` 中执行 `npm run dev` 或 `npm run build` 会先运行 `scripts/sync-game.mjs`，把这两个文件复制到 `website/public/`。若使用其他构建命令，先手动运行 `node scripts/sync-game.mjs`。服务端改动直接编辑 `website/app/api/route.ts`。

## 环境与本地验证

需要 Node.js 22.13 或更新版本。PowerShell 示例：

```powershell
cd 'D:\科研\Python项目\Baihua-game'
node tests/game-logic-smoke.js
cd website
npm ci
npm run build
```

首次使用本地 D1 时，构建后运行一次初始迁移。不要在已有表的数据库上重复执行初始 SQL：

```powershell
node node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_nasty_kabuki.sql
npm run dev
```

开发服务默认在 `http://localhost:5173/`。测试注册与登录、死亡后的个人最佳记录和排行榜；用两个账号同时登录，验证好友邀请、双方相同装备和三局两胜；在手机或移动视口测试主菜单、暂停菜单和触屏模式。`npm run build` 成功只证明可构建，不证明这些交互都正常。

## 通过 Sites 更新已部署网站

1. 在 `website/` 中确认 `website/.openai/hosting.json` 的项目 ID 与目标站点一致，查看未提交改动及当前线上版本。
2. 运行上面的游戏逻辑测试、`npm ci`、`npm run build`。修改 `db/schema.ts` 时先生成并审查新的 Drizzle 迁移；当前版本已有初始迁移，无需重新生成。
3. `website/` 是原 Git 仓库的子目录，**不能直接把仓库根目录推到 Sites**。使用 Sites 的“打开现有站点”工作流取得该站点的独立源码 checkout，然后将本项目 `website/` 的源码覆盖到它的根目录，使 `.openai/hosting.json` 和 `package.json` 位于 checkout 根目录。复制时排除 `node_modules/`、`dist/`、`.next/`、`.vinext/`、`.wrangler/`、`.sites-runtime/` 等本地生成目录；导出前已运行 `npm run build` 同步 `public/`。独立 checkout 中的同步脚本会使用已打包的 `public/` 文件。审查差异并提交后，通过 Sites `sites-hosting` 工作流获取短期源码写凭据，推送**本次构建对应的准确 Git 提交**。不要在文档、命令行参数或文件中保存凭据。
4. 将 `.openai/hosting.json`、`dist/` 和 `drizzle/` 打成部署归档。通过 Sites 保存与推送提交 SHA 对应的网站版本，再部署该已保存版本。当前站点是公开站点，使用普通部署接口并保留访问范围。
5. 等部署状态为 `succeeded` 后，记录返回的生产 URL。检查根路径、`/game`、注册登录、排行榜，以及触屏和暂停菜单。若部署失败，读取状态与 Worker 日志后修复，不能仅凭构建成功宣称上线。

Sites 插件可能更新具体脚本及工具参数。其他 AI 应以当时安装的 `sites:sites-building`、`sites:sites-hosting` 技能和工具返回的字段为准，不要照搬过期令牌、归档路径或版本 ID。

## 数据与注意事项

- D1 表为 `users`、`sessions`、`login_attempts`、`scores`、`friendships`、`matches`。部署已有实例时保留线上 D1；不能用本地测试库覆盖线上数据。
- 死亡后只保存超过该账号同模式最佳的成绩，排行榜按到达波次、击杀数排序。旧版手动截图和旧 `game` 来源记录保留在数据库，但不进入新的死亡榜。
- 游客死亡结算暂存在其浏览器 `localStorage`，登录后提交；清除浏览器数据会清除尚未同步的成绩。
- 单机游戏逻辑在浏览器中运行，自动上报的战绩可被修改，当前排行榜不具备防作弊保证。PvP 装备和胜负在服务端判定，但使用 HTTP 轮询，网络延迟会影响对战手感。
- `.openai/hosting.json` 中仍保留旧 R2 `BUCKET` 绑定以兼容既有站点；新版界面不再上传截图。不要删除现有存储中的历史截图。
