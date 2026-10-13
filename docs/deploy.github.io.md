# GitHub Pages 部署指南

> 记录本项目部署到 `用户名.github.io` 的完整方案：已完成的代码准备、
> 需要手动执行的一次性操作、常见问题排查。

## 一、部署链路总览

```
git push origin master
  └→ GitHub Actions 触发 .github/workflows/deploy.yml
       └→ npm ci → npm run build
            └→ dist/ 上传为 Pages 工件
                 └→ actions/deploy-pages 发布
                      └→ https://<用户名>.github.io/
```

## 二、代码侧已完成的准备

### 1. 工作流文件 `.github/workflows/deploy.yml`

- 触发条件：push 到 `master`（或 Actions 页手动触发 `workflow_dispatch`）
- 流程：checkout → Node 20（npm 缓存）→ `npm ci` → `npm run build` →
  `dist` 上传为 Pages 工件 → `deploy-pages` 发布
- 并发控制：同一时间只跑一个部署，排队不取消（`concurrency.group: pages`）

### 2. public 资源路径改为 BASE_URL 相对拼接（4 处）

| 文件                            | 位置                     |
| ------------------------------- | ------------------------ |
| `src/views/ToolBox.vue`         | `/tourbox/*.glb`         |
| `src/views/NoiSe.vue`           | `/models/helicopter.glb` |
| `src/views/dtwin/DTwinScene.js` | `/models/device.glb`     |
| `src/views/HomeView.vue`        | `/gltf/Parrot.glb` 等    |

统一格式：`` `${import.meta.env.BASE_URL}tourbox/xxx` ``。
base 为 `/` 时行为与硬编码 `/tourbox/xxx` 完全一致；
未来若改用子路径仓库（`用户名.github.io/仓库名`），只需改 `vite.config.js`
的 `base`，页面代码零改动。

### 3. 无需改 base / 路由

`用户名.github.io` 仓库部署在**根路径**：

- `vite.config.js` 的 `base` 保持默认 `/`，不用配
- 路由用 `createWebHistory(import.meta.env.BASE_URL)`，天然兼容

## 三、需要手动执行的一次性操作

### 1. 创建 GitHub 仓库

新建名为 `<你的用户名>.github.io` 的**公开**仓库
（Private 仓库的 Pages 需要 GitHub Pro）。

### 2. 关联远程并推送（当前仓库还没有 remote）

```bash
git remote add origin https://github.com/<你的用户名>/<你的用户名>.github.io.git
git push -u origin master
```

**分支注意**：workflow 监听的是 `master`。若仓库默认分支是 `main`，
二选一：

- 在 GitHub 仓库 Settings → Branches 把默认分支改为 `master`
- 或把 `deploy.yml` 里 `branches: [master]` 改成 `branches: [main]`

### 3. 开启 Pages

仓库 Settings → Pages → Build and deployment → Source 选
**GitHub Actions**（不要选 Deploy from a branch）。

### 4. 等待并验证

Actions 页等构建跑完（约 1-2 分钟），访问
`https://<你的用户名>.github.io/`。首次部署后 Pages 会持续随 push 更新。

## 四、注意事项 / 已排查的隐患

1. **资源路径**：已检查全部 7 处引用，除上表 4 处外无其他硬编码绝对路径；
   `favicon`、路由 base 均已兼容
2. **中文文件名**（`黑色.glb` 等）：Vite 按 UTF-8 原样复制到 dist，
   Git / Actions / Pages 静态服务器全程无编码问题
3. **404 刷新问题**：`createWebHistory` 的子路由
   （如 `/tourbox`）直接刷新或直链访问时，GitHub Pages 静态服务器
   只会找 `/tourbox` 文件 → 404。
   解决方案二选一：
   - 平时从首页 `/` 进入后用导航切换（SPA 内部跳转不受影响）
   - 需要直链可用时改 `createWebHashHistory`（URL 带 `#/`），一劳永逸
4. **大文件**：`public/tourbox` 下的 GLB 会进 Git 仓库，若单文件
   > 50MB 会触发 GitHub 硬限制、>100MB 直接拒绝 push；
   > 目前均远小于阈值，新增大模型前先确认体积
5. **未提交改动**：首次 push 前记得提交（如 ToolBox.vue 的修改），
   push 即触发首次部署

## 五、常用操作

```bash
# 手动触发部署（无需新 commit）
# → GitHub 仓库 Actions 页 → Deploy to GitHub Pages → Run workflow

# 查看部署状态
# → 仓库 Actions 标签页；失败时点进 workflow 看 log

# 本地模拟线上构建（部署前自检）
npm run build && npm run preview
```
