# a4 E2E 跨语言通信摩擦点与优化分析

> 基于 2026-03-15 JS CLI ↔ Rust CLI 双向 E2E 加密通信调试全过程  
> 本文档已按当前代码状态更新，区分“已完成”和“仍待修复”。

---

## 一、已完成项目（截至 2026-03-15）

### 1. Agent Card / Envelope 签名跨语言兼容已修复

**状态**: 已完成

JS 与 Rust 现在统一使用 canonical JSON 做新签名；验签时先尝试 canonical payload，失败后再尝试 legacy 序列化 payload，因此不会在新版本上线瞬间把历史 card / envelope 全部打坏。

同时，Rust `Envelope` / `EnvelopeUnsigned` 已补齐 `groupId`，避免因为字段缺失导致“同一个 envelope 在两端签名面不一致”。

**落实点**
- `js/core/protocol/src/utils/canonical-json.ts`
- `js/core/protocol/src/messaging/envelope.ts`
- `js/core/protocol/src/discovery/agent-card.ts`
- `js/core/protocol/src/messaging/router.ts`
- `rust/core/src/protocol.rs`

### 2. JS daemon send 路径绕过 E2E 已修复

**状态**: 已完成

JS daemon 的 `handleSend` 现在走 `prepareEncryptedSends`，会先尝试 E2E 加密并按接收方设备 fan-out；只有在没有可用 card / pre-key 等场景才 fallback 到明文 envelope。

**落实点**
- `js/core/runtime/src/daemon-server.ts`

### 3. JS daemon receive 路径缺少 E2E 解密已修复

**状态**: 已完成

JS daemon 现在会识别 `/agent/e2e/1.0.0` transport envelope，调用 `prepareEncryptedReceive` 解密后把 application envelope 入队，而不是把原始 transport envelope 直接塞进 inbox。

**落实点**
- `js/core/runtime/src/daemon-server.ts`

### 4. JS daemon 缺少 E2E auto-recovery 已修复

**状态**: 已完成

JS daemon 现在具备与 Rust 对齐的自动恢复能力：
- 收到签名的 `e2e/session-reset` 会清理对应 peer 的本地 session
- 解密失败时会清理 stale session
- 会发送签名的 `e2e/session-retry`
- 会写入本地诊断消息 `e2e/decrypt-failed`
- sender 收到 `e2e/session-retry` 后会清理旧 session，并自动重放原始业务消息一次
- replay 后会自动重新走 PREKEY_MESSAGE 协商，不再要求用户手动再发一次

这部分没有采用 router 白名单绕过签名，而是统一走标准签名 envelope，设计更干净。

**落实点**
- `js/core/runtime/src/daemon-server.ts`
- `rust/cli-rs/src/daemon.rs`
- `js/core/protocol/src/messaging/storage.ts`
- `js/core/protocol/src/messaging/queue.ts`
- `rust/runtime/src/inbox.rs`

### 5. Rust 空 `e2e` config 启动崩溃已修复

**状态**: 已完成

Rust `LocalE2EConfig` 现在允许 `{}` 反序列化，并增加了统一的 `is_valid()` 判定。  
`ensure_local_e2e_config()` 会在状态无效时自动重建；CLI 调用点也统一改成显式检查 `is_valid()`，不再靠“空字符串默认值 + 调用方各自小心”。

**落实点**
- `rust/core/src/e2e/types.rs`
- `rust/core/src/e2e/device_state.rs`
- `rust/core/src/config.rs`
- `rust/cli-rs/src/commands/e2e.rs`
- `rust/cli-rs/src/daemon.rs`

### 6. `tell` 默认 protocol / payload 不一致问题已基本收敛

**状态**: 已完成

当前 JS CLI 与 Rust CLI 的 `tell` 都默认以 `/agent/msg/1.0.0` 作为基础 protocol；如果目标 card 暴露 `shell/exec` / `gpu/compute`，两端都会自动切到 `/shell/exec/1.0.0`，并把纯文本参数包装成 `{ "command": ... }`。  
因此“JS 默认 text / Rust 默认 shell/exec”这一旧摩擦点在当前代码里已经不是现状。

**落实点**
- `js/cli/src/commands/tell.ts`
- `rust/cli-rs/src/main.rs`
- `rust/cli-rs/src/commands/tell.rs`

### 7. 已补测试覆盖

**状态**: 已完成

已新增或更新的测试覆盖包括：
- canonical 签名一致性
- legacy 签名兼容验签
- `groupId` 参与签名面
- signed `e2e/session-reset`
- signed `e2e/session-retry`
- JS daemon decrypt-failure auto-recovery
- outbound retry metadata merge / replay-once
- Rust 空 `e2e` config 重建

**验证结果**
- `pnpm --filter @quadra-a/protocol exec vitest run src/messaging/storage.test.ts`
- `pnpm --filter @quadra-a/runtime exec vitest run src/daemon-server.test.ts`
- `pnpm --filter @quadra-a/protocol build`
- `pnpm --filter @quadra-a/runtime build`
- `pnpm --filter @quadra-a/relay build`
- `cargo test -p quadra-a-runtime`
- `cargo test -p quadra-a-cli-rs`
- 本机 `1 relay + 2 Rust agent` 实测：ratchet mismatch 后，receiver 发送 `e2e/session-retry`，sender 自动 replay 原业务消息成功

### 8. Relay ACK / delivery 语义已修复

**状态**: 已完成

JS relay 现在不再把“已发出 DELIVER”误报成“已送达”。当前语义已经调整为：
- `accepted` = relay 已持久化接收该消息
- `delivered` = 接收方显式 `ACK` 后，relay 再回送给发送方

实现上，所有 `SEND` 都会先进入持久化队列；在线目标也不例外。  
队列内部状态从旧的 `delivered` 调整为 `inflight`，重连时会重放所有未 ACK 的 `queued` / `inflight` 消息，因此 1006 / 半断开窗口里的消息不会再因为“先回 delivered、未落盘”而静默丢失。

**落实点**
- `js/relay/src/queue.ts`
- `js/relay/src/relay-agent-delivery.ts`
- `js/relay/src/relay-agent-client-handlers.ts`
- `js/relay/src/relay-agent-connection.ts`
- `js/relay/src/types.ts`
- `js/core/protocol/src/transport/relay-types.ts`

### 9. Rust 手动 `e2e reset` peer notification 已补齐

**状态**: 已完成（Rust CLI / daemon）

Rust `e2e reset` 现在不再只清本地。命令会先收集即将被删除 session 涉及的 peer DID，完成本地清理与持久化后，通知本地 daemon 发送签名的标准 `e2e/session-reset` envelope，并带上 `reason: "manual-reset"`。

这条链路没有采用 router 白名单绕过签名，而是复用现有 signed envelope 传输路径。  
另外，peer session key 的匹配也修正成精确 `peerDid:` 前缀，避免 DID 内含 `:` 时误删或漏删。

**落实点**
- `rust/cli-rs/src/commands/e2e.rs`
- `rust/cli-rs/src/daemon.rs`
- `rust/cli-rs/src/commands/send.rs`
- `rust/cli-rs/src/commands/tell.rs`

---

## 二、近期已完成的收口项

### 10. CLI 命令面第一阶段收敛已完成

**状态**: 已完成

公共命令面现在已经按“减法优先”的思路收敛到一套跨语言标准：

| 操作 | JS CLI | Rust CLI |
|------|--------|----------|
| 查看 card | `card show` | `card show` |
| 查看 identity | `identity show` | `identity show` |
| E2E 管理 | `e2e status/reset` | `e2e status/reset` |
| 停止网络连接 | `stop` / `leave` | `stop` / `leave` |

这里没有继续推动 `route` 做跨语言统一。当前决策是把它视为 JS 侧保留的高级命令，不纳入公共 CLI 规范；对外公开、需要双端对齐的命令面只保留最小公共集合。

**落实点**
- `js/cli/src/index.ts`
- `js/cli/src/commands/e2e.ts`
- `js/cli/src/commands/identity.ts`
- `js/cli/src/commands/stop.ts`
- `js/cli/src/commands/leave.ts`
- `rust/cli-rs/src/main.rs`
- `rust/cli-rs/src/commands/card.rs`
- `rust/cli-rs/src/commands/identity.rs`
- `rust/cli-rs/src/commands/e2e.rs`

### 11. Device ID 稳定性已修复

**状态**: 已完成

JS 与 Rust 现在都不再在每次重建 `e2e` 状态时重新随机生成 device ID。当前实现引入了独立持久化的 `deviceIdentity`，其中保存：
- 稳定 seed
- 由该 seed 派生出的 `deviceId`

device ID 的派生方式为 domain-separated hash：
- `device-${hex(sha256("quadra-a/device-id/v1" || seed))[0..16]}`

因此当本地 `e2e` 状态被清空并自动重建时，只要安装实例的 `deviceIdentity` 还在，新的 `LocalE2EConfig` 就会复用同一个 device ID；同时又没有把 device 生命周期硬绑定到 identity 本身，为未来多设备或显式轮换保留了空间。

另外，为了兼容旧配置，若本地已经存在有效 `currentDeviceId` 但尚未持久化 `deviceIdentity`，两端都会先回填 `deviceIdentity`，再继续后续重建逻辑，避免一次升级就把设备身份抖掉。

**落实点**
- `js/core/runtime/src/config.ts`
- `js/core/runtime/src/e2e-config.ts`
- `rust/core/src/config.rs`
- `rust/core/src/e2e/device_state.rs`

### 12. 本地 E2E 状态并发写入已收口

**状态**: 已完成

JS daemon / JS CLI / Rust daemon / Rust CLI 现在都不再各自裸读裸写本地 `config.json` 里的 E2E 状态。当前实现引入了跨进程目录锁：
- JS 使用 `$QUADRA_A_HOME/locks/e2e-state.lock`
- Rust 使用同一路径的同名目录锁

所有会修改 ratchet/session/pre-key 本地状态的关键路径，都会在锁内执行“读取配置 -> 突变 E2E 状态 -> 持久化配置”事务，避免 daemon 与前台 `tell` / `e2e reset` / reload / replay 并发时互相覆盖。

目前已经切到事务路径的关键调用点包括：
- JS daemon 的 send / receive / retry-replay / reload
- Rust daemon 的 send / receive / retry-replay / manual reset
- Rust CLI 的 direct `tell` 与 `wait` 解密路径

**落实点**
- `js/core/runtime/src/e2e-state.ts`
- `js/core/runtime/src/daemon-server.ts`
- `js/core/runtime/src/messaging.ts`
- `rust/cli-rs/src/e2e_state.rs`
- `rust/cli-rs/src/daemon.rs`
- `rust/cli-rs/src/commands/tell.rs`
- `rust/cli-rs/src/commands/e2e.rs`

---

## 三、建议的修复顺序

### 已完成

1. 统一 CLI 公开命令面，补齐 JS `e2e status/reset` 与 Rust `card show` / `identity show`
2. 明确 `stop` / `leave` 的 help 文案，减少语义漂移
3. 引入稳定 `deviceIdentity`，解决 device ID 抖动
4. JS CLI 复用 daemon 的 signed-reset helper，补上与 Rust 对齐的 `e2e reset` 用户入口

### 后续可选项

1. 评估是否需要把 relay queue / delivery state 暴露到 `trace` / `inbox` 里，方便诊断
2. 评估是否需要为 device identity 引入显式“新建设备 / 轮换设备”命令面
3. 继续压缩遗留兼容命令与隐藏入口

---

## 四、结论

跨语言 E2E 通信里最危险的一批问题已经处理完：
- canonical 签名迁移已完成
- signed `session-reset` 已打通
- signed `session-retry` + sender replay 已打通
- Rust 空 `e2e` config 容错已补齐
- relay ACK / delivery 语义已改成 `accepted` + ACK 后 `delivered`
- Rust 手动 `e2e reset` 已会通知 peer
- 本地 E2E 状态并发写入已切到跨进程事务锁

目前剩下的已经不再是基础链路打不通，而是后续收口与产品化问题：
- 是否继续收缩隐藏兼容命令
- 是否把 relay queue / ACK 诊断进一步暴露到用户可见命令
- 是否为 device identity 增加显式轮换命令

在 CLI 规范上，当前采取的是“先减法再统一”的路线：`route` 不进入跨语言公共命令面，只保留 `card show`、`identity show`、`e2e status/reset` 等最小公共集合。
