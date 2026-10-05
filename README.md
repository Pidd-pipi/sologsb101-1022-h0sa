# 香方配伍与窖藏陈化档案（gbincense）

面向香道工作室与制香作坊的配方留档工具：把每款香方的香料配比、炮制方式、和香成型、窖藏陈化与品香评鉴逐环记录，形成可复用的香方档案。

核心动作：**建香方与用途 → 维护香料库与炮制方式 → 按君臣佐使配比 → 排和香工序与成型 → 管窖藏批次环境 → 录品香评分**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据），刷新或重启浏览器后依然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22822**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改（默认 `22822`）；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbincense}-frontend`。
> `docker-compose.yml` 已用顶层 `name: gbincense` 兜底，任意目录名（含中文）下 `docker compose config --quiet` 都不会报错。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；换设备请用应用内「导出全量 JSON」与「导入 JSON」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals` / `noUnusedParameters` 均开启） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、抽屉、对话框、表单、滑块、提示 |
| 构建工具 | Vite 6 | 开发服务器端口 22822 |
| 状态管理 | Pinia 2（setup store） | `formulaStore` / `materialStore` / `proportionStore` / `cellarStore` / `syncStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files $uri $uri/ /index.html` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 库名 `gbincense`，含结构版本号与 `upgrade` 迁移逻辑（当前 v3：多标签页协同流水表 + 批次旧快照复核字段） |
| 拖拽排序 | HTML5 原生 `draggable` + `dragstart/dragover/drop` | 未引入 `vuedraggable` / `dnd-kit` 等额外依赖 |
| 容器化 | Docker 多阶段：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22822
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22822）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、目录结构与页面路由

```
sologsb101-1022/
├── README.md
├── docker-compose.yml          # 顶层 name 兜底，无 version 字段，无挂卷
├── .env / .env.example         # COMPOSE_PROJECT_NAME=gbincense、FRONTEND_PORT=22822
├── .gitignore
├── sologsb101-1022.md          # 提示词原文（只读）
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # SPA fallback + gzip + /assets/ 长缓存
    ├── .dockerignore
    ├── package.json / package-lock.json
    ├── tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 入口：先 initDatabase() 播种，再挂载应用
        ├── App.vue             # 顶部导航（6 个模块）+ 底部数据说明
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # formula.ts material.ts proportion.ts batch.ts cellar.ts tasting.ts sync.ts
        ├── stores/             # formulaStore.ts materialStore.ts proportionStore.ts cellarStore.ts syncStore.ts
        ├── components/common/  # GradeTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue SyncStatusBar.vue ConflictCenter.vue
        ├── hooks/              # useProportion.ts useIdbTable.ts useSyncGuard.ts
        ├── pages/              # FormulaList.vue MaterialLib.vue ProportionBoard.vue
        │                       # BatchList.vue CellarView.vue TastingBoard.vue
        ├── router/index.ts
        └── utils/              # ratio.ts db.ts export.ts snapshot.ts sync.ts
```

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/formulas` | 香方台账 | 新建/编辑香方、按香型与用途与状态筛选、卡片回显配比合计与品香均分、状态流转（草稿 → 在用 → 停用）、单方 JSON 导出与导入校验 | Formula、Tasting、Proportion、Batch |
| `/materials` | 香料库与炮制 | 香料增删改、按等级/产地/炮制方式检索、就地改炮制方式、显示被哪些香方引用、清理闲置香料 | Material、Proportion |
| `/proportions` | 配比与君臣佐使 | 君臣佐使编排、占比实时校验 100%、一键等比缩放与归一化、**HTML5 原生拖拽排序写回 `seq`**、按权重一键重排、跨标签页保存冲突逐项确认（改方后在用批次旧快照立即待复核） | Proportion、Formula、Material |
| `/batches` | 和香工序与成型 | 登记和香批次（自动固化配比快照）、快照与当前方子逐味对照（香料 / 占比 / 君臣佐使）、开批次前校验配比是否平衡、旧快照复核入口（未复核不能开新批） | Batch、Formula、Proportion |
| `/cellar` | 窖藏与环境 | 入窖/出窖登记、温湿度就地录入、按剩余天数排序的临近出窖提醒、状态流转（窖藏中 → 已出窖）、批量处理逾期（待复核批次拦截出窖） | Cellar、Batch、Formula |
| `/tastings` | 品香评鉴与导出 | 香韵 / 留香 / 烟气评分录入、同批次多次评鉴取均分并回写香方列表（待复核批次品香暂不计入）、结构版本查看、全量 JSON 导出与导入校验 | Tasting、Batch、全部模型 |

`/` 与未匹配路径均重定向到 `/formulas`；页面组件全部懒加载，`router.afterEach` 同步 `document.title`。

---

## 五、IndexedDB 库名与数据存储说明

- **库名**：`gbincense`（`frontend/src/utils/db.ts` 中的 `new IncenseDatabase()` → `super('gbincense')`）。
- **结构版本号**：`export const DB_VERSION = 3`，同时写入 localStorage 键 `gbincense:db-version` 便于比对。

| 表 | 主键与索引 | 说明 |
| --- | --- | --- |
| `formulas` | `id, name, scentType, usage, state, createdAt, totalRatio, updatedAt` | 香方主档，`totalRatio` 由配比页实时回写 |
| `materials` | `id, name, origin, grade, processMethod, updatedAt` | 香料库与炮制方式 |
| `proportions` | `id, formulaId, materialId, role, seq, updatedAt` | 君臣佐使配比，`seq` 为拖拽编排顺序 |
| `batches` | `id, formulaId, mixedAt, formingMethod, reviewState, updatedAt` | 和香批次，含 `snapshot` 配比快照与旧快照复核状态 |
| `cellars` | `id, batchId, startDate, endDate, state, updatedAt` | 窖藏批次与环境读数 |
| `tastings` | `id, batchId, tastedAt, smokeScore, updatedAt` | 品香评鉴 |
| `changes` | `id, clientId, table, recordId, status, kind, [table+recordId], createdAt, updatedAt` | 多标签页改动流水：冲突检测、离线重连合并的依据 |

- **多标签页协同**（配比编排页与批次登记页可在不同标签页同时开着）：
  1. 每个标签页以 sessionStorage 中的 `clientId` 标识，保存动作统一经 `useSyncGuard` → `utils/sync.ts` 写入；
  2. 在线保存时，以打开表单时的旧值（`baseFields`）为基准检测对方改动；香料、占比、君臣佐使等同一字段被双方同时改动即判冲突——**本次保存不入库**，冲突进入「冲突中心」抽屉，逐项列出双方差异，逐项确认保留本页或对方后才入库；关闭面板或取消确认时本地草稿继续保留，绝不覆盖对方改动；不同字段 / 不同记录的改动互不重叠，自动合并；
  3. 浏览器离线时保存只进入本标签页 localStorage 暂存队列（不写共享库），重连（`online` 事件 / 标签页重新可见 / 状态栏「立即对账合并」）后先冲刷队列：互不重叠的自动合并，重叠项登记为冲突保持待处理；
  4. 状态栏（`SyncStatusBar`）常驻显示在线状态、离线暂存条数与待确认冲突数。
- **香方改动 → 旧快照立即失效**：任一配比写回（占比、君臣佐使、香料增删、清空）在同一 Dexie 事务内，把该香方名下已有非空快照的在用批次统一置为 `reviewState='待复核'`（记 `staleAt`）。
  - 未复核通过前：批次页不能按新配比登记新批次；窖藏页的「出窖 / 批量处理逾期 / 去品香」对该批次一律拦截；品香页不能选择该批次录入，其上已有品香**不并入香方均分**（香方台账卡片同样排除），避免均分归错香方。
  - 唯一解除入口：批次页「快照对照」抽屉里逐项核对差异后点「复核通过，按当前配比固化」，系统才用当前配比重写快照并回到 `正常`。
- **版本迁移**：`version(1)` / `version(2)` 为历史结构；`version(DB_VERSION)`（v3）建立 `changes` 表、给批次补 `reviewState/staleAt/reviewedAt`，并按配比指纹把「旧快照与当前香方不一致」的历史批次直接标成待复核：
  1. 配比表补齐 `seq`（按 `formulaId` 分组顺序编号）与 `updatedAt`；
  2. 批次表补齐 `snapshot` 数组与 `snapshotAt`，v3 再补复核三字段并回填失效状态；
  3. 品香表补齐 `lastingMin` 默认值。
- **首屏自动播种**：`main.ts` 在挂载前调用 `initDatabase()`，其中包含 `if ((await db.formulas.count()) === 0) { await seedDatabase() }`，写入 3 款香方 → 7 条配比 / 2 个和香批次 → 2 条窖藏 / 2 条品香（香方 → 配比/批次 → 窖藏/品香 三层互相引用）。播种使用固定 id + `bulkPut`，**幂等**，重复调用不会产生重复数据。
- **localStorage 元数据**：`gbincense:db-version`（结构版本）、`gbincense:last-backup-at`（上次导出时间）、`gbincense:ui-prefs`（当前香方、配比与窖藏排序方式）、`gbincense:sync:client-id`（标签页身份，sessionStorage）、`gbincense:sync:offline-queue:<clientId>`（离线暂存队列）。
- **导出 / 导入**：`utils/export.ts` 提供 `exportFormulaJson()`（单方）与 `exportSnapshotJson()`（全量），导入前用 `validateFormulaJson()` / `validateSnapshotJson()` 做字段与枚举校验，校验失败会提示具体错误且不写库；全量快照导入后会按当前配比重新判定批次复核状态（旧档案补版本：快照对不上即待复核）。
- **无命名卷、无后端**：数据只在本浏览器，清理浏览器站点数据即清空；应用内提供「重置演示数据」按钮可恢复样例档案。

---

## 六、常见问题

1. **端口被占用**：修改 `.env` 中的 `FRONTEND_PORT`（例如 `FRONTEND_PORT=22823`）后重新 `docker compose up -d --build`；本地开发改 `frontend/vite.config.ts` 的 `server.port`。
2. **favicon 或静态资源 403**：`Dockerfile` 在 `COPY --from=builder /app/dist /usr/share/nginx/html` 之后紧接 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机源文件权限为 `0600` 时 nginx worker（uid=101）读不到文件，已被规避。
3. **刷新子路由 404**：`nginx.conf` 已配置 `try_files $uri $uri/ /index.html;`；若自行部署到其它 Web 服务器，请同样配置 history fallback。
4. **换浏览器 / 换设备看不到数据**：数据仅存于当前浏览器的 IndexedDB，请在「品香评鉴」页导出全量 JSON，再在新环境导入。
5. **配比合计不是 100%**：配比页顶部会实时显示合计与偏差，可点「一键等比缩放至 100%」或「按君臣佐使重排」后微调；批次页登记前也会提示当前方子是否平衡。
6. **两个标签页同时改配方会互相覆盖吗**：不会。配比页与批次页可分别开在两个标签页；同时保存且改到同一条配比的同一字段时，后保存的一方不会入库，而是弹出冲突中心逐项列出双方的香料 / 占比 / 君臣佐使差异，逐项确认后才入库，未确认的草稿继续保留。浏览器断网期间的改动只暂存在当前标签页，重连后互不重叠的自动合并、重叠的进冲突中心。
7. **改了香方后旧批次怎么办**：在用批次的旧配比快照会立即标成「待复核」；复核通过前不能按新配比登记出窖、不能开新批次，相关品香均分也暂不计入香方。到「和香批次 → 快照对照」逐项核对并点「复核通过，按当前配比固化」即可解除。
8. **浏览器隐私模式**：部分浏览器的无痕窗口会禁用或限制 IndexedDB，可能导致看不到演示数据，请使用普通窗口访问。
