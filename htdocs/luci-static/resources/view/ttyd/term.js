'use strict';
'require view';
'require uci';
'require rpc';

/*
 * luci-app-ttyd (strict fork) — terminal view.
 *
 * Upstream renders a static iframe; this fork adds a fully automatic
 * session lifecycle around it (no manual controls, no status UI):
 * Session ownership follows FOCUS: the one focused, visible page owns
 * the terminal. A page that lost focus (window switch) or is hidden
 * (background tab - throttled polls used to hijack the foreground
 * session) stays dormant; regaining focus triggers a poll that
 * reclaims the session if someone else took it meanwhile.
 *
 *   - opening the page starts the on-demand ttyd via the "ttyd-strict"
 *     rpcd plugin; a leftover session from a stale tab is reaped or
 *     taken over automatically - the syslog on the device records
 *     every takeover;
 *   - the listener runs with --once: typing exit closes the websocket
 *     and ttyd exits immediately (nothing to maintain). The focused
 *     page's poll notices the dead listener and silently starts a NEW
 *     one, leaving the frontend's own "Press Enter to Reconnect"
 *     prompt untouched - the user's Enter reconnects to the fresh
 *     listener. Reconnection is always user-driven, never automatic;
 *   - leaving the page closes the websocket, which ends the --once
 *     instance by itself; a restored listener nobody watches anymore
 *     is reaped by the plugin-side heartbeat (no page polls = stale);
 *   - the iframe fills the viewport below it, absorbing whatever the
 *     theme places above/below so the page never gets a scrollbar.
 * The only extra UI is an error banner for conditions the user must
 * resolve (port held by a non-ttyd process, RPC/plugin failure).
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

var POLL_INTERVAL = 10;      /* ownership cadence for the focused page
                              * (reclaim after focus switches); the exit
                              * and Enter-reconnect flow needs no polling */

return view.extend({
	load: function() {
		return uci.load('ttyd');
	},

	terminalUrl: function() {
		var port = uci.get_first('ttyd', 'ttyd', 'port') || '7681',
		    ssl = uci.get_first('ttyd', 'ttyd', 'ssl') || '0',
		    url = uci.get_first('ttyd', 'ttyd', 'url_override');
		return url || ((ssl === '1' ? 'https' : 'http') + '://' + window.location.hostname + ':' + port);
	},

	/* --- viewport fit ------------------------------------------------ */

	/* how far in-flow content (plus the footer, when the theme shows
	 * one) physically extends below the viewport. Measuring
	 * documentElement.scrollHeight is NOT enough: themes may scroll in
	 * an inner container (argon scrolls #maincontent) or drop the
	 * footer on narrow layouts (mobile-hide), so we walk the real
	 * boxes instead. Floating elements (position:absolute/fixed,
	 * tooltips) are skipped so they cannot over-shrink the terminal. */
	measureBelowFold: function() {
		var maxBottom = 0,
		    scope = document.querySelector('#maincontent') || document.body;

		var scan = function(e) {
			var b = e.getBoundingClientRect().bottom;
			if (b > maxBottom) {
				var p = getComputedStyle(e).position;
				if (p != 'absolute' && p != 'fixed')
					maxBottom = b;
			}
		};

		scope.querySelectorAll('*').forEach(scan);
		scan(scope);
		[document.querySelector('footer'), document.body].forEach(function(e) {
			if (e) scan(e);
		});

		return maxBottom - window.innerHeight;
	},

	fitTerminal: function() {
		var top = this.termHost.getBoundingClientRect().top,
		    h = window.innerHeight - top - 12,
		    cur = parseFloat(this.termHost.style.height) || 0;

		/* ignore negligible changes: re-applying a height that differs
		 * by a pixel or two still resizes the iframe, and ttyd echoes
		 * the xterm resize in the terminal */
		if (h > 240 && Math.abs(h - cur) > 4)
			this.termHost.style.height = h + 'px';

		/* iteratively absorb the below-fold overflow: shrink, re-measure,
		 * repeat. One pass is not always exact (container paddings and
		 * responsive layout changes such as the footer being dropped on
		 * narrow screens make the reflow non-1:1); stop when nothing
		 * improves or the terminal would get too small. */
		var prev = null;

		for (var pass = 0; pass < 3; pass++) {
			var overflow = this.measureBelowFold();
			if (overflow <= 2 || (prev !== null && overflow >= prev))
				break;

			prev = overflow;

			var newH = this.termHost.getBoundingClientRect().height - overflow - 2;

			if (newH <= 240)
				break;

			this.termHost.style.height = newH + 'px';
		}
	},

	/* --- session lifecycle -------------------------------------------- */

	mountTerminal: function(ownedPid) {
		if (typeof(ownedPid) != 'undefined')
			this.ownedPid = ownedPid;
		this.mounted = true;
		this.termHost.innerHTML = '';
		this.termHost.appendChild(E('iframe', {
			src: this.terminalUrl(),
			style: 'width: 100%; height: 100%; border: none; border-radius: 3px;'
		}));
		this.fitTerminal();
	},

	showError: function(text) {
		this.statusEl.textContent = text;
		this.statusEl.style.display = '';
	},

	/* ensure a session for THIS page: start it, or take over whatever
	 * ttyd holds the port (a stale tab of ours in the common case; the
	 * takeover is recorded in the device syslog) */
	ensureSession: function() {
		var self = this;

		/* record our intent: keeps the poll's auto-restart from firing
		 * a second session_start in parallel (the double-start race
		 * that used to kill a freshly started instance before its
		 * iframe connected, leaving a dead "reconnect" screen) */
		this.lastAutoStart = Date.now();

		return callSessionStart().then(function(res) {
			if (res && res.result == 'started')
				self.mountTerminal(res.pid);
			else if (res && !res.result && res.state == 'ours' &&
			    res.client_count == 0)
				/* freshly started instance waiting for its client -
				 * attach to it instead of taking it over */
				self.mountTerminal(res.pid);
			else if (res && !res.result &&
			    (res.state == 'ours' || res.state == 'foreign-ttyd'))
				/* live client somewhere else: take over without asking -
				 * being on this page IS the decision (visible pages
				 * only - ensureSession is never called while hidden) */
				return callSessionTakeover().then(function(r2) {
					if (r2 && r2.result == 'started')
						self.mountTerminal(r2.pid);
					else if (r2 && r2.state == 'foreign-other')
						self.showError(_('Port %d is held by a non-ttyd process - resolve it manually, then reopen this page.')
							.format(r2.port));
					else
						self.showError(_('Unable to start session: %s')
							.format((r2 && r2.result) || _('unknown')));
				});
			else if (res && res.state == 'foreign-other')
				self.showError(_('Port %d is held by a non-ttyd process - resolve it manually, then reopen this page.')
					.format(res.port));
			else
				self.showError(_('Unable to start session: %s')
					.format((res && res.result) || _('unknown')));
		}).catch(function() {
			self.showError(_('RPC call failed - is the ttyd-strict rpcd plugin installed?'));
		});
	},

	/* --- background self-heal ----------------------------------------- */

	pollStatus: function() {
		var self = this;

		/* only the focused, visible page may act: a background tab
		 * (hidden) or a window that lost focus stays dormant - its
		 * throttled poll otherwise hijacks the foreground session */
		if (!this.pageActive)
			return Promise.resolve();

		return callSessionStatus().then(function(s) {
			if (!s || !s.state)
				return;

			if (s.state == 'ours') {
				if (s.client_count > 0) {
					/* no terminal on screen (page was loaded while
					 * dormant) or someone else took over meanwhile:
					 * as the focused page, bring it up / reclaim */
					if (!self.mounted ||
					    (self.ownedPid && s.pid && s.pid != self.ownedPid))
						self.ensureSession();
				}
				/* client_count == 0: a MOUNTED page means the user typed
				 * exit - the listener waits for THEM to press Enter in
				 * the frontend's own prompt (remounting would auto-
				 * reconnect; upstream waits for the user). A page with
				 * NO terminal on screen is entering/focusing: attach,
				 * which is plain page-entry semantics. */
				if (!self.mounted)
					self.ensureSession();

				return;
			}

			/* state 'none': the --once instance ended (user typed
			 * exit, or a crash). If our iframe is already on screen
			 * showing the frontend's reconnect prompt, start a fresh
			 * listener but DO NOT touch the iframe - the user's Enter
			 * reconnects to it. No iframe mounted means this page
			 * never got a terminal: run the full entry path. */
			if (self.mounted) {
				var now = Date.now();
				if (!self.pollBusy &&
				    (!self.lastAutoStart || (now - self.lastAutoStart) / 1000 > 5)) {
					self.lastAutoStart = now;
					self.pollBusy = true;
					callSessionStart().then(function(res) {
						if (res && res.result == 'started')
							self.ownedPid = res.pid;
					}).catch(L.noop).finally(function() {
						self.pollBusy = false;
					});
				}
			}
			else {
				self.ensureSession();
			}

			/* foreign-ttyd with a live client appeared after load:
			 * re-run the automatic takeover path */
			self.ensureSession();
		}).catch(L.noop);
	},

	/* --- view ---------------------------------------------------------- */

	render: function() {
		var self = this;
		var port = uci.get_first('ttyd', 'ttyd', 'port') || '7681';

		if (port === '0')
			return E('div', { class: 'alert-message warning' },
				_('Random ttyd port (port=0) is not supported.<br />Change to a fixed port and try again.'));

		this.statusEl = E('div', { 'class': 'alert-message error', 'style': 'display:none' });
		this.termHost = E('div', { 'class': 'cbi-section', 'style': 'height: 60vh' });

		var view = E('div', {}, [
			this.statusEl,
			this.termHost
		]);

		window.addEventListener('resize', this.fitTerminal.bind(this));
		requestAnimationFrame(this.fitTerminal.bind(this));

		/* the framework assembles parts of the layout asynchronously
		 * (tab bar, indicators) AFTER the view renders - recompute the
		 * fit whenever the content area mutates so latecomer rows are
		 * always absorbed and the page never grows a scrollbar */
		var mo = new MutationObserver(this.fitTerminal.bind(this));
		mo.observe(document.getElementById('maincontent') || document.body,
			{ childList: true, subtree: true });

		/* plain interval instead of LuCI's poll framework: poll.add()
		 * makes the theme render a refresh control in the tab bar which
		 * upstream does not have (and which appears AFTER our height
		 * measurement, breaking the viewport fit) */
		setInterval(this.pollStatus.bind(this), POLL_INTERVAL * 1000);

		/* ownership = focused AND visible, tracked as a sticky
		 * event-driven state (a focus event implies focus; blur or
		 * hidden clears it). Both edges re-run the poll, which starts
		 * or reclaims the session as appropriate. */
		var syncActive = function(active) {
			self.pageActive = active && (document.visibilityState == 'visible');
		};
		syncActive(document.hasFocus());
		document.addEventListener('visibilitychange', function() {
			syncActive(self.pageActive || document.hasFocus());
		});
		window.addEventListener('focus', function() {
			syncActive(true);
			self.pollStatus();
		});
		window.addEventListener('blur', function() {
			syncActive(false);
		});

		if (this.pageActive)
			this.ensureSession();

		return view;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
