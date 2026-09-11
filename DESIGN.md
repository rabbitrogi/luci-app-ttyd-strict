# luci-app-ttyd（strict fork）设计文档

> 本文是给未来开发者（人或 agent）的完整思路记录：每个设计决策
> 的**为什么**、被否决的替代方案、踩过的坑、验证方法学。
> 按时间顺序的原始调试日志见 `tests/E2E-NOTES.md`。

## 1. 目标与不变式

- **上游一致性**：外观与交互行为与 stock luci-app-ttyd 完全一致
  （用户零学习成本），仅在其上叠加安全约束。改动方式是 feeds 树
  最小 diff（term.js 重写 + 3 个新增文件 + Makefile 一词依赖）。
- **严格安全模型**：终端会话与"正在看着终端页面的那个浏览器标签"
  生命周期绑定。页面不在 ⇒ 不存在可连接的 root shell 入口。
- **用户驱动的重连**：`exit` 后终端静置等待，用户敲回车才重连；
  任何自动重连路径都是设计错误。

## 2. 最终架构（as-built）

```
LuCI 页面 (term.js)                OpenWrt (rpcd 插件 ttyd-strict)
─────────────────────              ─────────────────────────────
render ──► ensureSession ──ubus──► session_start
   │                                ├─ probe: /proc/net/tcp 找监听 inode
   │                                │  → /proc/*/fd 归属 pid
   │                                │  → netstat 数 ESTABLISHED 客户端
   │                                ├─ none      → 起 ttyd
   │                                ├─ ours+0    → 附着（状态载荷）
   │                                ├─ ours+1 / foreign+1 → busy 载荷
   │                                └─ foreign-other → 只报告不动手
   │◄── {result:started, pid} ────  (started 携带 pid 供页面认领)
   ▼
 mountTerminal(iframe)
   │
   ├─ 焦点门控: pageActive = focus && visible
   │   （失焦/后台标签休眠，永不发起启动/接管）
   ├─ 10s 轮询: pid 不符→夺回；foreign→ensureSession；
   │   ours+0 且未挂载→附着；ours+0 且已挂载→不动（等用户回车）
   └─ pagehide → sendBeacon(session_stop, {pid})
                                    │
                                    ▼
                          kill 仅当当前实例 pid == beacon pid
                          （陈旧 beacon 记日志跳过）
                          
孤儿兜底: 每次插件调用 EXIT trap 刷心跳文件；
probe 发现 ours+0 且心跳 >60s → 收掉（无后台进程）
```

**ttyd 参数**（`start_ours`）：`-p $PORT ${dev:+-i $dev} -m 1 -W -t disableReconnect=true $COMMAND`

| 参数 | 作用 | 不能去掉的原因 |
|---|---|---|
| `-m 1` | 单客户端排他 | 安全核心：唯一名额，第二连接被拒 |
| `-W` | 可写 | ttyd≥1.6 默认**只读**，缺它终端无法键入 |
| `-t disableReconnect=true` | 前端等回车 | 缺它任何断线（含 exit）都会**自动重连** |

## 3. 关键设计决策记录（Why & Why-not）

按重要程度排列。每条含"被否决方案"，它们都曾被实现、测试过，
记录防止未来走回头路。

### D1. 会话所有权 = 焦点 + 可见性（不是纯可见性）

**问题**：桌面 Chrome 与 ZCode 内置浏览器**并排都可见**时，各自
的终端页都在轮询，可见性门控无法裁决 → 互相接管对方的会话
（ping-pong），用户看到的就是高频 "Press ⏎ to Reconnect"。

**方案**：`pageActive = visibilityState=='visible' && hasFocus()`，
事件驱动的粘性状态（focus 事件→激活并立即轮询；blur/hidden→休眠）。
全局同一时刻只有一个焦点页面 ⇒ 唯一行动者。恢复焦点时凭 pid
认领：会话仍是自己的→不动；被偷→夺回。

**被否决**：纯可见性（上述 ping-pong）；busy 弹窗人工裁决（busy
的现实来源 99% 是自己的僵尸标签页，问用户是噪音；审计日志足够）。

### D2. `-m 1` + `disableReconnect`，而不是 `--once`

**问题史**（三次迭代）：
1. `--once`（断即亡，最简安全模型）→ exit 后监听器消失，回车无效；
2. `--once` + 轮询恢复监听器/自动重入 → 前端**必然自动重连**（见
   D3），违背"用户驱动"；
3. `-m 1`（监听器存活，exit 后同 pid 等回车）→ 仍自动重连，直到
   加 `-t disableReconnect=true` 才真正坐等回车。

**根因**（ttyd 前端 `xterm/index.ts` 的 `onSocketClose`）：
```
close code == 1000（正常）  → "Press ⏎" 等回车
close code != 1000（异常）  → 立即自动重连循环
```
`--once` 下 exit = 进程死亡 = 异常关闭；`-m 1` 下 ttyd 存活但
shell 退出时的关闭码**也不是 1000**。唯一可靠的开关是客户端选项
`disableReconnect=true`：它让 `doReconnect=false`，任何断线都走
等回车分支，且回车处理器照常工作。

**代价与兜底**：监听器会驻留（等待回车期间），需要两条清理路径：
- pagehide beacon（pid 认领）——页面离开立即停；
- 心跳文件——beacon 丢失（浏览器崩溃）时 60 秒后由 probe 收掉。

**被否决**：`--once`+任何前端侧恢复（自动重连不可关）；
`-m 1 -q`（等价于 --once 的关闭行为）。

### D3. 回车检测：不需要，也做不到

跨域 iframe（80 端口页面 vs 7681 端口终端）的键盘事件对父页面
不可见。**也不需要**：`-m 1` 下监听器活着，前端自己的回车处理
器原生完成重连——页面全程无需参与。想给重连加任何页面侧逻辑
前，先读 D2 的前端源码逻辑。

### D4. `-W` 必须显式传递

ttyd ≥ 1.6 **默认只读**。曾因缺失导致"终端能显示但完全无法键入"
——且此前的"键入成功"结论来自视觉模型转写截图，属于脑补（见
§5 验证方法学）。语义对齐 stock init 的 `readonly` uci 选项
（默认关 = 传 -W，勾 Read-only = 不传）。

### D5. interface 缺省 = 不传 `-i`（绑 0.0.0.0）

stock init 的语义：uci 无 interface 选项 → 不传 -i → ttyd 绑所有
接口。曾错误回退 `'lan'`，导致从 ZeroTier / 其他接口访问时 iframe
连不上自己的端口（connection refused）。**教训：fork 的缺省语义
必须逐项对照上游 init 脚本，不能想当然。**

### D6. 持久服务免疫：`enable=0` 是真防线

**问题**：`ttyd.init` 注册了 `procd_add_reload_trigger("ttyd")`——
任何 `uci commit ttyd`（包括 Config 页 Save & Apply）都会 reload
已被 disable 的持久服务；procd 对已停服务的 reload ≈ start。
无 `--once` 的常驻监听器 = 回到最初的漏洞（局域网任意直连）。

**方案**：uci-defaults 设 `enable=0`——init 脚本自身在
start/reload 时跳过 enable=0 的实例，对 reload trigger 免疫。
单纯 disable 不够。

### D7. 心跳文件替代看门狗进程（孤儿兜底）

rpcd shell 插件每调用一个方法就 fork 一次、无状态。孤儿监听器
（页面崩溃、beacon 丢失）需要某种清理：
- **心跳**：每次插件调用在 EXIT trap 里 `touch` 心跳文件；
  probe 发现 `ours+0 && 心跳>60s` → 收掉。页面开着→轮询持续
  续命→永不误收；页面没了→60s 后收。
- **EXIT trap 时序是关键**：刷新必须在 probe 之后，否则 probe
  看到的是自己刚摸的文件，永远"新鲜"。

**被否决**：nohup 后台看门狗进程（多一个进程、要管理 pidfile、
测试里 `kill` 是 shell builtin 还得绕）；不兜底（崩溃后监听器
无限驻留）。

### D8. pagehide beacon 必须带 pid

**暗杀事故**：旧页卸载的 sendBeacon(session_stop) 异步在途；新页
的 session_start 恰好先完成 → 迟到的 beacon 把**新会话**当 ours
杀掉 → 新页终端挂在被杀实例上 = "Press ⏎"。

**方案**：beacon 携带本页认领的 pid；插件 `session_stop` 收到
pid 参数时仅当与当前实例一致才动手，否则记日志跳过
（sandbox T14）。任何"页面离开时通知服务端"的设计都必须带
所有权凭证。

### D9. 删 beforeunload / 删 LuCI poll 框架 / 删状态栏

- **beforeunload**：内嵌浏览器（Electron webview）不显示 unload
  对话框而是**静默取消导航**——用户被锁死在页面上，而页面还占着
  唯一客户端名额。真实浏览器的好语义在内嵌环境是灾难。
- **poll.add()**：会让主题在页签栏渲染"刷新"控件（上游没有，
  违反最小 diff），且它**异步出现**在高度测量之后，把布局撑出
  滚动条。普通 `setInterval` 行为等价、零副作用。
- **状态栏/Starting session 占位**：对用户零信息量，且状态栏在
  10s 轮询后出现必然挤压终端高度（高度变化阈值只能掩盖不能根除）。
  保留的唯一 UI 是错误横幅（端口被非 ttyd 进程占用等必须人工
  介入的场景）。

### D10. viewport 自适应：物理测量 + 迭代收敛 + 阈值

三层现实决定了算法形状：
1. **documentElement.scrollHeight 会说谎**（argon 在 #maincontent
   内层滚动，文档永远报 0 溢出）→ 必须量"内容区+footer 中最深
   in-flow 元素物理伸出视口多少"（跳过 absolute/fixed 防 tooltip
   误收缩）；
2. **响应式断点使一次性收缩非 1:1**（argon 窄屏隐藏 footer）→
   收缩→重测→再收缩，≤3 轮，无改善即停，240px 下限；
3. **微调会放大**：状态文字回流引起 1-2px 变化若应用到 iframe，
   ttyd 会在终端里回显 xterm 尺寸（如 129x92）→ ≤4px 的变化
   一律不应用；MutationObserver 监听内容区（框架异步拼装页签/
   指示器），任何后到行自动被吸收。

### D11. 集成方式：feeds 树打补丁，不是 package/ 独立包

- 本地 `package/luci-app-ttyd` 会被 feed 同名包遮蔽（构建实际
  编译的是 feed 版）；该树 `scripts/feeds` 没有 override 子命令。
- 定式：`git checkout -- applications/luci-app-ttyd && git clean`
  还原 → rsync 5 个变更文件 → `sed` Makefile 加 `+jshn`。
  （customize-openwrt.sh 第 4 步已固化此流程。）

### D12. Makefile 的 conffiles define 必须在 include luci.mk 之前

luci.mk 之后定义会被忽略（feeds 里多个 app 同款写法可证）。

## 4. 踩坑清单（环境/工具，按杀伤力排序）

| 坑 | 症状 | 解法 |
|---|---|---|
| **luci 构建压缩 JS** | 321 行 term.js 打包后 22 行；带空格的 grep marker 全失配，误判"装了上游原版" | 装后必验用压缩态 marker（如 `ownedPid=res.pid`） |
| **浏览器页面跑内存 JS** | 部署后行为"没变"——旧页面执行的是导航时加载的代码 | 部署后必须刷新页面；诊断前先确认页面加载时间 |
| **procd reload trigger** | disable 的服务被 uci commit 复活 | `enable=0`（见 D6） |
| **expect 的 Tcl 语法** | `[t]tyd`、`$pid` 被当命令/变量替换 | 远程脚本一律走 scp 文件或 base64，绝不内联 |
| **macOS rsync/tar** | AppleDouble `._*` 进包；`COPYFILE_DISABLE=1` | rsync 代替 tar；装后 find 检查 |
| **源文件权限** | uci-defaults/rpcd 插件 644 进包，装上不执行 | 源目录 chmod +x；git update-index --chmod=+x |
| **kill 是 shell builtin** | 沙盒里 PATH 假 kill 永不被调 | 沙盒 sed 把 `kill "` 改名 `sbed_kill "` |
| **busybox jshn.sh 需二进制** | 24.10 jshn.sh 依赖 /usr/bin/jshn | Makefile `+jshn` 依赖 |
| **IAB/Electron webview** | beforeunload 静默取消导航；后台标签被冻结（连 evaluate 都只走 DevTools 通道） | 见 D9；后台标签测试用 prototype 覆盖 visibilityState + 事件注入 |
| **端口探测按端口不按 IP** | eth0:7681 的监听被误判为占用 eth1 会话 | probe 已按端口匹配；多 IP 设备注意此语义 |
| **容器读宿主 uptime** | OpenWrt 容器内 uptime 是宿主的，"没重启"误判 | 用其他证据判断（pid 序号、/var/run 清空） |

## 5. 验证方法学（血泪换来的规矩）

1. **键入类验证必须设备侧铁证**：在终端敲 `touch /tmp/MARKER`
   → SSH 查文件存在。视觉模型转写截图会把"没发生的事脑补成合理
   续写"（login: root → Password: → shell 全是编的）——本项目
   曾因此带着"只读终端"过了三轮 E2E。
2. **装后必验**：apk add 后立即 grep 压缩态 marker（见 §4 第一条）
   + wc -l + 权限位。构建区 stamp 腐烂、rsync 目标笔误都只能靠
   这道闸拦住。
3. **sandbox 45 断言**（`tests/sandbox-test.sh`）：伪造 /proc
   （net/tcp/uptime/pid 目录）、netstat、start-stop-daemon、
   sbed_kill、心跳/看门狗文件，跑遍 probe/start/takeover/stop/
   附着/宽限/pid 认领/心跳回收全分支。改插件必跑。
4. **E2E 用 headless Chrome + CDP**（`http://127.0.0.1:9223`，
   全新 profile），焦点用事件注入（headless 的 hasFocus 恒 false）。
   测完 **pkill -f chrome-ttyd**——曾因未清理，测试实例的轮询
   通宵自动重启会话，被用户当成"杀不死的怪进程"。
5. **expect 驱动 SSH** 的输出用 marker 包裹再正则（spawn 回显会
   污染输出）。

## 6. 已知边界与未来方向

- **等待回车期间监听器在监听**（`-m 1` 语义）：单客户端排他 +
   `-f root` 意味着等待期间"第一个连上来的人"拿到 shell。窗口
  限于页面开着的时间；页面关闭 beacon/心跳兜底。若要彻底关死，
  需要上游补"断链后停止 accept"的选项。
- **24.10 树未上机**：jshn 依赖已核实，脚本全 POSIX/busybox，
  理论兼容，缺实证。
- **i18n**：界面文案仅英文 msgid，可补 `po/zh_Hans`。
- **上游化**：issue openwrt/luci#9014 附本实现。若上游接受按需
  启停方向，最小捐赠是 rpcd 插件 + term.js 生命周期钩子。
- **LuCI 官方 viewport API**：若上游提供视图高度协议，D10 的
  测量法可整体替换。

## 7. 时间线索引

完整的按日调试记录（含每轮失败的原始细节）在
[`tests/E2E-NOTES.md`](tests/E2E-NOTES.md)。快速定位：
- 泄漏/持久服务复活 → 搜 `reload trigger`
- 重连语义三轮迭代 → 搜 `-m 1`、`disableReconnect`、`关闭码`
- 布局适配 → 搜 `belowFold`、`mobile-hide`
- 竞态族（双启动/beacon 暗杀/后台标签）→ 搜 `竞态`、`ping-pong`
