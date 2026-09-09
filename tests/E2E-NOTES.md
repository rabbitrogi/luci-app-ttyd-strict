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
