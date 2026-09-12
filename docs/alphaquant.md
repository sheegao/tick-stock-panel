# AlphaQuant 原生策略接入

本版直接在 Tick Stock Panel 内运行，不使用 iframe，也不需要独立工作台前端。

## 能力与边界

- 左侧“AlphaQuant 策略”：运行选择、候选筛选、持仓委托、决策和风控、复盘下载。
- 历史回测分支：原始绩效、收益/权益/回撤曲线、基准对比、全历史明细分页、逐日持仓/候选、成交日叠图、报告与全部匹配成交导出。
- 复用 `PageHeader`、`EmptyState`、主题与原有布局，不建立第二套导航。
- 复用 `StockPanel` / `StockDailyKChart` / ECharts：选择候选“联动图表”，查看运行日期之前的日线；点击蜡烛沿用 TSP 的历史分时联动。
- 确认的 `trade_fill` 回报按北京时间日期和买卖方向去重，叠加 AQ 成交日标记。仅表示成交日期，不将实际成交价画成前复权价格，不把信号或撤单当成交，不累加重复的累计成交数量。
- 点股票名称打开原有 `StockPreviewDialog`，保留日线、分时、左右切股、自选与行情监控交互。其底部新增该股的 AlphaQuant 决策/回报区，其他原生页面打开同一弹窗也能查看。
- TSP 的自选与行情监控操作仍属于研究端，不会启动、暂停或修改 AlphaQuant 策略，更不会发出券商交易指令。

**策略数据**来自本机 AlphaQuant Panel 只读 API；**图表行情**来自 TSP 已配置的数据源。二者不是同一条行情链路，当前没有把 cfquant 快照伪装成历史 K 线。没有日线/分钟权限或历史数据时，需要在 TSP“数据源/数据管理”中配置并同步。真实策略配置、参数、启停仍由 AlphaQuant 管理。

## 安装

在 AlphaQuant 项目目录执行：

```powershell
.\.venv\Scripts\python.exe scripts\install_tsp_panel.py D:\projects\tick-stock-panel
```

安装器添加 `frontend/src/custom/alphaquant/{extension.tsx,api.ts,model.ts,workbench.tsx,history.tsx}`、`backend/app/custom/alphaquant_panel.py` 和本文 `docs/alphaquant.md`。另有两个最小核心接线：

1. `frontend/src/lib/api.ts` 导出现有 `request`，沿用其超时、错误和认证处理；不复制请求客户端。
2. `frontend/src/lib/queryKeys.ts` 增加 `alphaquantRuns` / `alphaquantRun(id)` 和 `alphaquantBacktest` / `alphaquantBacktestRecords` / `alphaquantBacktestMarkers`，沿用应用的 QueryClient。历史键包含运行、类型、日期、股票及分页，不跨运行复用结果。

接入属于 L2 页面/插槽注册 + L3 两处共享契约接线，基线 commit 为 `77b829a0969664ca6f797f9099c9e7819071c986`。没有改动选股、回测或交易引擎，也没有把 AlphaQuant 策略转换成 TSP 策略文件。

原生版再次安装时，加 `--update` 只升级安装清单记录且未被本地修改的扩展。`.alphaquant-install.json` 保存已安装文件的哈希。手工改过的文件或契约变化会拒绝覆盖；先备份、人工合并后再安装。旧 iframe 版没有清单，需要先将旧 `frontend/src/custom/alphaquant` 移到源码目录外备份，不能与新版同时注册。

## 启动（两个 PowerShell 窗口）

窗口一，在 AlphaQuant 目录启动只读 API。无需构建 `panel/` 前端：

```powershell
.\.venv\Scripts\python.exe -m pip install -e '.[panel]'
# 真实运行改为 [runtime] output_dir；初次体验可用 examples/panel_demo
.\.venv\Scripts\python.exe -m alphaquantv2.panel --runs-root runs --runs-root examples/panel_demo
```

窗口二，在 TSP 源码目录构建并启动原有应用：

```powershell
cd frontend
pnpm install --frozen-lockfile
pnpm build
cd ..\backend
uv sync --frozen
$env:ALPHAQUANT_PANEL_URL = 'http://127.0.0.1:8766'
uv run --frozen python -m uvicorn app.main:app --host 127.0.0.1 --port 3018
```

打开 `http://127.0.0.1:3018/alphaquant`。这是完整 TSP 应用，由其后端托管前端构建产物。

Windows pnpm 出现 `EPERM` 时，可在前端目录改用 `npm install --ignore-scripts --package-lock=false` 与 `npm run build`。不要运行会强制清理占用端口进程的启动脚本，也不要关闭已有策略进程来腾端口。

需要开发热更新时，另开窗口在 `frontend` 执行 `npm run dev -- --host 127.0.0.1 --port 3011 --strictPort`，访问 `http://127.0.0.1:3011/alphaquant`。

## 状态、缓存与安全

首次选择的运行固定到 URL 的 `aq_run`，股票为 `symbol`；运行消失会提示重选，不自动切换到其他账户。切换运行使用独立缓存键，不将上一运行数据冒充当前数据。快照过期与服务错误分别展示。

运行列表每 15 秒更新，详情每 3 秒更新，SSE 只失效当前运行查询；同一页面与个股详情共享缓存。关闭自动刷新同时关闭本页观察轮询、SSE 和弹窗观察刷新，不影响 TSP 自身行情刷新。个股附加区默认折叠，不主动发起观察请求。

API 没有下单、撤单、策略启停、配置写入接口；代理目标限制为回环地址。没有复制 cfquant token 到浏览器或 TSP。两端需在同一主机网络空间，当前不支持 Docker 容器通过 localhost 访问 Windows 主机，也不要发布公网。

实时页复盘和明细仍受观察窗口限制，事实列表最多最近 100 条；历史回测使用独立流式分页接口，不受这个尾部窗口限制。旧策略进程要在正常结束后以更新代码启动才会产出实时观察日志。

## 历史回测使用

运行下拉框选择“历史回测”，页面读取保存的归档，不连接 cfquant、不执行策略。TSP 原有 `/backtest` 仍是它自己的回测引擎，`/data` 仍是行情管理；AlphaQuant 结果统一在 `/alphaquant` 查看。

兼容单日 replay、分钟回测和跨日 replay：识别 `summary.json` / `ARTIFACT_INDEX.md`，读取 `performance_report.json`、`equity_curve.json`、`benchmark_curve.json`、`trade_fills.json`、`orders.json`、`order_updates.json`、`signals.json`、`decision_log.jsonl`、`day_end_positions.json` 和各日 `final_state.json`。根目录聚合明细优先，缺失才遍历 `days/YYYY-MM-DD/`，不重复叠加。

- “绩效曲线”查看原报告指标、权益、累计收益、基准、回撤及月度字段。日胜率不是逐笔交易胜率，缺失指标显示 `—`；基准缺失不插值。回撤优先用原报告，缺失时从保存权益绘制。
- 成交、历史委托、决策、逐日持仓、候选、信号均可选日期和代码筛选，每页 100 条；“原始字段”可查依据。代码筛选输入后需点“应用筛选”。
- 点股票打开下方原生图表，日期窗口结束于所选记录日期。标记覆盖该股全运行成交，不受分页限制；行情仍需 TSP 数据源支持。图表标记只是成交日，不是复权成交价。
- 委托按 `order_intent_id` 关联回报和成交，避免跨日重复券商编号串单，不相加累计成交回报。所有委托是归档，不是当前活动订单。
- “下载绩效报告”与“导出筛选范围全部成交”输出 JSON。后者不限当前页；须检查 `complete` 与 `warnings`，损坏/缺失不能当作完整零记录。
- 历史缓存新鲜期 60 秒，点“重新读取归档”可刷新；不连接 SSE、不三秒轮询。运行切换重置筛选与页码，消失的运行不会自动切换成其他结果。

新增 GET：`/api/alphaquant/runs/{id}/backtest`、`backtest/{trades|orders|decisions|positions|candidates|signals}`（`offset`、`limit` 1–500、`day`、`symbol`）、`backtest/markers?symbol=...`、`backtest/report.json`、`backtest/trades.json?day=&symbol=`。代理已同步白名单和筛选参数。

需要升级 AlphaQuant 的 `.[panel]` 依赖以安装 `ijson`。明细 JSON/JSONL 流式分页；summary/绩效/最终状态仍有 24 MiB 上限，超限提示。候选是日末保存状态，不代表全天动态候选，其附带最近决策仍受尾部窗口限制；完整决策请切到“决策日志”。旧归档缺少的产物不会凭空恢复。特别大的归档扫描可能触及 60 秒请求超时。

## 验收与回滚

2026-09-12 历史兼容验证：TSP 原生 TypeScript/Vite 构建通过；AlphaQuant 历史/面板/代理/安装升级测试 29 项通过、1 项符号链接权限测试跳过；成交日与运行选择模型测试 2 项通过。同源代理读取真实周回测和全年回测通过，全年样本 243 个交易日、2,295 条成交、4,974 条决策，收益与原报告一致。未重新执行回测或连接券商。原生页面点击/视觉验收未完成：Tabbit 创建标签页报 `Target.createTarget`，重试仍失败；构建与旧独立面板的 UI 测试不代替浏览器验收。

在 AlphaQuant 目录运行映射测试：`node --experimental-strip-types --test integrations/tick_stock_panel/model.test.mjs`；需要支持 TypeScript 类型擦除的 Node 版本。历史/面板/安装器测试：`python -m pytest tests/test_panel_backtests.py tests/test_panel.py tests/test_panel_integration.py -q`。在 TSP 后端环境运行：`python -m pytest tests/test_extensions.py -q`。

逐项验收：选运行 → 选候选 → 联动日线 → 点历史日期查看分时 → 打开原生个股详情 → 展开 AlphaQuant 事实 → 切股/切运行 → 核对部分成交与撤单 → 下载复盘。检查行情缺失、观察服务断开、空运行和过期快照。真实行情与券商回报需在用户确认的只读联调窗口核对。

停用时正常停止本次面板进程，把 `frontend/src/custom/alphaquant` 移到源码目录外、把 `backend/app/custom/alphaquant_panel.py` 移到后端扫描目录外，再构建/重启 TSP。两个核心新增导出/查询键可以保留，它们不主动执行操作。不要删除 AlphaQuant 运行目录。

上游升级后应复核上述两个核心文件及 `StockPanel`、`StockPreviewDialog`、扩展 API，并重新构建测试。此安装器不承诺跨任意上游版本无修改兼容。
