# a4 当前架构评估与优化建议

> 日期: 2026-03-15
> 性质: 非规范性设计评审文档
> 范围: 以当前仓库实现为准, 不改动协议分层方向, 只讨论如何在现有方向上收敛实现

## 1. 结论

当前架构的大方向是正确的:

- `protocol` 负责可互操作的数据模型和加密/签名算法
- `runtime` 负责本地状态、daemon、收件箱、E2E 会话和本地 API
- `relay` 负责控制面、路由、发现、离线队列、pre-key 控制面和 federation
- `cli` / `mcp-server` 负责操作入口, 不应成为状态真相源

问题不在于分层错误, 而在于当前实现里存在一些高成本分叉:

- 有 daemon 和无 daemon 两条运行路径并存, 且行为不完全一致
- `serve` 作为产品能力落在 CLI 层, 目前通过轮询 inbox 工作
- `delivered`、`reply`、`result` 三种状态容易被混在一起理解
- E2E 失败时的降级策略没有被产品层明确表达
- E2E device / pre-key 生命周期已经存在, 但还没有形成完整运维闭环

如果只做少量改动, 最值得优先做的是:

1. 让状态型操作统一走 daemon
2. 把 handler/serve 机制下沉到 runtime/daemon
3. 让 E2E 降级发送变成显式策略, 而不是静默 fallback

## 2. 当前架构快照

### 2.1 现状分层

```text
CLI / MCP
  -> local runtime / daemon
    -> protocol core
      -> relay client
        -> relay server
          -> discovery / queue / prekey / trust / federation
```

### 2.2 当前主链路

#### `listen`

```text
cli listen
  -> listener bootstrap
  -> start daemon
  -> daemon starts relay client + router + queue + trust + IPC
```

#### `find`

```text
cli find
  -> if daemon running: daemon discover
  -> else: anonymous direct relay session
```

#### `tell`

```text
cli tell
  -> resolve target DID
  -> if daemon running: daemon send
  -> else: direct relay fallback
  -> E2E encrypt per recipient device
  -> relay SEND / DELIVER / queue
```

#### `inbox`

```text
relay DELIVER
  -> daemon router
  -> E2E decrypt
  -> defense checks
  -> local queue / storage
  -> inbox / wait / trace
```

### 2.3 当前架构的优点

- 协议层和产品层有明确边界
- relay 被限制在控制面, 不承担业务执行
- daemon 已经天然成为本地状态聚合点
- inbox/result/trace 模型适合 async-first 交互
- E2E 设计是 "signed inner envelope + encrypted outer transport envelope", 层次清晰
- JS / Rust 双实现为互操作性提供了真实压力测试

## 3. 当前主要问题

### 3.1 daemon 路径与 direct path 并存

`find`、`tell` 等操作当前既可以走 daemon, 也可以绕过 daemon 直连 relay. 这会带来几个问题:

- 行为语义不一致
- trace 能力不完整
- `wait` 依赖 daemon inbox, 但 direct path 只具备部分能力
- E2E 失败时的 fallback 语义并不统一

这个问题不是代码风格问题, 而是系统边界没有完全收敛.

### 3.2 `serve` 位置偏高

当前 `serve` 在 CLI 层通过轮询 inbox 实现:

```text
daemon receives message
  -> queue inbox
  -> cli serve polls inbox
  -> cli exec handler
  -> cli calls daemon send(reply)
```

它能工作, 但会带来:

- 额外轮询延迟
- "已读" 与 "已处理" 的语义耦合
- handler 生命周期依赖 CLI 进程约定, 而不是 runtime 原生能力
- 难以为 MCP、未来 SDK 或守护进程复用

### 3.3 transport status 与 application outcome 容易混淆

当前系统里至少存在三层状态:

- relay / transport handoff
- remote message acceptance
- application reply / async result

其中 `delivered` 只表示:

- 已路由给在线 peer, 或
- 已被 relay 接收并排队

它不代表远端 handler 已执行, 更不代表任务成功.

如果不把这层区别在模型和 UI 上固定下来, 后续 CLI / MCP / dashboard 都会反复踩坑.

### 3.4 E2E 降级策略目前过于隐式

当前 daemon send 路径在 E2E 失败时可以 fallback 到普通签名 envelope. 这在工程调试上有价值, 但有两个风险:

- 用户以为自己在做 E2E 通信, 实际并没有
- 不同入口对 "是否允许降级" 的预期不一致

需要把这个策略显式化.

### 3.5 E2E 生命周期能力存在, 但缺少运维闭环

当前仓库已经具备:

- device directory
- pre-key publication and claim
- signed pre-key rotation primitives
- stale session recovery 基础
- multi-device fan-out

但 operator surface 仍偏弱:

- 没有冻结的 pre-key health 命令
- pre-key replenish / signed pre-key rotation 不是明确后台策略
- 低库存和 session stale 的状态表达不统一

## 4. 优化建议

### 4.1 P0: 让 daemon 成为唯一的本地状态真相源

建议收敛原则:

- `find` 可以保留匿名直连 fallback
- `tell`、`inbox`、`wait`、`trace`、`serve`、`status` 等状态型操作统一强依赖 daemon
- direct path 保留给只读、一次性、无状态操作

建议目标:

```text
read-only query
  -> daemon preferred
  -> optional direct fallback

stateful send/receive/workflow
  -> daemon only
```

预期收益:

- send / wait / trace 语义统一
- E2E session 行为统一
- 本地状态调试入口稳定
- CLI / MCP 行为更可预测

### 4.2 P0: 将 `serve` 下沉为 runtime/daemon 原生 handler 能力

建议把当前 CLI 轮询模型改为:

```text
daemon router
  -> message service
  -> native handler registry
  -> local process / script adapter
  -> reply/result emitter
```

CLI `serve` 只负责:

- 注册 handler
- 管理 handler 进程
- 展示日志

daemon 负责:

- 消息匹配与投递
- 并发限制
- timeout
- reply correlation
- result lifecycle

这样可以让 handler 机制变成 runtime 能力, 而不是 CLI 技巧.

### 4.3 P0: 将 E2E 降级发送改为显式策略

建议引入明确发送策略:

- `required`: 必须 E2E, 失败则报错
- `preferred`: 优先 E2E, 失败可降级
- `disabled`: 明确走非 E2E

推荐默认值:

- `tell` 默认 `required`
- 调试/兼容命令允许显式传 `--allow-plaintext` 或 `--delivery-mode preferred`

同时在:

- CLI 输出
- JSON 输出
- MCP structured content
- trace

都明确记录这次发送实际使用了哪条路径.

### 4.4 P1: 固化双轴状态模型

建议把状态拆成两条独立轴:

#### 运输状态

- `accepted_local`
- `handoff_pending`
- `handoff_done`
- `relay_queued`
- `expired`
- `transport_failed`

#### 业务状态

- `no_result`
- `progress`
- `reply_received`
- `terminal_result`
- `remote_error`

UI 或 API 可以组合展示, 但底层不要混成单一状态字段.

### 4.5 P1: 把 E2E device / pre-key lifecycle 变成一等能力

建议 daemon 后台明确承担:

- one-time pre-key low-watermark 检查
- 自动 replenish
- signed pre-key 周期轮换
- stale session 清理
- session reset / re-bootstrap 策略

建议提供稳定 operator surface:

- `a4 status --json` 包含 E2E health 摘要
- 独立 `prekeys` / `sessions` 视图
- 低库存和过期 rotation 的 warning

### 4.6 P2: 把双语言实现从"功能复制"推进到"参考实现 + 向量约束"

JS 与 Rust 双实现是资产, 但需要更强的边界约束:

- 指定 reference implementation 的边界
- 用共享 vectors / fixtures 驱动 JS、Rust、relay 兼容测试
- 尽量避免靠隐式字段顺序或实现细节维持兼容

长期建议:

- 更强的 canonicalization
- 更系统的 schema / vector 生成

## 5. 不建议轻易改动的部分

以下方向当前是对的, 不建议推倒重来:

- `protocol / runtime / relay / CLI / MCP` 五层结构
- relay 只承担控制面, 不承担业务执行
- inbox/result/trace 的 async-first 交互模型
- inner signed envelope + outer encrypted transport envelope
- device-based E2E 而不是 DID 直接承担加密

## 6. 目标架构

建议收敛到下面这个形态:

```text
CLI / MCP
  -> daemon local API
    -> message service
    -> handler service
    -> E2E/session service
    -> trust/defense service
    -> local queue + trace store
    -> relay client
      -> relay control plane
```

其中:

- `CLI / MCP` 只负责调用和展示
- `daemon local API` 是唯一状态入口
- `message service` 负责 send / inbox / reply correlation / result lifecycle
- `handler service` 负责 serve / local automation
- `E2E/session service` 负责 device、pre-key、ratchet、recovery
- `relay` 继续只做远端控制面

## 7. 渐进式迁移路线

### Phase 1

- 强制 `tell/inbox/wait/trace/serve/status` 走 daemon
- direct path 仅保留给只读查询
- JSON / MCP 输出增加明确的 `deliveryMode` / `actualTransport` 字段

### Phase 2

- daemon 内部加入 handler registry
- CLI `serve` 改成注册/管理 handler 的薄壳
- 将当前 inbox poll 模型标记为兼容层

### Phase 3

- 固化 transport/app 双轴状态
- trace 与 outbox/inbox 展示统一使用新状态模型
- MCP 与 CLI 共享同一状态解释

### Phase 4

- daemon 加入 pre-key health 后台任务
- 增加 operator-facing `prekeys` / `sessions` surface
- 明确 stale session 和 auto-recovery 策略

## 8. 简短结论

这套架构不需要推翻, 但需要收敛.

最重要的不是增加更多功能, 而是让以下三件事成为明确系统约束:

1. daemon 是唯一的本地状态真相源
2. handler/serve 是 runtime 能力, 不只是 CLI 技巧
3. E2E、transport、application outcome 三层语义必须显式区分

只要把这三件事收紧, 现有协议分层就足够支撑后续演进.
