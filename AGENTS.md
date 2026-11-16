# 项目约定（给 AI 协作/后续维护者）

## Git：改完就提交并推送

**每次功能开发或问题修复完成后，立即提交并推送到 GitHub，不要攒着。**

```bash
git add -A
git commit -m "fix(lab): 姿态模式网格不跟随骨骼"
git push origin main
```

- 远端：`origin` = https://github.com/laoningmeng/tool-box.git（fetch 走 HTTPS，push 走 SSH）
- 主分支：`main`（旧的 `master` 已废弃）
- 提交信息用中文，格式 `type(scope): 简述`，`type` ∈ feat / fix / refactor / style / docs / chore / test
- 一次改动一个提交，不要把不相关的改动混在一起
- 提交前确认 `git status` 里没有误加入的大文件或密钥

**不要提交的东西**（已在 `.gitignore` 里，别手动 `-f` 加进去）：

- `.userdata/`：本地数据库，含模型库记录和加密后的 API Key
- `runtime/python/`：首次运行 `scripts/setup-python.ps1` 下载的 Python 运行时
- `node_modules/`、`out/`、`release/`、`.tmp/`、`*.log`

## 代码约定

- TypeScript strict，改完必须跑 `npm run typecheck`（主进程 + 渲染层双份检查）
- 提交前跑一次 `npm run build`，确认打包不报错
- IPC 三层走通：`src/shared/channels.ts` → `src/preload/index.ts` → `src/main/ipc.ts`，类型放 `src/shared/types.ts`
- 渲染层样式用设计令牌（`src/renderer/src/styles/variables.css`），不写死颜色，亮/暗主题都要正常
- three.js 相关逻辑集中在 `ModelViewer.vue` 与 `src/renderer/src/rig/`（纯 TS，不依赖 Vue）

## 常用命令

```bash
npm run dev        # 开发模式（热更新）
npm run app        # 用当前构建启动
npm run app:debug  # 带 9355 调试端口
npm run typecheck  # 双份类型检查
npm run build      # 构建
npm run smoke      # 冒烟测试
```
