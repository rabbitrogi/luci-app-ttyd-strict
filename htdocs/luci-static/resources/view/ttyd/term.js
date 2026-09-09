'use strict';
'require view';
'require uci';
'require rpc';
'require poll';
'require ui';

/*
 * luci-app-ttyd (strict fork) — terminal view.
 *
 * Upstream behaviour (uci 'ttyd', port/ssl/url_override handling) is
 * kept; the iframe is no longer static: the ttyd instance is started
 * ON DEMAND through the "ttyd-strict" rpcd plugin, runs with --once
 * (exactly one websocket client — this page), and exits when the page
 * closes. A busy session (live client elsewhere) is never killed
 * silently: a modal shows who is connected and the user decides.
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
	},

	setStatus: function(text, kind) {
		this.statusEl.className = 'alert-message ' + (kind || 'info');
		this.statusEl.textContent = text;
		this.statusEl.style.display = text ? '' : 'none';
		this.fitTerminal();
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

	/* --- session actions --------------------------------------------- */

	handleStart: function(ev) {
		var self = this;

		ev && ev.preventDefault();
		this.userStopped = false;

		return callSessionStart().then(function(res) {
			self.handleStartReply(res);
		}).catch(function() {
			self.setStatus(_('RPC call failed - is the ttyd-strict rpcd plugin installed?'), 'error');
		});
	},

	handleStartReply: function(res) {
		if (res && res.result == 'started') {
			ui.hideModal();
			this.mountTerminal();
			this.setStatus('', 'info');
			return;
		}
		if (res && res.result) {
			this.setStatus(_('Unable to start session: %s').format(res.result), 'error');
			return;
		}
		if (res && (res.state == 'ours' || res.state == 'foreign-ttyd'))
			this.showBusyModal(res);
		else if (res && res.state == 'foreign-other')
			this.showOccupiedUnknown(res);
	},

	handleTakeover: function(ev) {
		var self = this;

		ev && ev.preventDefault();

		return callSessionTakeover().then(function(res) {
			ui.hideModal();
			if (res && res.result == 'started') {
				self.mountTerminal();
				self.setStatus(_('Previous session terminated - new session started.'), 'info');
			}
			else if (res && res.state == 'foreign-other') {
				self.showOccupiedUnknown(res);
			}
			else {
				self.setStatus(_('Takeover failed: %s')
					.format((res && res.result) || _('unknown')), 'error');
			}
		}).catch(function() {
			ui.hideModal();
			self.setStatus(_('RPC call failed - is the ttyd-strict rpcd plugin installed?'), 'error');
		});
	},

	handleStop: function(ev) {
		var self = this;

		ev && ev.preventDefault();
		this.userStopped = true;

		return callSessionStop().then(function() {
			self.termHost.innerHTML = '';
			self.termHost.appendChild(E('em', {}, [ _('no active session') ]));
			self.sessionActive = false;
			self.setStatus(_('Session stopped. Use "Reconnect" to start a new one.'), 'info');
		}).catch(function() {
			self.setStatus(_('RPC call failed - is the ttyd-strict rpcd plugin installed?'), 'error');
		});
	},

	/* --- dialogs ------------------------------------------------------ */

	showBusyModal: function(s) {
		var self = this;

		this.setStatus(_('Port busy - a ttyd session with a live client exists.'), 'warning');

		ui.showModal(_('ttyd session busy'), [
			E('p', {}, _('The terminal port %d is occupied by ttyd (%s).')
				.format(s.port, this.describeStatus(s))),
			E('p', {}, _('This has been logged. Terminating it will disconnect the client listed above - do you want to take over the session?')),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					click: function(ev) {
						ev.preventDefault();
						ui.hideModal();
					}
				}, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn important',
					click: this.handleTakeover.bind(this)
				}, [ _('Take over and restart') ])
			])
		]);
	},

	showOccupiedUnknown: function(s) {
		this.termHost.innerHTML = '';
		this.termHost.appendChild(E('em', {}, [ _('no active session') ]));
		this.setStatus(_('Port %d is held by a non-ttyd process (%s, pid %d) - refusing to touch it. Resolve it manually, then reconnect.')
			.format(s.port, s.comm || _('unknown'), s.pid || 0), 'error');
	},

	/* --- background poll --------------------------------------------- */

	pollStatus: function() {
		var self = this;

		return callSessionStatus().then(function(s) {
			if (!s || !s.state)
				return;

			if (s.state == 'ours') {
				self.setStatus(s.client_count > 0
					? _('Session active (%s)').format(self.describeStatus(s))
					: _('Session running, waiting for the terminal to connect...'), 'info');
				return;
			}

			if (s.state == 'none') {
				var now = Date.now();
				if (!self.userStopped && !self.pollBusy &&
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

			self.setStatus(_('Port %d occupied: %s - use "Reconnect" to decide.')
				.format(s.port, self.describeStatus(s)), 'warning');
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
			E('div', { 'class': 'right', 'style': 'margin-bottom:.5em' }, [
				E('button', {
					'class': 'btn cbi-button',
					click: this.handleStart.bind(this)
				}, [ _('Reconnect') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button neutral',
					click: this.handleStop.bind(this)
				}, [ _('Stop session') ])
			]),
			this.statusEl,
			this.termHost
		]);

		this.termHost.appendChild(E('em', {}, [ _('starting session...') ]));

		window.addEventListener('resize', this.fitTerminal.bind(this));
		requestAnimationFrame(this.fitTerminal.bind(this));

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

		poll.add(this.pollStatus.bind(this), 10);

		if (!initial)
			this.setStatus(_('Status probe failed - is the ttyd-strict rpcd plugin installed?'), 'error');
		else if (initial.state == 'foreign-other')
			this.showOccupiedUnknown(initial);
		else
			this.handleStart();

		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
