# E2E 真机验证结果（OpenWrt 25.12.5 @ 10.2.49.100, 2026-09-09）

部署方式：scp+tar 落盘安装（无 opkg 镜像），rpcd 重启加载插件，
stock ttyd 服务自动停用。浏览器：headless Chrome 152 + CDP（LuCI
sysauth cookie 注入绕过 IAB 表单限制）。

## 通过的场景

| # | 场景 | 结果 |
|---|------|------|
| 1 | 包安装、rpcd 加载、ubus 四方法冒烟 | PASS |
| 2 | 打开页面自动起会话，ttyd 按 uci 绑定 iface，日志完整 | PASS |
| 3 | iframe 渲染 ttyd 前端（横幅+login 提示符） | PASS |
| 4 | 高度自适应：514px 填满内容区，整页无滚动条 | PASS |
| 5 | 终端内 root 登录、执行 echo/uptime | PASS（截图 phase-c-logged-in.png） |
| 6 | 刷新页面 → 旧 ws 断 → ttyd --once 自退 → 新会话新 pid（2521555→2522856） | PASS |
| 7 | 无客户端残留实例 → 下次 start 自动回收重启（日志 reaping clientless） | PASS |
| 8 | 第二页面打开遇活跃会话 → busy 弹窗（pid/启动时间/客户端 ip:port）+ 日志，不擅自杀 | PASS（phase-e-busy-modal.png） |
| 9 | 用户确认接管 → 杀旧起新（2522856→2527165），原页面会话被终结 | PASS（日志 takeover: killing） |
| 10 | 占用期间直连 7681 → 只得到黑屏（无 pty/无登录提示），client_count 回落为 1 | PASS（phase-f3-direct.png） |
| 11 | 外部第二 ws 客户端（node）在占用期连接失败——名额互斥生效 | PASS |
| 12 | 孤儿回收（ttyd 已退、pidfile 残留）→ state=none，日志 orphan | PASS |

## 测试中发现并已修复

1. **term.js 入口分支 bug**：页面打开时若有无客户端的旧实例，直接弹
   busy 弹窗（文案还写 clients: 无），而不是走 session_start 自动
   清理。已修复：入口一律调 handleStart，服务端决定清理或弹窗。
2. **绑定接口与访问路径不一致**：uci interface=lan 解析到 eth0
   (192.168.68.1)，但管理流量走 eth1 (10.2.49.100) → iframe 连不上
   自己的端口。测试环境将 uci interface 设为 eth1 解决；README 已
   注明：必须绑定你访问 LuCI 的那个接口（或填 IP/0.0.0.0）。

## 已知行为（记录，不算 bug）

- `--once` 不在 TCP 层拒绝第二个 ws 升级：入侵者能完成握手但拿不到
  pty（黑屏），几秒后连接被清退，client_count 短暂 +1 后回落。
  安全语义不受影响（无终端=无 shell），但 busy 探测在该窗口内可能
  短暂计 2 个客户端。
- headless/后台标签冻结会断 ws（--once 随即退出）——真实前台使用无
  此问题；ttyd 前端不自动重连，页面靠 poll 的 state=none 自动重起
  会话兜底。

## 打包验证（2026-09-09，orb/Ubuntu 26.04 构建树 v25.12.5）

- `make package/luci-app-ttyd-strict/compile` 通过，产物
  `bin/packages/x86_64/base/luci-app-ttyd-strict-1.0.0-r1.apk`
  （25.12 已切换 apk 打包；noarch，depends: ttyd rpcd luci-base jshn）
- 打包修正：macOS tar 传入会夹带 AppleDouble `._*` 垃圾文件
  （传输需 COPYFILE_DISABLE=1 + --exclude），且 uci-defaults 与
  rpcd 插件必须显式 chmod +x（源目录权限会原样进包）
- conffiles：/etc/config/ttyd-strict 已入保护列表
  （define Package/.../conffiles 必须放在 include luci.mk 之前）

## 上游提交记录（2026-09-09）

- 参考实现: https://github.com/rabbitrogi/luci-app-ttyd-strict
- 安全 issue: https://github.com/openwrt/luci/issues/9014
- IAB 输入缺陷反馈（ZCode feedback 仓库）: issues #365 / #434 已评论

## 重构为最小 diff（2026-09-09 晚）

按"上游原样 + 最小 diff"重构：config.js / menu.json / po(zh_Hans)
照抄上游 @a8c110be；Makefile 仅 +jshn 与放置路径适配；改动集中在
term.js + 新增 rpcd 插件/ACL/uci-defaults。插件改读上游 /etc/config/ttyd
（第一个实例），-f root 由上游 Config 页配置。git 历史重写为
import+diff 两提交。集成方式：直接补丁 feeds/luci/applications/
luci-app-ttyd（本地 package/ 同名包会被 feed 遮蔽，25.12 的
scripts/feeds 无 override 子命令）。

设备迁移（10.2.49.100）：apk del 旧 luci-app-ttyd + luci-app-ttyd-strict
→ 安装 feed 补丁版 → uci ttyd interface=eth1 command='/bin/login -f root'。

真机验证（IAB）：上游 Config 页正常渲染（Command 字段可见 -f root）；
终端页自动会话 + -f root 直达 root shell（无 login 提示）。

期间发现并修复：① 重构时 ACL 丢了 session_status read 段（页面报
Status probe failed）；② 后台节流标签页会以 ~70s 周期 poll 自动重起
会话，与新开页面抢端口触发 busy 弹窗（设计边界，弹窗即正确的用户
决策入口）。

## 干净重建验证（2026-09-09 晚，最终）

流程：复查 diff → orb 上 feeds/luci git checkout+clean 还原上游
原样（与 import 提交逐文件比对零漂移）→ 重新打补丁（恰好 5 处：
Makefile +jshn、term.js、rpcd 插件、ACL、uci-defaults）→ 重建 →
设备 apk del/add 换装 → IAB 全流程测试。

结果：登录 → 终端页自动会话 → -f root 直达 root shell（无 login
提示）→ 合成输入敲入 echo CLEAN-REBUILD-OK/date 输出正常。

## 泄漏事件复盘与修复（2026-09-09 夜，重启清场后全绿）

用户实测：终端页切到别的菜单后直连 7681 可得 root shell。复盘
真相为两因叠加：
1. 根因：ttyd.init 的 procd_add_reload_trigger —— 任何
   `uci commit ttyd`（含 Config 页 Save&Apply）会 reload 已 disable
   的持久服务，且当时 /etc/config/ttyd 因多轮 apk del/add 退化为
   残缺配置（enable 项丢失，默认 1），持久 ttyd（无 --once）抢注
   端口并接受多客户端 —— 直连即 root。
   修复：uci-defaults 设 `enable=0`（init 脚本自身在 start/reload
   时跳过 enable=0 的实例，对 reload trigger 免疫）；配合干净
   重置（卸载+重写上游原生配置+重装+reboot）清场。
2. 加固：term.js 增加 beforeunload（活跃会话时离开页面确认，即
   原版语义）与 pagehide 时 sendBeacon 调 session_stop 的兜底。

澄清两点误判：LuCI 菜单是硬导航（无 SPA）；argon 一级菜单点击
仅展开子菜单不导航（测试需点叶子项）。

干净重启后复测六项全过：A1 开页 ours+1client；A2 叶子菜单切走
→ none；B1 关闭后直连拒绝；B3 占用时第二 ws 被拒名额唯一；
C1 uci commit ttyd 不再复活。headless 下 beforeunload 被浏览器
自动跳过属正常，真浏览器会弹确认框。

## interface 缺省语义对齐上游（2026-09-09 深夜）

用户删除 uci interface 期望 ttyd 监听 0.0.0.0（stock init 语义：
无 interface 不传 -i），但插件此前回退默认 'lan' → 绑 eth0 →
从其他接口访问时 iframe 连接被拒。修复：interface 缺省为空 →
start_ours 不传 -i → ttyd 绑 0.0.0.0（所有接口，含 ZeroTier）。
设备实测：无 interface 时监听 0.0.0.0:7681，LAN/zt 接口均可达，
单会话门禁（--once + 页面生命周期）不受影响。

## -W 可写参数缺失（2026-09-09 深夜，用户实测发现）

ttyd >= 1.6 默认只读；插件未传 -W 导致终端完全无法键入。此前
E2E 中"终端内登录/执行命令成功"的结论依赖视觉模型转写截图，
存在脑补风险——本次教训：键入类验证必须用设备侧证据（终端内
touch 文件 + SSH 查存在）。修复：read_config 读 uci readonly
（默认 0）→ 非 1 时传 -W，与 stock init 的
`[ "$readonly" = 0 ] && readonly="-W"` 语义一致。

## takeover 端口释放竞态（2026-09-09 深夜，用户实测发现）

点 Reconnect → Take over 后偶发 iframe 显示连接拒绝、约 10 秒才
恢复。机制：kill 旧实例后 wait_listener_gone 仅 2s，端口未完全释
放时新 ttyd 绑定失败 → start_ours 静默重试 2-3 轮（每轮 2s 验
证）；期间旧 iframe 指向已死端口显示 ERR_CONNECTION_REFUSED，
rpc 返回后才挂新 iframe。修复：
- wait_listener_gone 2s→4s；start_ours 每 attempt 前先等残留监
  听消失
- 前端 takeover 点击后立即清空旧 iframe 显示 "restarting
  session..."（不再展示必败的错误页）
- poll 自愈：会话在跑但 15s 无客户端连接时重挂 iframe 一次
  （覆盖 iframe 挂错误页的残留场景）

## 移除手动按钮，全自动生命周期（2026-09-09 深夜，用户设计评审）

用户观点成立：页面生命周期已全自动（进=起、走=死），人工环节
多余——busy 场景现实中几乎总是自己的僵尸标签页，"问用户要不要
接管自己"是噪音；多用户场景有 syslog 审计兜底。改动：
- 删除 Reconnect / Stop session 按钮与 busy 弹窗
- 进页面全自动：无会话→起；残留无客户端→自动清；有客户端→
  自动接管（状态栏提示 + 设备日志留痕）
- 离页面自动停（ws 断 + pagehide beacon，不变）
- poll 自愈保留（none 自动重启 / 15s 无客户端重挂 iframe）

## 视口完整适配（2026-09-09 深夜）

fitTerminal 增加第二遍"溢出吸收"：先撑满视口剩余，再量
documentElement.scrollHeight 与 innerHeight 的差值（footer 等）
并扣掉——整页恰好容纳，浏览器滚动条消失，footer 完整可见。
主题无关（不量 footer 具体高度）。

## 移除 LuCI poll 框架带来的"刷新"控件（2026-09-10）

poll.add() 会让主题在页签栏渲染一个上游没有的"刷新"控件（最小
改动原则不可接受），且该控件异步出现在高度测量之后，把布局撑
出滚动条——正是 viewport 适配仍不正确的根源。改为普通
setInterval 轮询（10s，行为不变），控件与该行高度一并消失。

## 布局异步变化的通用适配（2026-09-10）

fitTerminal 增加 MutationObserver（监听 #maincontent childList/
subtree）：框架在视图渲染之后异步拼装的任何行（页签栏、指示
器、未来框架变化）都会触发重算，配合两遍溢出吸收，滚动条不可
能因布局后到而复现。headless 实测（无缓存）：tabmenu 仅含页签
（52px），整页 overflow=0，footer 完整可见。

## 滚动条根因：内层滚动容器（2026-09-10，用户 Console 实测数据定位）

用户环境数据：documentElement overflow=0 但 footer 物理底部
1721px > 视口 1658px——argon 主题在 #maincontent 等内层容器滚动，
documentElement 永远报 0，两遍吸收因此失效。修复：第二遍改为
量"内容区+footer 中最深元素物理伸出视口多少"（跳过
absolute/fixed 悬浮元素防误收缩），与滚动容器归属无关，任何
主题下都成立。headless 回归 overflow=0。

## 窄屏（footer 被 mobile-hide 隐藏）适配（2026-09-10 上午）

用户实测：argon 在窄宽度下去侧栏、置顶 logo、footer 加
mobile-hide 隐藏，残余约 10px 溢出。一次性按溢出量收缩在响应式
断点切换/容器 padding 下非精确 1:1。改为迭代收敛：缩→重测→
必要时再缩（≤3 轮，带"无改善即停"与 240px 下限保险）。
headless 回归 1280/500/400 宽全部 belowFold=0（footer 隐藏时同
样收敛）。

## 双启动竞态与高度微调（2026-09-10 上午）

用户实测两问题：
1. 进终端页约 1/10 概率显示 "Press 回车 Reconnect"（ws 已断但
   HTTP keep-alive ESTABLISHED）。机制：ensureSession 的接管耗时
   2-4s，期间 10s 轮询见瞬态 none 也发起 session_start 并在锁上
   排队；接管刚起的新实例尚未等到 iframe 连接（client_count=0）
   即被排队请求当残留回收重起，iframe 的 ws 随之中断。修复三层：
   - 插件：无客户端且实例年龄 <5s → 宽限返回状态不回收（顶层
     exit，误用 return 曾致穿透双输出——沙盒 T13 抓出）
   - 前端：ours+0 客户端 → 视为"正在上线"直接挂载而非接管
   - 前端：ensureSession 统一登记 lastAutoStart，轮询 15s 内不
     再自动发起第二次 start
2. 进页约 10s 高度被微调，xterm 在终端回显尺寸（如 129x92）。
   修复：fitTerminal 高度变化 ≤4px 不应用（状态栏文字回流引起
   的 1-2px 抖动不再传导到 iframe resize）；收敛循环仅在溢出
   >2px 时动作。沙盒 41/41。

## 移除状态栏与占位文本（2026-09-10，用户设计评审第二轮）

"Session active (pid…)" 状态栏与 "starting session…" 占位文本对普
通用户无信息价值，且状态栏在 10 秒轮询后出现必然挤压终端高度
（即使有 ≤4px 阈值也属多余 UI）。全部删除：term.js 仅保留错误
横幅（非 ttyd 进程占端口 / RPC 失败等必须人工介入的场景）。
load/render 签名回归上游形态（load 仅 uci.load）。orb feed 树顺
带清除两处早期误 rsync 的杂散文件。headless 回归：进入即终端、
无状态栏、belowFold=0、跨 10 秒高度 619px 纹丝不动。

## 迟到 beacon 暗杀新会话（2026-09-10，移除 pagehide beacon）

症状回归且高频化：刷新/点终端页签后频出 "Press 回车
Reconnect"。机制：旧页卸载时 sendBeacon(session_stop) 异步在途；
新页 ensureSession（本版少了 status 预探测往返，start 完成得更
早）刚起好新实例，迟到的 beacon 把它按 ours 杀掉——终端挂在被
杀实例上。此前版本因 load() 先行 RPC 往返，start 恰好落在
beacon 之后而侥幸无恙。

beacon 本属"保险带"，但 ws 断开（页面卸载与 bfcache 进入都会强
制关闭 ws）已让 --once 实例退出，beacon 从未实际救场、反成杀
手——连同 sessionActive 标记与 callSessionStop 声明整体移除。
headless 5/5 连续刷新回归：每次 ours+1client+新 pid，最终会话
无迟到 stop（日志核对 started 与 stopped 的相对位置）。
