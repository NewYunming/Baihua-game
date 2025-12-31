# 白桦大冒险

一个基于 HTML5 Canvas 的像素风波次动作/肉鸽小品，支持键鼠与触屏模式。

## 游玩方式
- 本地：双击 index.html 直接在浏览器打开。
- 线上（GitHub Pages）：推送到 GitHub 后，在仓库 Settings → Pages 启用，链接形如 `https://<你的用户名>.github.io/Baihua-game/`。

## 控制
- 键鼠：A/D 移动，空格跳跃，J/鼠标左键攻击，U 求饶回血（约每秒+7HP）。
- 触屏：屏幕左侧左右移动；右侧横排按钮依次为跳跃、攻击、求饶回血。

## 部署到 GitHub
1. `git init`
2. `git add .`
3. `git commit -m "Initial publish"`
4. 在 GitHub 创建公共仓库，例如 `Baihua-game`。
5. `git remote add origin https://github.com/<你的用户名>/Baihua-game.git`
6. `git branch -M main`
7. `git push -u origin main`
8. 仓库 Settings → Pages，Source 选 “Deploy from a branch”，Branch 选 main，Folder 选 /(root)，保存。

## 版权说明
自用项目，无第三方依赖。