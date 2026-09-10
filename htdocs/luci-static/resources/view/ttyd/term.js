'use strict';
'require view';
'require uci';
'require rpc';
'require ui';

/*
 * luci-app-ttyd (strict fork) — terminal view.
 *
 * Fully automatic lifecycle, no manual controls:
 *   - opening the page starts the on-demand ttyd (via the ttyd-strict
 *     rpcd plugin, single client --once); a leftover session (stale tab)
 *     is reaped/taken over automatically - the syslog audit trail on
 *     the device records every takeover;
 *   - leaving the page ends the session: the websocket dies with the
 *     document and a pagehide beacon stops the instance as backstop.
 */

var callSessionStatus = rpc.declare({
	object: 'ttyd-strict', method: 'session_status'
});
var callSessionStart = rpc.declare({
	object: 'ttyd-strict', method: 'session_start'
});
var callSessionTakeover = rpc.declare({
	object: 'ttyd-strict', method: 'session_takeover'
});
var callSessionStop = rpc.declare({
	object: 'ttyd-strict', method: 'session_stop'
});

var RESTART_INTERVAL = 15;   /* min seconds between automatic restarts */

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('ttyd'),
			callSessionStatus().catch(function() { return null; })
		]).then(function(r) { return r[1]; });
	},

	terminalUrl: function() {
		var port = uci.get_first('ttyd', 'ttyd', 'port') || '7681',
		    ssl = uci.get_first('ttyd', 'ttyd', 'ssl') || '0',
		    url = uci.get_first('ttyd', 'ttyd', 'url_override');
		return url || ((ssl === '1' ? 'https' : 'http') + '://' + window.location.hostname + ':' + port);
	},

	/* --- terminal sizing (fills the viewport below the iframe) ----- */

	fitTerminal: function() {
		var top = this.termHost.getBoundingClientRect().top,
		    h = window.innerHeight - top - 12;

		if (h > 240)
			this.termHost.style.height = h + 'px';

		/* second pass: absorb whatever still overflows the viewport
		 * (theme footer below the view etc.) so the whole page fits
		 * and no browser scrollbar appears - works in any theme */
		var overflow = document.documentElement.scrollHeight - window.innerHeight;
		if (overflow > 0 && h - overflow - 2 > 240)
			this.termHost.style.height = (h - overflow - 2) + 'px';
	},

	setStatus: function(text, kind) {
		this.statusEl.className = 'alert-message ' + (kind || 'info');
		this.statusEl.textContent = text;
		this.statusEl.style.display = text ? '' : 'none';
		this.fitTerminal();
	},

	placeholder: function(text) {
		this.termHost.innerHTML = '';
		this.termHost.appendChild(E('em', {}, [ text ]));
	},

	mountTerminal: function() {
		this.termHost.innerHTML = '';
		this.termHost.appendChild(E('iframe', {
			src: this.terminalUrl(),
			style: 'width: 100%; height: 100%; border: none; border-radius: 3px;'
		}));
		this.sessionActive = true;
		this.fitTerminal();
	},

	/* Fire-and-forget session_stop for the unload path: the websocket
	 * dying with the page already ends the --once session; this beacon
	 * is the belt-and-suspenders for cases where the page is parked
	 * (bfcache, soft navigation) instead of destroyed. */
	stopSessionOnLeave: function() {
		try {
			navigator.sendBeacon(L.url('admin/ubus'), new Blob([JSON.stringify({
				jsonrpc: '2.0', id: 99, method: 'call',
				params: [L.env.sessionid, 'ttyd-strict', 'session_stop', {}]
			})], { type: 'application/json' }));
		}
		catch (e) {}
	},

	describeStatus: function(s) {
		var since = s.started
			? new Date(s.started * 1000).toLocaleTimeString() : _('unknown time');
		var clients = (s.clients || []).map(function(c) {
			return c.ip + ':' + c.port;
		}).join(', ') || _('none');
		return _('pid %d, started %s, clients: %s')
			.format(s.pid || 0, since, clients);
	},

	/* --- automatic session management ------------------------------- */

	/* ensure a session for THIS page: start it, or take over whatever
	 * ttyd holds the port (a stale tab of ours in the common case; the
	 * takeover is recorded in the device syslog) */
	ensureSession: function() {
		var self = this;

		return callSessionStart().then(function(res) {
			if (res && res.result == 'started') {
				self.mountTerminal();
				self.setStatus('', 'info');
			}
			else if (res && !res.result &&
			    (res.state == 'ours' || res.state == 'foreign-ttyd')) {
				/* live client somewhere else: take over without asking -
				 * being on this page IS the decision */
				self.placeholder(_('restarting session...'));
				self.setStatus(_('Previous session (%s) is being taken over - this has been logged.')
					.format(self.describeStatus(res)), 'info');
				return callSessionTakeover().then(function(r2) {
					if (r2 && r2.result == 'started') {
						self.mountTerminal();
						self.setStatus('', 'info');
					}
					else if (r2 && r2.state == 'foreign-other') {
						self.showOccupiedUnknown(r2);
					}
					else {
						self.placeholder(_('no active session'));
						self.setStatus(_('Unable to start session: %s')
							.format((r2 && r2.result) || _('unknown')), 'error');
					}
				});
			}
			else if (res && res.state == 'foreign-other') {
				self.showOccupiedUnknown(res);
			}
			else {
				self.placeholder(_('no active session'));
				self.setStatus(_('Unable to start session: %s')
					.format((res && res.result) || _('unknown')), 'error');
			}
		}).catch(function() {
			self.setStatus(_('RPC call failed - is the ttyd-strict rpcd plugin installed?'), 'error');
		});
	},

	showOccupiedUnknown: function(s) {
		this.placeholder(_('no active session'));
		this.setStatus(_('Port %d is held by a non-ttyd process (%s, pid %d) - refusing to touch it. Resolve it manually, then reopen this page.')
			.format(s.port, s.comm || _('unknown'), s.pid || 0), 'error');
	},

	/* --- background poll --------------------------------------------- */

	pollStatus: function() {
		var self = this;

		return callSessionStatus().then(function(s) {
			if (!s || !s.state)
				return;

			if (s.state == 'ours') {
				if (s.client_count > 0) {
					self.zeroClientSince = null;
					self.setStatus(_('Session active (%s)').format(self.describeStatus(s)), 'info');
				}
				else {
					/* session alive but nothing connected: if the iframe
					 * shows an error page (race during takeover/restart),
					 * remount it once after a grace period */
					if (!self.zeroClientSince)
						self.zeroClientSince = Date.now();
					else if (Date.now() - self.zeroClientSince > 15000) {
						self.zeroClientSince = null;
						self.mountTerminal();
					}
					self.setStatus(_('Session running, waiting for the terminal to connect...'), 'info');
				}
				return;
			}

			if (s.state == 'none') {
				var now = Date.now();
				if (!self.pollBusy &&
				    (!self.lastAutoStart || (now - self.lastAutoStart) / 1000 > RESTART_INTERVAL)) {
					self.lastAutoStart = now;
					self.pollBusy = true;
					callSessionStart().then(function(res) {
						if (res && res.result == 'started')
							self.mountTerminal();
						else if (res && !res.result && res.state == 'foreign-other')
							self.showOccupiedUnknown(res);
					}).catch(L.noop).finally(function() {
						self.pollBusy = false;
					});
				}
				return;
			}

			/* foreign-ttyd with a live client appeared after load:
			 * re-run the automatic takeover path */
			self.ensureSession();
		}).catch(L.noop);
	},

	/* --- view ---------------------------------------------------------- */

	render: function(initial) {
		var self = this;
		var port = uci.get_first('ttyd', 'ttyd', 'port') || '7681';

		if (port === '0')
			return E('div', { class: 'alert-message warning' },
				_('Random ttyd port (port=0) is not supported.<br />Change to a fixed port and try again.'));

		this.statusEl = E('div', { 'class': 'alert-message info', 'style': 'display:none' });
		this.termHost = E('div', { 'class': 'cbi-section', 'style': 'height: 60vh' });

		var view = E('div', {}, [
			this.statusEl,
			this.termHost
		]);

		this.placeholder(_('starting session...'));

		window.addEventListener('resize', this.fitTerminal.bind(this));
		requestAnimationFrame(this.fitTerminal.bind(this));

		/* the framework assembles parts of the layout asynchronously
		 * (tab bar, indicators) AFTER the view renders - recompute the
		 * fit whenever the content area mutates so latecomer rows are
		 * always absorbed and the page never grows a scrollbar */
		var mo = new MutationObserver(this.fitTerminal.bind(this));
		mo.observe(document.getElementById('maincontent') || document.body,
			{ childList: true, subtree: true });

		/* No beforeunload confirmation here on purpose: embedded
		 * browsers (Electron webviews etc.) do not surface the unload
		 * dialog and silently CANCEL the navigation instead - the user
		 * gets stuck on the page while it holds the single client slot.
		 * Letting the page go is safe: the websocket dies with it and
		 * the pagehide beacon below stops the session even if the page
		 * is parked (bfcache) rather than destroyed. */
		window.addEventListener('pagehide', function() {
			if (self.sessionActive)
				self.stopSessionOnLeave();
		});

		/* plain interval instead of LuCI's poll framework: poll.add()
		 * makes the theme render a refresh control in the tab bar which
		 * upstream does not have (and which appears AFTER our height
		 * measurement, breaking the viewport fit) */
		setInterval(this.pollStatus.bind(this), 10000);

		if (!initial)
			this.setStatus(_('Status probe failed - is the ttyd-strict rpcd plugin installed?'), 'error');
		else
			this.ensureSession();

		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
