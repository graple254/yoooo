/**
 * presence_widget.js
 * ─────────────────────────────────────────────────────────────────────────
 * Connects to wss://<host>/ws/presence/ and patches any elements with the
 * data attributes below.  Works on any page independently of match_client.js.
 *
 * HTML usage — put these attributes on whatever elements you like:
 *
 *   <span data-presence="online_count">…</span>
 *   <span data-presence="online_users_count">…</span>
 *
 * Optional: add data-presence-animate="true" to get a brief highlight pulse
 * whenever the number changes.
 *
 * Settings (window.PRESENCE_CONFIG before this script loads):
 *   reconnectMs   — base delay before reconnect attempt  (default 3000)
 *   maxReconnectMs — cap on exponential back-off          (default 30000)
 */

(function () {
    "use strict";

    const cfg = Object.assign({
        reconnectMs:    3_000,
        maxReconnectMs: 30_000,
    }, window.PRESENCE_CONFIG || {});

    const WS_URL = (() => {
        const proto = location.protocol === "https:" ? "wss" : "ws";
        return `${proto}://${location.host}/ws/presence/`;
    })();

    let ws = null;
    let reconnectDelay = cfg.reconnectMs;
    let reconnectTimer = null;

    function connect() {
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            reconnectDelay = cfg.reconnectMs;   // reset back-off on success
        };

        ws.onmessage = ({ data }) => {
            let msg;
            try { msg = JSON.parse(data); } catch { return; }
            if (msg.type !== "presence") return;
            _patch("online_count",       msg.online_count);
            _patch("online_users_count", msg.online_users_count);
        };

        ws.onclose = () => _scheduleReconnect();
        ws.onerror = () => ws.close();   // onclose will handle reconnect
    }

    function _patch(key, value) {
        document.querySelectorAll(`[data-presence="${key}"]`).forEach(el => {
            const prev = el.textContent.trim();
            const next = String(value);
            if (prev === next) return;
            el.textContent = next;
            if (el.dataset.presenceAnimate === "true") _pulse(el);
        });
    }

    function _pulse(el) {
        el.classList.remove("presence-changed");
        // Force reflow so re-adding the class restarts the animation
        void el.offsetWidth;
        el.classList.add("presence-changed");
    }

    function _scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, reconnectDelay);
        // Exponential back-off, capped
        reconnectDelay = Math.min(reconnectDelay * 2, cfg.maxReconnectMs);
    }

    // Kick off on DOM ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", connect);
    } else {
        connect();
    }
})();