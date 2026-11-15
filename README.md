# 穷哥们的工具箱

Electron 33 + Vue 3 + TypeScript 的本地优先桌面管理后台骨架。
自带工作台、通用 CRUD、工作流管理、系统设置四块基础模块，数据全部落在本机 JSON 数据库，不依赖任何服务端。

## 快速开始

```bash
npm install                 # 安装依赖（npm 11 会拦截 install 脚本，见下方「常见问题」）
npm run dev                 # 开发模式（electron-vite 热更新）
npm run typecheck           # 类型检查（tsc + vue-tsc，需 0 报错）
npm run build               # 构建 main / preload / renderer 三段产物到 out/
npm run app                 # 构建后以桌面应用方式启动（自动 --no-sandbox）
npm run setup:python        # 可选：下载内置 Python 运行时（工作流模块需要）
npm run setup:backend       # 给内置运行时安装后端依赖（FastAPI / SQLAlchemy，setup:python 会自动带上）
npm run app:debug           # 同上，额外开 --remote-debugging-port=9355
npm run smoke               # 冒烟验收：CDP 断言页面 / IPC 并截图到 .tmp/screenshots
npm run dist                # 打包 Windows NSIS 安装包到 release/
```

## 已实现模块

| 模块 | 路由 | 说明 |
| --- | --- | --- |
| 工作台 | `#/dashboard` | 欢迎区 + 4 张统计卡 + 最近资源表，数据来自本地数据库 |
| 资源管理 | `#/resources` | 通用增删改查：搜索、分组/状态筛选、分页、弹窗表单校验 |
| 3D 模型管理 | `#/models` | 模型列表（卡片）：导入本机导出的 3D 文件，自动识别 Tripo / Meshy / Blender 来源；每张卡片可预览、进实验台、删除 |
| ↳ 实验台 | `#/models/lab/:id` | 游戏角色调整台：左「部件/骨架」结构树、中视口 + 时间轴、右「动作/选中/信息」；支持部件显隐、骨骼定位、动作播放与拖动、截图 |
| ↳ 配置管理 | `#/models/config` | Tripo / Meshy API Key（safeStorage 加密落库，只回显掩码）+ 默认导入目录 + 来源识别开关 |
| 工作流管理 | `#/workflow` | 流程列表（分类聚合、上传 API 格式 JSON、解析报告）+ 执行页（参数表单、进度轮询、出图预览） |
| 系统设置 | `#/settings` | 基础设置 / 外观（主题色即时生效）/ 存储与数据 / 关于系统 四栏 |
| 404 | 任意未知路由 | 独立样式页，带返回入口 |

## 目录结构

```
src/
  main/           主进程：窗口与自绘标题栏、托盘、IPC 注册、JSON 数据库、日志、Python 运行时启动器
    services/     comfy（ComfyUI 代理）、workflow（流程解析入库）
  preload/        contextBridge 暴露 window.api（唯一渲染层入口）
  shared/         类型 / IPC 通道 / 常量 / 默认数据，主进程与渲染层共用
  renderer/       Vue 3 + Element Plus
    components/layout/   AppTitlebar / AppHeader / AppSidebar
    layouts/MainLayout.vue
    views/         dashboard · resources · models · workflow · settings · not-found
    stores/        app（设置/主题/侧栏）· resources · models · workflow
    styles/        设计令牌 variables.css + 全局样式 index.css
runtime/backend/  项目内置 FastAPI 后端（日志/追踪/异常/任务/ORM，详见 runtime/backend/README.md）
scripts/          run-app.ps1（启动）· setup-python.ps1（下载运行时）· install-backend-deps.ps1（装后端依赖）· smoke-test.mjs（CDP 冒烟验收）
```

## 架构约定

- **三层 IPC**：`shared/channels.ts` 定通道 → `preload/index.ts` 暴露 `window.api` → `main/ipc.ts` 注册 handler，类型统一写在 `shared/types.ts`。新增能力按这个顺序加，不要在渲染层直接摸 Node。
- **原子写入**：JSON 数据库写盘用 `.tmp` + rename，避免断电写坏；支持手动备份。
- **主题**：`--accent` 与 `--el-color-primary-*` 由 store 注入，组件里只用变量，换色不用改组件。标题栏、侧边栏都用 `--titlebar-*` / `--sidebar-*` 令牌，明暗主题各一套，切换即生效。
- **标题栏**：`titleBarStyle: 'hidden'` + `titleBarOverlay`（44px），浮层统一 `top: var(--titlebar-height)` 避让。Windows 原生窗口按钮区是主进程铺的纯色，必须等于标题栏渐变终点色，所以 `stores/app.ts` 的 `applyTitlebar()` 会在启动/换主题时把 `--titlebar-overlay` 同步给主进程（`window:set-titlebar`）。
- **主题一致性自检**：`npm run app:debug` 后再 `npm run smoke`，会校验标题栏、侧栏、卡片在明暗两套主题下的渲染和交互。

## 冒烟验收

`npm run smoke` 会通过 CDP 连上运行中的应用，跑 33 项断言（默认路由、侧栏导航、统计卡、CRUD、工作流降级、主题色、深色模式、弹窗、折叠、404、控制台异常），并把 13 张截图写到 `.tmp/screenshots/`。全部通过时退出码为 0。

```bash
npm run app:debug     # 终端 A：带调试端口启动
npm run smoke         # 终端 B：跑断言
```

## 内置后端（FastAPI）

`runtime/backend` 是一个完整的 FastAPI 骨架，被 Electron 主进程以子进程拉起，只监听 `127.0.0.1`，
每次启动随机端口 + 随机 `X-App-Token`。它提供四块基础设施，业务代码直接往里填：

| 能力 | 文件 | 说明 |
| --- | --- | --- |
| 配置 | `app/core/config.py` | `APP_*` 环境变量 / 命令行参数，一处读取 |
| 日志管理 | `app/core/logging.py` | 控制台 + 5MB 轮转文件（`<userData>/data/logs/backend.log`），text / json 可切 |
| 全局日志追踪 | `app/core/trace.py` | 每个请求分配 trace_id，写进 ContextVar，日志行、响应头 `X-Trace-Id`、错误体都带上它 |
| 异常处理 | `app/core/errors.py` | `AppError` 体系（400/401/404/409/502/503）+ 校验错误 / 数据库错误 / 兜底，统一信封 |
| 任务处理 | `app/tasks/manager.py` | asyncio 调度：并发上限、进度上报、取消、状态落库、重启恢复 |
| ORM | `app/db/` | SQLAlchemy 2.0 + SQLite（WAL），`Base` / `TimestampMixin` / `get_db` / `session_scope` |

接口（均返回 `{ok, item|items, error, code, traceId}` 信封）：

```
GET  /api/health            健康检查（主进程判定就绪）
GET  /api/status            运行状态（Python 版本 / DB / 日志目录 / 任务类型）
GET  /api/tasks/types       可用的任务类型
POST /api/tasks             提交任务 {"name":"demo","payload":{...}}
GET  /api/tasks?limit=20    任务列表
GET  /api/tasks/{id}        任务详情
POST /api/tasks/{id}/cancel 取消任务
GET  /api/comfy/status       ComfyUI 连接状态
GET  /api/comfy/jobs         工作流任务列表        POST /api/comfy/run  提交工作流
GET  /api/comfy/jobs/{id}    工作流任务详情        POST /api/comfy/jobs/{id}/cancel
GET  /api/comfy/output       取回生成结果          POST /api/comfy/upload
/api/docs                   Swagger 文档
```

排查方式：错误响应里的 `traceId` 直接去 `<userData>/data/logs/backend.log` 搜，
同一条请求的访问日志、异常堆栈、它触发的后台任务日志（沿用同一个 trace_id）会串在一起。

细节（怎么加任务 / 加表 / 加接口）见 [runtime/backend/README.md](runtime/backend/README.md)。

## 3D 模型模块

数据源是用户本机从 **Tripo / Meshy / Blender** 导出的模型文件，模型库**只登记引用**，不复制文件：

- 导入：系统文件选择框（多选）→ 记录路径、大小、格式 → 按路径/文件名里的 `tripo`、`meshy`、`blender`
  特征识别来源（可关闭，只按扩展名推断 `.blend → Blender`），识别错可在「编辑」里手动改
- 去重：同一绝对路径只登记一次（Windows 不区分大小写）；重复导入会提示「跳过 N 个已存在」
- 移除：只出库，**不删磁盘文件**；列表会实时检查文件是否还在，丢失时标「文件丢失」并禁用「定位」
- 统计：总数 / 三种来源数量 / 总体积
- 卡片视图：来源色缩略区 + 名称/大小/更新时间 + **预览 / 实验台 / 删除** 三个操作
- 配置页的「测试连接」：拿输入框里的 Key（没填就用已保存的）去请求对方的**余额接口**验证可用性，
  直接把「可用 · 余额 445 / 密钥无效（401）/ 网络不通」标在按钮旁边，避免存了个错 Key 才发现：
  - Tripo `GET https://openapi.tripo3d.com/v3/account/balance`（失败回退 `openapi.tripo3d.ai`）
  - Meshy `GET https://api.meshy.ai/openapi/v1/balance`（失败回退 `api.meshy.cn`）
  - 两个接口都是只读、调用免费；401/403 判为密钥无效，402 判为额度不足，429 判为限流
- 预览：弹窗内用 three.js（GLTFLoader + OrbitControls）实时渲染，显示三角形数、网格数、真实尺寸（米），
  可切自动旋转与线框；底部还能「编辑信息」「在文件夹中显示」
- 实验台（`#/models/lab/:id`）是给游戏角色调整用的三栏工作台：
  - **左：结构**。`部件` / `骨架` 两个 Tab 共用一个滚动区 + 搜索。部件行带显隐眼睛和三角面数，
    骨骼行按层级缩进并显示子骨骼数；**单击只做高亮（镜头不动，保持整体视图）**，
    双击行或右栏「聚焦」才把镜头推到该节点
  - 选中部件用材质自发光（暖色）标记，不画包围盒、不遮挡模型；选中骨骼画一个小标记球
  - **中：视口**。顶部一条工具条（重置视角 / 截图 / 自动旋转 / 网格 / 线框 / 显示骨架 / **高亮** / 背景色 / 光照），
    底部是时间轴（播放暂停 / 回到开头 / 进度拖动 / 时间码 / 倍速），动画需要连续拖动所以贴着视口
  - **选中高亮可调**：工具条「高亮」弹出面板里改颜色（6 个预设 + 任意色）与亮度（0.05~1.5），
    只影响选中部件/骨骼的自发光，不改模型材质；设置存 localStorage，下次打开还在
  - **右：动作与信息**。动作列表（名称 + 时长，点一下即播）；`分组` 区（见下）；
    `选中` 区显示当前部件（类型/三角面/顶点）或骨骼（层级/子骨骼），没选中时显示模型整体信息
  - **部件分组**：左侧 `Ctrl/⌘ 点选` 可多选、`Shift` 连选；右栏「保存为分组」起个名字（如「双手持枪」）。
    分组行三个操作：**应用**（只显示这些部件）、**导出 glb**（把该组烘焙成独立静态模型，保存对话框选路径，
    自动登记进模型库）、**删除**。分组按部件结构路径持久化，重启后仍在
  - 骨骼可视化用 `SkeletonHelper`（可开关），选中骨骼画黄色标记球，选中部件加一层暖色自发光
  - 兼容「纯线条导出」的模型（Tripo 有些转格式产物只有 LineSegments + Bone）：这类对象也会列进部件，
    三角面显示 0；没有 SkinnedMesh 时会回退扫描 `Bone` 节点来生成骨架树
- API Key：配置页填写的 Tripo、Meshy Key 由主进程用 `safeStorage`（Windows DPAPI / macOS Keychain）
  加密后写入 `database.json`，渲染层只能拿到 `tsk_••••abcd` 这样的掩码，**明文不出主进程**

> three.js 只支持 glb / gltf。fbx / obj / blend 会提示「暂不支持预览」；
> 用了 Draco 压缩或外置 .bin 的 gltf 也会给出可读错误（可用 Blender 重新导出未压缩 glb）。
> 另外 GLB 内嵌贴图走 `blob:`，`index.html` 的 CSP 里 `connect-src` 必须允许 `blob:`，否则模型会渲染成白模。

`window.api.model.import(paths?)` 支持直接传路径数组（会跳过文件对话框），方便拖拽导入或自动化测试；
`window.api.model.readFile(id)` 返回文件字节，预览与实验台共用。

## 常见改造点

| 想做什么 | 改哪里 |
| --- | --- |
| 换业务实体（资源 → 订单/客户/设备） | `shared/types.ts` 的 `ResourceItem`、`views/resources/**`、`main/ipc.ts` 的 resource 段 |
| 3D 模型接真实接口（调 Tripo/Meshy 生成） | 密钥已在 `db.modelConfig`；新增 `main/services/tripo.ts`、`meshy.ts` 用密钥发请求，渲染层照 `models` 模块加 IPC 即可 |
| 模型预览（three.js 渲染 glb） | `views/models` 加一个预览抽屉，用 `three` + `GLTFLoader` 读取 `path`（主进程需暴露读文件为 `blob:`/`file://`） |
| 加一个新模块 | 复制 `views/resources` → 改 `router/index.ts` + `AppSidebar.vue` 的 `navItems` + `shared/channels.ts`/`types.ts` + `main/ipc.ts` |
| 不要工作流模块 | 删 `views/workflow`、`stores/workflow.ts`、`main/services/*`、`runtime/`，再去掉 router / sidebar / channels 里的入口 |
| 改产品名 | `shared/seed.ts` 的 `defaultSettings`（运行时也会以数据库里的值为准）或直接在「系统设置 → 基础设置」改 |
| 接真实后端 | 把 `main/ipc.ts` 里的本地 JSON 调用换成 HTTP 客户端，`preload` + `shared/types.ts` 契约保持不变 |

## 常见问题

**`npm install` 后 electron / esbuild 没跑 install 脚本（npm 11+ 行为）**

```bash
npm install-scripts approve electron esbuild vue-demi
npm install
```

**Electron 起不来 / 白屏（受限环境）**

用 `npm run app`：脚本会把 `TEMP/TMP` 指到项目内 `.tmp`、用户数据目录指到 `.userdata`，并带 `--no-sandbox`。

**工作流显示「未找到项目内置 Python 运行时」**

执行 `npm run setup:python` 下载运行时；同时需要本机启动 ComfyUI（默认 `http://127.0.0.1:8188`，可在设置里改）。
没装也不会崩：列表、上传、解析照常可用，只是状态显示未连接。

**打包成安装包**

`build/icon.ico`（256×256）放好后取消 `electron-builder.yml` 里 `win.icon` 的注释，再执行 `npm run dist`。
