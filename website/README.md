# 白桦大冒险网站服务端

本目录是完整的 Sites/Cloudflare Worker 网站项目。游戏与社交前端以仓库根目录的 `index.html` 和 `social.js` 为准，`npm run dev`、`npm run build` 会自动同步到 `public/`。

部署、数据库初始化、线上项目 ID 和验证步骤见仓库根目录的 [DEPLOYMENT.md](../DEPLOYMENT.md)。本目录单独导出为 Sites 源码仓库时，构建会使用已同步的 `public/game.html` 和 `public/social.js`；在原项目内编辑客户端后应先运行一次 `npm run build`，再导出。
