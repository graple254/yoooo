/**
 * match_client.js
 * ──────────────────────────────────────────────────────────────────────────
 * Place at:  static/files/match_client.js
 *
 * Key design:
 *   • NO page refresh to rematch.  MatchClient.rematch() calls disconnect()
 *     (server cleans up the old session via the existing disconnect logic),
 *     then immediately calls connect() again to re-enter the waiting pool.
 *   • All state is owned by this module; the UI only calls the public API.
 */

const MatchClient = (() => {

    // ─── Config (override via MatchClient.configure({…}) before connect) ──
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const cfg = {
        wsUrl: `${protocol}//${window.location.host}/ws/match/`,
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        // ── Lifecycle callbacks ──
        onWaiting:       () => {},
        onMatched:       (sessionId) => {},
        onPeerLeft:      () => {},
        // ── Signaling / media ──
        onTrack:         (event) => {},
        onDataChannel:   (channel) => {},
        // ── App-level messages ──
        onGameMove:      (payload) => {},
        onSync:          (payload) => {},
        onChat:          (payload) => {},
        onCustom:        (payload) => {},
        // ── Error ──
        onError:         (msg) => console.error("[MatchClient]", msg),
    };

    // ─── Internal state ───────────────────────────────────────────────────
    let ws              = null;
    let pc              = null;       // RTCPeerConnection
    let localStream     = null;
    let sessionId       = null;
    let _isReconnecting = false;

    // ─── Public: configure ────────────────────────────────────────────────
    function configure(overrides) {
        Object.assign(cfg, overrides);
    }

    // ─── Public: connect ──────────────────────────────────────────────────
    function connect() {
        _openWebSocket();
    }

    // ─── Public: rematch (NO page refresh) ───────────────────────────────
    /**
     * 1. Close current WS  →  server disconnect() runs, session cleaned up.
     * 2. Immediately open a new WS  →  server connect() adds us to WAITING_POOL_KEY.
     */
    function rematch() {
        _isReconnecting = true;
        _closePeerConnection();
        sessionId = null;

        if (ws && ws.readyState !== WebSocket.CLOSED) {
            // onclose handler will call _openWebSocket() because _isReconnecting=true
            ws.close(1000, "rematch");
        } else {
            _isReconnecting = false;
            _openWebSocket();
        }
    }

    // ─── Public: disconnect (full, no reconnect) ──────────────────────────
    function disconnect() {
        _isReconnecting = false;
        _closePeerConnection();
        if (ws) ws.close(1000, "user-disconnect");
    }

    // ─── Public: set local media stream ───────────────────────────────────
    function setLocalStream(stream) {
        localStream = stream;
        if (pc && stream) {
            stream.getTracks().forEach(t => pc.addTrack(t, stream));
        }
    }

    // ─── Public: send helpers ─────────────────────────────────────────────
    function sendGameMove(payload) { _send({ type: "game_move",  ...payload }); }
    function sendSync(payload)     { _send({ type: "sync",       ...payload }); }
    function sendChat(text)        { _send({ type: "chat", text              }); }
    function sendCustom(payload)   { _send({ type: "custom",     ...payload }); }

    // ─── WebSocket internals ──────────────────────────────────────────────
    function _openWebSocket() {
        ws = new WebSocket(cfg.wsUrl);

        ws.onopen = () => {};   // server speaks first

        ws.onmessage = ({ data }) => {
            let msg;
            try { msg = JSON.parse(data); }
            catch { cfg.onError("Non-JSON frame: " + data); return; }
            _route(msg);
        };

        ws.onerror = (e) => cfg.onError(e);

        ws.onclose = () => {
            if (_isReconnecting) {
                _isReconnecting = false;
                _openWebSocket();       // ← the magic: instant reconnect
            }
        };
    }

    function _send(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    // ─── Message router ───────────────────────────────────────────────────
    async function _route(msg) {
        switch (msg.type) {
            case "waiting":
                cfg.onWaiting();
                break;

            case "matched":
                sessionId = msg.session_id;
                _initPeerConnection();
                cfg.onMatched(sessionId);
                // The second peer to connect sends the offer
                setTimeout(_createOffer, 400);
                break;

            case "offer":
                await _handleOffer(msg.sdp);
                break;

            case "answer":
                if (pc) await pc.setRemoteDescription(
                    new RTCSessionDescription({ type: "answer", sdp: msg.sdp })
                );
                break;

            case "ice_candidate":
                if (pc && msg.candidate) {
                    try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
                    catch (e) { /* stale candidate, safe to ignore */ }
                }
                break;

            case "peer_left":
                cfg.onPeerLeft();
                _closePeerConnection();
                sessionId = null;
                break;

            case "game_move":  cfg.onGameMove(msg);  break;
            case "sync":       cfg.onSync(msg);      break;
            case "chat":       cfg.onChat(msg);      break;
            case "custom":     cfg.onCustom(msg);    break;

            case "error":
                cfg.onError(msg.message);
                break;
        }
    }

    // ─── WebRTC internals ─────────────────────────────────────────────────
    function _initPeerConnection() {
        _closePeerConnection();
        pc = new RTCPeerConnection({ iceServers: cfg.iceServers });

        pc.onicecandidate = ({ candidate }) => {
            if (candidate) _send({ type: "ice_candidate", candidate: candidate.toJSON() });
        };

        pc.ontrack = (e) => cfg.onTrack(e);

        pc.ondatachannel = (e) => cfg.onDataChannel(e.channel);

        if (localStream) {
            localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        }
    }

    async function _createOffer() {
        if (!pc) return;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        _send({ type: "offer", sdp: offer.sdp });
    }

    async function _handleOffer(sdp) {
        if (!pc) _initPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        _send({ type: "answer", sdp: answer.sdp });
    }

    function _closePeerConnection() {
        if (pc) { pc.close(); pc = null; }
    }

    // ─── Exposed API ──────────────────────────────────────────────────────
    return {
        configure,
        connect,
        rematch,
        disconnect,
        setLocalStream,
        sendGameMove,
        sendSync,
        sendChat,
        sendCustom,
        get sessionId() { return sessionId; },
    };

})();

