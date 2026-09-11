# luci-app-ttyd（strict fork）

Stock `luci-app-ttyd` 的安全加固版：外观与交互与上游一致
（零学习成本），会话生命周期与"正在看着终端页面的那个标签"
绑定。设计思路、决策记录与踩坑清单见
[`DESIGN.md`](DESIGN.md)；上游提案 openwrt/luci#9014。

## 行为总览

| 场景 | 行为 |
|---|---|
| 进入/聚焦终端页 | 自动启动会话（被旧标签占用则自动接管，日志留痕） |
| 失焦/切后台标签 | 页面休眠——永不发起启动/接管（焦点唯一原则） |
| 切回/重新聚焦 | 凭 pid 认领：会话仍归我→不动；被偷→自动夺回 |
| 离开页面（点菜单/关标签/刷新） | 监听器立即停止（pid 认领 beacon；丢失时心跳 60s 兜底） |
| 终端内 `exit` | 监听器同 pid 存活，终端显示 "Press ⏎ to Reconnect" **静置等待** |
| 用户敲回车 | 重连成功，新 shell（与上游完全一致；永不自动重连） |
| 端口被非 ttyd 进程占用 | 只报告不动手（错误横幅提示人工处理） |

所有决策写入 syslog（`logread | grep ttyd-strict`）。

## 与上游的差异（最小 diff）

对照上游（verbatim import 提交 eafb063）仅 5 处：

| 文件 | 性质 |
|---|---|
| `htdocs/.../view/ttyd/term.js` | 重写：会话生命周期 + 视口自适应 |
| `root/usr/libexec/rpcd/ttyd-strict` | 新增：rpcd 插件（probe/start/takeover/stop + 心跳孤儿回收） |
| `root/usr/share/rpcd/acl.d/ttyd-strict.json` | 新增：ubus/uci 授权 |
| `root/etc/uci-defaults/40_ttyd-strict` | 新增：禁用持久服务 + `enable=0`（对 procd reload trigger 免疫） |
| `Makefile` | 一词：`+jshn` 依赖 |

`config.js`（Config 配置页）、`menu.json`、`po/` **原样未动**——
interface/port/credential/command 等都在上游配置页修改。

## 配置

复用上游 `/etc/config/ttyd`（第一个实例）：

```
uci set ttyd.@ttyd[0].command='/bin/login -f root'   # 免密 root
uci set ttyd.@ttyd[0].interface='eth1'               # 留空 = 0.0.0.0 全接口
uci commit ttyd
```

- 免密 root 的安全性依赖：LuCI 登录门禁 + 单客户端排他 +
  页面生命周期绑定（本 fork 的全部意义）。
- `interface` 必须是**你访问 LuCI 所经的接口**（或留空绑全部，
  ZeroTier 场景推荐留空）。

## 集成（构建树）

```sh
cd <openwrt-tree>
git -C feeds/luci checkout -- applications/luci-app-ttyd   # 还原上游
git -C feeds/luci clean -fdq applications/luci-app-ttyd
rsync -a <本仓库>/htdocs/.../term.js  feeds/luci/applications/luci-app-ttyd/htdocs/.../
rsync -a <本仓库>/root/...           feeds/luci/applications/luci-app-ttyd/root/...
sed -i 's/^LUCI_DEPENDS:=+luci-base +ttyd$/& +jshn/' feeds/luci/applications/luci-app-ttyd/Makefile
make package/luci-app-ttyd/compile
```

customize-openwrt.sh 第 4 步已固化此流程（克隆本仓库自动施补丁）。
**装后必验**（构建会压缩 JS，marker 不能带空格）：

```sh
grep -c "ownedPid=res.pid" /www/luci-static/resources/view/ttyd/term.js  # 应为 1
grep -c disableReconnect  /usr/libexec/rpcd/ttyd-strict                  # 应 ≥1
```

## 测试

```sh
bash tests/sandbox-test.sh   # 插件全分支 45 断言（伪造 /proc/netstat，无需设备）
```

改动插件或 term.js 后必跑；真机 E2E 记录见
[`tests/E2E-NOTES.md`](tests/E2E-NOTES.md)。

## 已知边界

- 等待回车期间监听器在监听（`-m 1` 语义）：等待窗口内"第一个
  连上的人"拿到唯一名额；页面关闭即关闭入口。详见 DESIGN.md §6。
- 24.10 树理论兼容（jshn 依赖已核实）但未上机验证。
- 部署新版本后，**已打开的页面仍运行旧内存 JS**——需刷新一次。
