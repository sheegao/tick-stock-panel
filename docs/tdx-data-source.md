# 通达信 TDX 数据源操作手册

## 1. 接入范围

本功能在 TSP 仓库内，以 L2 数据源插件接入现有 capability 路由，不修改
AlphaQuant / cfquant 的交易连接，也不自动修改当前数据源设置。

链路：TSP 数据服务 → Python TdxProvider → 本机 Go HTTP 桥 → 通达信行情服务器。
Go 桥使用 [injoyai/tdx](https://github.com/injoyai/tdx)，固定上游 commit
`2b3dcae30c42cae1f5e2f3a33359d12b761ae7fe`，不是追随 master 的浮动依赖。

| 能力 | 当前状态 |
| --- | --- |
| 证券列表 | 股票/基金代码分类及指数代码；沪深分页，北交所从 zhb.zip 读取 |
| 日线 | 股票、ETF、指数原始未复权 OHLCV；区间筛选、分页、分批落盘 |
| 分钟线 | 股票、ETF、指数原始 1 分钟 OHLCV；北京墙钟、区间筛选，保守声明 80 个交易日 |
| 实时行情 | 股票列表逐批快照；可补充指定指数快照；非交易所推送流 |
| 除权因子 | A 股股票 category=1 除权除息事件；结合原始日前收盘推导单事件比率，非累积值 |
| 五档盘口 | 股票、ETF、指数买卖一至五档；数量单位为手，时间为本机桥接接收时间 |
| 财务/全量分钟/逐笔 Level2 | 不声明，不提供；继续使用原来支持这些能力的来源 |
| 公告、概念、行业、雪球推送 | 不由这个插件提供，原有服务不变 |

这不是 TickFlow 全能力等价替代。基金分类按上游代码规则，可能包含非 ETF 基金，
不要据此推断完整的基金产品分类。北交所覆盖取决于服务器报表和行情协议支持，
服务器不提供报表时证券列表拉取整体失败，不能把缺失市场的列表当完整列表保存。

## 2. Windows 启动

开发机器安装 Go 1.25 或更新版本。Python 沿用 TSP 现有环境，不需要新的 Python
包，也不需要在浏览器配置 TDX API Key。首次构建需要联网下载 Go 模块。

如果默认 Go 模块代理在当前网络不可达，可在这个窗口选择你信任的代理，例如：

```powershell
$env:GOPROXY = "https://goproxy.cn,https://proxy.golang.org,direct"
```

这只影响当前窗口，不改变系统配置；保留默认模块校验和校验，不关闭 checksum 验证。

在 TSP 仓库根目录的 PowerShell 执行：

```powershell
.\backend\scripts\start_tdx_bridge.ps1
```

保持窗口开启，`Ctrl+C` 停止。脚本把二进制和默认 Go 缓存放在用户本地应用数据
目录，不写进仓库。可以指定 Go 和输出目录（路径自行替换）：

```powershell
.\backend\scripts\start_tdx_bridge.ps1 `
  -GoExecutable "D:\Tools\go\bin\go.exe" `
  -OutputDirectory "D:\Tools\tsp-tdx"
```

默认只监听 `127.0.0.1:3020`。无行情端口可用时，可以提供自己获准使用的服务器：

```powershell
.\backend\scripts\start_tdx_bridge.ps1 -Hosts "服务器地址:7709,备用服务器地址:7709"
```

默认尝试上游列表的前 8 个服务器，网络失败后下次请求重新连接；没有无限重连。
TCP 连接成功不代表可用，桥接还会读取实际行情确认协议。健康检查可能在首次连接
时超时，稍后重试；无需据此修改当前数据源。只有报价、日K、分钟K和除权事件
探针均返回有效结构，健康检查才会声明
`daily/adj_factor/minute/realtime/depth5` 五项能力。
桥接显式关闭上游 SDK 的原始协议帧调试输出，只记录连接与服务状态。

需要改端口时使用 `-Port 3021`，并在**启动 TSP 后端的窗口**设置：

```powershell
$env:TDX_BRIDGE_URL = "http://127.0.0.1:3021"
```

地址仅允许本机 loopback HTTP。插件从进程环境读取该变量，设置后需重新启动后端；
不要提交机器配置。Linux/macOS 可在 `backend/app/plugins/tdx/bridge` 中运行
`go build -mod=readonly -o /your/local/path/tdx-bridge .` 后执行该二进制。
本机桥接不含订单接口，不能下单。

## 3. 验证及设置页选择

先检查桥接本身（PowerShell）：

```powershell
Invoke-RestMethod http://127.0.0.1:3020/health

$body = @{
  op = "daily"
  symbols = @("600519.SH", "000001.SZ")
  asset_type = "stock"
  start = "2026-09-01"
  end = "2026-09-18"
} | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3020/query -Method Post `
  -ContentType "application/json" -Body $body

$body = @{ op = "quotes"; symbols = @("600519.SH", "000001.SH") } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3020/query -Method Post `
  -ContentType "application/json" -Body $body

$body = @{
  op = "minute"
  symbols = @("600519.SH")
  asset_type = "stock"
  freq = "1m"
  start = "2026-09-18T09:30:00"
  end = "2026-09-18T15:00:00"
} | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3020/query -Method Post `
  -ContentType "application/json" -Body $body

$body = @{
  op = "adj_factors"
  symbols = @("600519.SH")
  asset_type = "stock"
  start = "2025-01-01"
  end = "2026-09-19"
} | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3020/query -Method Post `
  -ContentType "application/json" -Body $body

$body = @{ op = "depth5"; symbols = @("600519.SH") } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3020/query -Method Post `
  -ContentType "application/json" -Body $body
```

`/health` 应返回 `version=1`、`ready=true`，price/amount 为 yuan、volume 与
depth_volume 为 hands，同时 `features` 必须包含五项能力；还应返回
`adj_factor_kind=single_event_ratio` 和 `depth_timestamp=local_receive`。失败返回
503 和原因，TSP 不会把失败、旧版本或口径不一致的桥接标为可切换。

打开 TSP 的「设置 → 数据源」，点击「重新加载」，找到「通达信 TDX（本机桥接）」。
先按上面命令检查日线、除权、分钟线、快照和五档，再按能力分别选择 TDX。
**财务、全量分钟和逐笔 Level2 仍不能切到 TDX**。标的维表跟随日K来源，
没有独立偏好项。除权和五档是独立路由，可以只切其中一项。
切换日K来源后，先同步证券列表，再用少量股票验证历史同步及涨跌幅，最后考虑全市场。
切换分钟来源后，先同步单只股票的单个交易日，再检查 09:30—11:30、
13:00—15:00 的北京墙钟、价格、成交量和成交额；确认后再扩大范围。设置页会把
该来源的分钟历史上限显示为 80 个交易日，插件只接受 `1m`，不会伪装支持 5/15/30 分钟。

实时全市场按 80 只一批读取，建议初始轮询间隔 30 秒以上；实际刷新周期还包括拉取
耗时。试拉实时能力只读取指定样本，不会为测试扫描全市场。市场列表缓存 1 小时。
五档同样按最多 80 只一批读取；除权因子按最多 5 只一批读取。先用设置页单标的
试拉确认口径，再考虑让五档服务或日线同步使用该来源。

## 4. 数据口径与风险

- 日线价格为原始价，**不做前/后复权**；volume 为手，amount 为元。
- 分钟线同样是未复权原始价，datetime 是无时区的北京时间墙钟；volume 为手，
  amount 为元。Python 侧拒绝带时区、超出 A 股上午/下午交易时段或 OHLC 不一致的行。
- 涨跌幅、振幅按小数制输出，例如 10% 为 0.10；换手率未知返回 null，不猜测。
- 上游 Price 为厘，桥接转换到元。指数日线与分钟线在 SDK 内走不同成交量路径：
  日线解码后的值已经是手，直接保留；分钟线撤销指数专用额外放大后输出为手。
- 上游 Quote.Kline.Time 是读取时生成的本机时间，并非真实行情归属日期。桥接
  不使用这个时间，`timestamp=null`，保留 `source_time` 原始字段和
  `time_provenance=trade_date_unavailable`。source_time 编码未作为标准时间解析。
- **TSP 通用实时入口对缺失 timestamp 会回退本机接收时间**；这仅表示收到快照，
  不能证明该股票当日仍在交易或报价未延迟。不要依赖这个插件判断实盘报价新鲜度，
  或把盘中未完成的日K当成收盘结果。ST 情绪等当日分析也应与可靠来源交叉核对。
- 除权事件来自 TDX `Gbbq` category=1。分红、送转、配股和配股价按每 10 股口径
  合并同日事件，以原始日K中严格早于除权日的最近收盘价计算交易所参考价，参考价
  四舍五入到分后输出 `前收盘/参考价`。这是**单事件、非累积**因子；累计与历史
  前复权由 TSP 现有管道完成。未来尚未生效事件被排除，缺少前收盘或出现非法公式
  时整批失败，不保存部分结果。目前 ETF/指数除权返回标准空表。
- 日线分页最多 32 页 × 800 根，证券列表最多 66 页；触及上限报错而不是静默截断。
  服务器自身历史保留范围可能更短：接口正常结束不证明请求日期范围内历史完整。
- 1 分钟线按上游 24,000 根上限分页，插件保守对设置页声明 80 个交易日。自然日
  区间内若服务器缺少个别交易日，插件不会凭空补齐；触及 30 页上限时整次报错，
  不把截断数据当完整历史。指数分钟成交量撤销 SDK 的指数专用额外放大后输出为手。
- 上游五档快照只有不透明的 `source_time`，没有可靠交易日期。桥接输出的毫秒
  `timestamp` 明确是本机收到该批响应的时间，并携带
  `timestamp_provenance=local_receive`；不会把它冒充交易所撮合时间。买卖价格和
  数量保持一档到五档顺序，数量直接按上游盘口的“手”输出。它是轮询快照，不能
  替代逐笔委托/逐笔成交，也不能证明休市后的盘口仍新鲜。
- 单日K批次最多 5 个标的。日K同步异常向上抛出，分批 staging 不被当成完整成功。
  实时任意一批失败时整轮返回空，指数失败返回 None，以保留上轮有效缓存。
- 桥接只在本机监听，不提供公网服务。Docker 内 `127.0.0.1` 是容器自己，不能直接
  用来连宿主机；首版不扩展远程绑定，请在同一个网络命名空间运行桥接与后端。
- 上游 MIT 许可仅涵盖软件，不代表行情版权授权、稳定性或服务 SLA。服务器
  限流、停服、协议变化、网络封锁需要使用者评估；不要绕过访问限制。

## 5. 回滚、数据与验证

### 本次验证记录（2026-09-19）

Python TDX 插件契约测试 46 项、TDX 与相邻能力路由回归 135 项、Go 单测/静态检查、
前端提示测试及生产构建已执行通过。设置页已实际验证 TDX 卡片、启动提示、
不可用路由及只读详情。
验证过程不调用数据源偏好写接口，也未用 TDX 数据覆盖现有 Parquet。

本轮新增 1 分钟、除权因子和五档能力。契约测试覆盖北京墙钟、交易时段、字段单位、
区间过滤、非法时间/OHLC 拒绝、分页与 24,000 根边界；除权测试覆盖同日事件合并、
分价四舍五入、单事件比率、未来事件与缺失前收盘；五档测试覆盖五级长度、手数、
本机接收时间及不完整批次失败。旧桥或口径元数据缺失的桥不会被误判为完整可用。

真实服务器验证已完成：桥接连接 `124.71.187.122:7709`，健康检查返回
`daily/adj_factor/minute/realtime/depth5`；贵州茅台 2026-09-18 返回 1 根日K和
240 根分钟K，
Python Provider 与设置页试拉均通过。沪深300 ETF 与上证指数日K/分钟K也已抽样；
实测识别股票 5,575 只（含北交所 349 只）、ETF 2,464 只、指数 1,674 只。
真实样本发现并修正了指数日线成交量被缩小 100 倍的问题，同时显式关闭 SDK 原始
协议帧日志，修正后重新构建、健康检查和样本查询均通过。这里的验证只代表本机、
当前服务器和当前上游 commit；不构成行情完整性、持续可用性或授权保证。

除权与五档增量验证连接同一服务器：贵州茅台 2024-06-19 至 2026-06-26 得到 5 个
单事件因子；其中 2025-12-19 的 `1.0170286559017512` 和 2026-06-26 的
`1.0236639416255657` 与扶摇独立链路逐位一致。设置页后端试拉得到近一年 2 条因子
及买卖五档各 5 级，盘口数量为手，时间来源标识为 `local_receive`。验证未切换任何
数据源偏好，也未写入现有 Parquet。

运行路由也已验证：单股详情临时补拉除权因子时会读取独立
`adj_factor_provider`，不再硬编码 TickFlow；切换 `depth5_data_provider` 后会按新的能力
快照停止并重新评估五档轮询线程，无需重启后端。五档定时轮询仍受“连板梯队五档
监控”和实时行情开关控制，关闭监控时只保留按需读取与每日定版能力。

### 回滚与开发验证

在设置页把日K/除权/分钟K/实时/五档来源改回原来源即可；TDX 未启用时不会替换数据。已经同步
的 Parquet 数据不会因停桥接被删除；更换来源后重新同步会沿用 TSP 原有合并/
覆盖规则，必要时先备份数据目录。停止桥接后点击重新加载，卡片变为不可用。

Python 测试覆盖字段单位、日期/分钟区间、北京墙钟、空批进度、畸形数据、失败
隔离、版本/能力检查及 loader 注册；Go 测试覆盖代码转换、日线/分钟单位、时间
缺失、分页边界、除权公式与五档映射，并提供显式开启的真实服务器集成测试。

```powershell
cd backend
uv run --extra dev pytest tests/test_tdx_provider.py -q
uv run --extra dev ruff check app/plugins/tdx tests/test_tdx_provider.py
cd app/plugins/tdx/bridge
go test ./...
go vet ./...

# 可选：明确发起真实公网 TDX 服务器抽样；默认单测不会联网
$env:TDX_LIVE_TEST = "1"
go test -run TestLiveTDXAdjustmentFactorAndDepth -v
Remove-Item Env:TDX_LIVE_TEST
```

新增插件文件、启动脚本和本文；另对设置页做最小 L3 修正：无 Key 插件显示真实
启动提示，未就绪卡片允许只读查看详情（不会切换路由）。不改变公共 API schema、偏好字段、
持久化 schema 或已有数据源默认值。升级 TSP 时复核插件契约，升级 TDX 依赖时
必须重跑单位、交易日期、指数、基金小数位及北交所覆盖的实际样本验证。
