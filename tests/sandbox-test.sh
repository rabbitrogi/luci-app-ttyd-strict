#!/bin/bash
# sandbox-test.sh - run the ttyd-strict rpcd plugin through every branch
# without an OpenWrt device (macOS/Linux host).
#
# Simulates: /proc (net/tcp, uptime, pid dirs), netstat, logger,
# start-stop-daemon, kill — then asserts the plugin's status/start/
# takeover/stop decisions and their log output.
#
# Usage: bash tests/sandbox-test.sh [path-to-plugin]
#   (default: root/usr/libexec/rpcd/ttyd-strict next to this repo)
set -u

TESTDIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$TESTDIR/../root/usr/libexec/rpcd/ttyd-strict}"
SB=/tmp/ttyd-strict-sandbox
PORT_HEX=1E01   # 7681
PASS=0; FAIL=0

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); say "  PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); say "  FAIL: $1"; }

[ -f "$SRC" ] || { say "missing plugin: $SRC"; exit 1; }

# ---------- build sandbox ----------
rm -rf "$SB"; mkdir -p "$SB"/{bin,run,lock}

# 沙盒专用 jshn stub：语义等价于真机 jshn.sh 中本插件用到的输出函数
# （json_init/add_string/add_int/add_array/add_object/close_*/dump）。
# 真机上插件 source 的仍是系统 /usr/share/libubox/jshn.sh。
cat > "$SB/jshn-stub.sh" <<'EOF'
_jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
json_init() { J_OUT=""; J_NEEDSEP=0; }
_jsep() { [ "$J_NEEDSEP" = 1 ] && J_OUT="$J_OUT,"; J_NEEDSEP=0; return 0; }
json_add_string() { _jsep; J_OUT="$J_OUT\"$1\":\"$(_jesc "$2")\""; J_NEEDSEP=1; }
json_add_int() { _jsep; J_OUT="$J_OUT\"$1\":$2"; J_NEEDSEP=1; }
json_add_array() { _jsep; J_OUT="$J_OUT\"$1\":["; J_NEEDSEP=0; }
json_add_object() { _jsep; J_OUT="$J_OUT{"; J_NEEDSEP=0; }
json_close_object() { J_OUT="${J_OUT%,}}"; J_NEEDSEP=1; }
json_close_array() { J_OUT="${J_OUT%,}]"; J_NEEDSEP=1; }
json_dump() { printf '{%s}\n' "$J_OUT"; }
JSON_IN=""
json_load() { JSON_IN="$1"; }
json_get_var() {
	local __var="$1" __key="$2" __val
	__val=$(printf '%s' "$JSON_IN" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    v = d.get('$__key', '')
    print('' if v is None else v)
except Exception:
    pass" 2>/dev/null)
	eval "$__var=\$__val"
	return 0
}
EOF

# kill is a shell builtin and would never hit the fake in PATH; the
# sandboxed copy renames call sites so they resolve to sbed_kill
cat > "$SB/bin/sbed_kill" <<EOF
#!/bin/bash
pid="\${@: -1}"
if [ -d "$SB/proc/\$pid" ]; then
    rm -rf "$SB/proc/\$pid"
    awk '\$4 != "0A"' "$SB/proc/net/tcp" > "$SB/proc/net.tcp.new" && mv "$SB/proc/net.tcp.new" "$SB/proc/net/tcp"
    exit 0
fi
/bin/kill "\$@"
EOF
chmod +x "$SB/bin/sbed_kill"

# plugin copy with absolute paths redirected into the sandbox
sed -e 's/kill "\$/sbed_kill "\$/g' -e 's/kill -9 "\$/sbed_kill -9 "\$/g' \
    -e "s#/usr/share/libubox/jshn.sh#$SB/jshn-stub.sh#" \
    -e "s#/lib/functions.sh#$SB/functions.sh#" \
    -e "s#/lib/functions/network.sh#$SB/network.sh#" \
    -e "s#/var/run/ttyd-strict.pid#$SB/run/pid#" \
    -e "s#/var/run/ttyd-strict.watchdog#$SB/run/ttyd-strict.watchdog#" \
    -e "s#/var/lock/ttyd-strict-ctl#$SB/lock/ctl#" \
    -e "s#/usr/bin/ttyd#$SB/bin/ttyd#" \
    -e "s#/proc#$SB/proc#g" \
    "$SRC" > "$SB/plugin"
chmod +x "$SB/plugin"

# stubs
cat > "$SB/functions.sh" <<'EOF'
config_load() { :; }
config_get() { eval "$1=\${4:-}"; }
EOF
cat > "$SB/network.sh" <<'EOF'
network_get_device() { eval "$1=br-lan"; return 0; }
EOF

cat > "$SB/bin/logger" <<EOF
#!/bin/bash
echo "\$*" >> "$SB/logger.log"
EOF
chmod +x "$SB/bin/logger"

cat > "$SB/bin/netstat" <<EOF
#!/bin/bash
cat "$SB/netstat.out" 2>/dev/null
EOF
chmod +x "$SB/bin/netstat"

cat > "$SB/bin/uci" <<'UCIEOF'
#!/bin/sh
# fake uci: no config present, plugin falls back to defaults
exit 1
UCIEOF
chmod +x "$SB/bin/uci"

cat > "$SB/bin/kill" <<EOF
#!/bin/bash
pid="\${@: -1}"
if [ -d "$SB/proc/\$pid" ]; then
    rm -rf "$SB/proc/\$pid"
    awk '\$4 != "0A"' "$SB/proc/net/tcp" > "$SB/proc/net.tcp.new" && mv "$SB/proc/net.tcp.new" "$SB/proc/net/tcp"
    exit 0
fi
/bin/kill "\$@"
EOF
chmod +x "$SB/bin/kill"

cat > "$SB/bin/ttyd" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$SB/bin/ttyd"

# fake start-stop-daemon: parses -p pidfile, spawns a simulated ttyd
cat > "$SB/bin/start-stop-daemon" <<EOF
#!/bin/bash
pidfile=""; mode=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        -p) pidfile="\$2"; shift 2 ;;
        -S|-b|-m|-x) shift; [ "\$1" = "\$SB/bin/ttyd" ] && shift; [ "\$1" = "--" ] || true ;;
        --) shift; break ;;
        *) shift ;;
    esac
done
newpid=\$((RANDOM % 9000 + 1000))
inode=\$((90000 + RANDOM % 9999))
mkdir -p "$SB/proc/\$newpid/fd"
echo ttyd > "$SB/proc/\$newpid/comm"
printf '1234 (ttyd) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22\n' > "$SB/proc/\$newpid/stat"
ln -s "socket:[\$inode]" "$SB/proc/\$newpid/fd/3"
printf '  0: 0100007F:%s 00000000:0000 0A 00000000:00000000 00000000:0000 00000000 0 0 %s 1 0000000000000000 1\n' "$PORT_HEX" "\$inode" > "$SB/proc/net/tcp"
echo "\$newpid" > "\$pidfile"
exit 0
EOF
chmod +x "$SB/bin/start-stop-daemon"

export PATH="$SB/bin:$PATH"
export WATCHDOG_SECS=2

# ---------- world helpers ----------

reset_world() {
    rm -rf "$SB/proc"; mkdir -p "$SB/proc/net"
    echo "99999999.00 0.00" > "$SB/proc/uptime"    # ancient boot: instances created via make_proc count as old (grace does not apply)
    : > "$SB/proc/net/tcp"
    [ -f "$SB/run/ttyd-strict.watchdog" ] && kill "$(cat "$SB/run/ttyd-strict.watchdog" 2>/dev/null)" 2>/dev/null
    rm -f "$SB/run/pid" "$SB/run/ttyd-strict.watchdog"
    : > "$SB/logger.log"
    : > "$SB/netstat.out"
}

# simulate a ttyd-ish process: make_proc PID COMM INODE [client...]
make_proc() {
    local pid="$1" comm="$2" inode="$3"; shift 3
    mkdir -p "$SB/proc/$pid/fd"
    echo "$comm" > "$SB/proc/$pid/comm"
    printf '%s (%s) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22\n' "$pid" "$comm" > "$SB/proc/$pid/stat"
    ln -s "socket:[$inode]" "$SB/proc/$pid/fd/3"
    printf '  0: 0100007F:%s 00000000:0000 0A 00000000:00000000 00000000:0000 00000000 0 0 %s 1 0000000000000000 1\n' "$PORT_HEX" "$inode" >> "$SB/proc/net/tcp"
    # clients (remote ip:port established on our port)
    : > "$SB/netstat.out"
    local c
    for c in "$@"; do
        echo "tcp 0 0 192.168.1.1:7681 $c ESTABLISHED" >> "$SB/netstat.out"
    done
}

# plugin invocation: run METHOD [stdin-json]
plug() { sh "$SB/plugin" call "$1"; }
plug_list() { sh "$SB/plugin" list; }

# JSON field extractor (python3): get FIELD from JSON on stdin
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('$1'); print(v if not isinstance(v,(dict,list)) else json.dumps(v))"; }

say "== T1: list 输出 4 个方法 =="
out=$(plug_list)
echo "$out" | python3 -m json.tool >/dev/null 2>&1 && ok "list 是合法 JSON" || bad "list JSON 非法: $out"
n=$(echo "$out" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
[ "$n" = 4 ] && ok "4 个方法" || bad "方法数=$n"

say "== T2: status - 空世界 =="
reset_world
out=$(plug session_status)
[ "$(echo "$out" | jget state)" = "none" ] && ok "state=none" || bad "state=$(echo "$out" | jget state)"
[ "$(echo "$out" | jget port)" = 7681 ] && ok "port=7681" || bad "port 错"

say "== T3: status - 我们的实例 + 1 个客户端 =="
reset_world
make_proc 4242 ttyd 9999 192.168.1.100:54321
echo 4242 > "$SB/run/pid"
out=$(plug session_status)
[ "$(echo "$out" | jget state)" = "ours" ] && ok "state=ours" || bad "state=$(echo "$out" | jget state)"
[ "$(echo "$out" | jget pid)" = 4242 ] && ok "pid=4242" || bad "pid 错"
[ "$(echo "$out" | jget client_count)" = 1 ] && ok "client_count=1" || bad "count=$(echo "$out" | jget client_count)"
ip=$(echo "$out" | python3 -c "import json,sys; print(json.load(sys.stdin)['clients'][0]['ip'])")
[ "$ip" = "192.168.1.100" ] && ok "client ip 正确" || bad "client ip=$ip"
st=$(echo "$out" | jget started); [ -n "$st" ] && [ "$st" -gt 0 ] && ok "started epoch=$st" || bad "started=$st"

say "== T4: status - 外来 ttyd（无 pidfile） =="
reset_world
make_proc 5566 ttyd 7777 192.168.1.200:40000
out=$(plug session_status)
[ "$(echo "$out" | jget state)" = "foreign-ttyd" ] && ok "state=foreign-ttyd" || bad "state=$(echo "$out" | jget state)"

say "== T5: status - 非 ttyd 进程占端口 =="
reset_world
make_proc 5566 nginx 7777
out=$(plug session_status)
[ "$(echo "$out" | jget state)" = "foreign-other" ] && ok "state=foreign-other" || bad "state=$(echo "$out" | jget state)"
[ "$(echo "$out" | jget comm)" = "nginx" ] && ok "comm=nginx" || bad "comm 错"

say "== T6: start - 空世界 → 启动 =="
reset_world
out=$(plug session_start)
[ "$(echo "$out" | jget result)" = "started" ] && ok "result=started" || bad "result=$(echo "$out" | jget result)"
grep -q "session started" "$SB/logger.log" && ok "有启动日志" || bad "无启动日志"

say "== T7: start - 我们的实例 + 有客户端 → busy（不杀） =="
reset_world
make_proc 4242 ttyd 9999 192.168.1.100:54321
echo 4242 > "$SB/run/pid"
out=$(plug session_start)
[ "$(echo "$out" | jget result)" = "None" ] && ok "无 result 字段（busy 载荷）" || bad "result=$(echo "$out" | jget result)"
[ "$(echo "$out" | jget state)" = "ours" ] && ok "busy 载荷带 state=ours" || bad "state 错"
[ -d "$SB/proc/4242" ] && ok "4242 未被杀" || bad "4242 被误杀"
grep -q "busy" "$SB/logger.log" && ok "有 busy 日志" || bad "无 busy 日志"

say "== T8: start - 我们的实例 + 无客户端 → 附着（-m 1 监听器等回车） =="
reset_world
make_proc 4242 ttyd 9999
echo 4242 > "$SB/run/pid"
out=$(plug session_start)
[ "$(echo "$out" | jget state)" = "ours" ] && ok "返回 ours 状态（可附着）" || bad "state=$(echo "$out" | jget state)"
[ "$(echo "$out" | jget result)" = "None" ] && ok "无 result（不重启）" || bad "result=$(echo "$out" | jget result)"
[ -d "$SB/proc/4242" ] && ok "实例存活（监听器保留）" || bad "实例被误杀"

say "== T8b: start - 外来 ttyd + 无客户端 → 同样自动清理 =="
reset_world
make_proc 5566 ttyd 7777
out=$(plug session_start)
[ "$(echo "$out" | jget result)" = "started" ] && ok "result=started" || bad "result=$(echo "$out" | jget result)"
[ ! -d "$SB/proc/5566" ] && ok "外来 clientless ttyd 被清理" || bad "外来实例仍在"
grep -q "foreign" "$SB/logger.log" && ok "日志标注 state" || bad "日志缺 state"

say "== T9: takeover - 外来 ttyd + 有客户端 → 杀掉重启 =="
reset_world
make_proc 5566 ttyd 7777 192.168.1.100:54321
out=$(plug session_takeover)
[ "$(echo "$out" | jget result)" = "started" ] && ok "result=started" || bad "result=$(echo "$out" | jget result)"
[ ! -d "$SB/proc/5566" ] && ok "5566 被杀" || bad "5566 未被杀"
grep -q "takeover" "$SB/logger.log" && ok "有 takeover 日志" || bad "无 takeover 日志"

say "== T10: takeover - 非 ttyd 占用 → 拒绝 =="
reset_world
make_proc 5566 nginx 7777
out=$(plug session_takeover)
[ -d "$SB/proc/5566" ] && ok "nginx 未被杀" || bad "nginx 被误杀"
[ "$(echo "$out" | jget state)" = "foreign-other" ] && ok "返回占用状态" || bad "返回错误"
grep -q "refused" "$SB/logger.log" && ok "有拒绝日志" || bad "无拒绝日志"

say "== T11: stop - 我们的实例 =="
reset_world
make_proc 4242 ttyd 9999 192.168.1.100:54321
echo 4242 > "$SB/run/pid"
out=$(plug session_stop)
[ "$(echo "$out" | jget result)" = "stopped" ] && ok "result=stopped" || bad "result 错"
[ ! -d "$SB/proc/4242" ] && ok "实例已停止" || bad "实例仍在"
grep -q "stopped by request" "$SB/logger.log" && ok "有停止日志" || bad "无停止日志"

say "== T11b: stop - 外来实例不动 =="
reset_world
make_proc 5566 ttyd 7777 192.168.1.100:54321
out=$(plug session_stop)
[ -d "$SB/proc/5566" ] && ok "外来实例未被杀" || bad "外来实例被误杀"
grep -q "not touching" "$SB/logger.log" && ok "有 not-touching 日志" || bad "无日志"

say "== T12: 孤儿回收（pidfile 活着但端口没了） =="
reset_world
make_proc 4242 ttyd 9999
echo 4242 > "$SB/run/pid"
# 端口被释放但进程目录还在（模拟 ttyd --once 已退出、pidfile 残留）
awk '$4 != "0A"' "$SB/proc/net/tcp" > "$SB/proc/x" && mv "$SB/proc/x" "$SB/proc/net/tcp"
out=$(plug session_status)
[ "$(echo "$out" | jget state)" = "none" ] && ok "state=none" || bad "state=$(echo "$out" | jget state)"
grep -q "orphan" "$SB/logger.log" && ok "有孤儿回收日志" || bad "无孤儿日志"

say "== T14: session_stop 的 pid 认领（陈旧 beacon 不误杀） =="
reset_world
make_proc 4242 ttyd 9999 192.168.1.100:54321
echo 4242 > "$SB/run/pid"
out=$(echo '{"pid": 999999}' | sh "$SB/plugin" call session_stop)
[ -d "$SB/proc/4242" ] && ok "pid 不符 → 实例存活" || bad "被陈旧 stop 误杀"
grep -q "stale beacon" "$SB/logger.log" && ok "有 stale beacon 日志" || bad "无日志"
out=$(echo '{"pid": 4242}' | sh "$SB/plugin" call session_stop)
[ ! -d "$SB/proc/4242" ] && ok "pid 匹配 → 实例停止" || bad "实例仍在"

say "== T15: 看门狗——无页面续命时收掉孤儿监听器 =="
reset_world
out=$(plug session_start)
[ "$(echo "$out" | jget result)" = "started" ] && ok "会话已启动" || bad "启动失败"
sleep 4   # WATCHDOG_SECS=2，无人续命
out=$(plug session_status)
[ "$(echo "$out" | jget state)" = "none" ] && ok "孤儿被看门狗回收（none）" || bad "state=$(echo "$out" | jget state)"
grep -q "watchdog: reaping" "$SB/logger.log" && ok "有看门狗日志" || bad "无看门狗日志"

say ""
say "========== 结果: PASS=$PASS FAIL=$FAIL =========="
[ "$FAIL" = 0 ]
