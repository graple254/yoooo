/**
 * match_client.js  — hardened + game engine edition
 *
 *  ADD 1: Auto-rematch on peer_left (1-second delay, then rematch() fires automatically).
 *         connect.html onPeerLeft should only handle UI now — do NOT call rematch() there.
 *
 *  ADD 2: ICE connection watchdog (12 seconds).
 *         Cancelled on "connected"/"completed". Fires on "failed" or timeout.
 *         Sends {"type":"watchdog_timeout"} to server; server acks with "watchdog_ack".
 *         cfg.onWatchdogTimeout() lets the UI show a toast before the auto-rematch.
 *
 *  ADD 3: Game engine signals.
 *         startGame(code), sendGameOver(winner), sendGameQuit()
 *         cfg.onGameStart(msg), cfg.onGameResult(msg)
 *         MatchClient.isOfferer getter for turn management.
 *
 *  FIX 1-4 (wss://, ICE queue, offer-after-tracks, TURN) all preserved unchanged.
 */

const MatchClient = (() => {

    const cfg = {
        get wsUrl() {
            const proto = location.protocol === "https:" ? "wss" : "ws";
            return `${proto}://${location.host}/ws/match/`;
        },
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            // { urls: "turn:YOUR_HOST:3478", username: "u", credential: "s" },
        ],
        watchdogMs:         12_000,
        onWaiting:          () => {},
        onMatched:          (_sid) => {},
        onPeerLeft:         () => {},       // UI only — rematch fires automatically
        onWatchdogTimeout:  () => {},
        onTrack:            (_e)  => {},
        onDataChannel:      (_ch) => {},
        onGameMove:         (_m)  => {},
        onSync:             (_m)  => {},
        onChat:             (_m)  => {},
        onCustom:           (_m)  => {},
        onGameStart:        (_m)  => {},
        onGameResult:       (_m)  => {},
        onIceState:         (_s)  => {},
        onError:            (_m)  => console.error("[MatchClient]", _m),
    };

    let ws = null, pc = null, localStream = null;
    let sessionId = null, _isOfferer = false, _isReconnecting = false;
    let _watchdogTimer = null;
    let _iceCandidateQueue = [];

    function configure(o)  { Object.assign(cfg, o); }
    function connect()     { _openWebSocket(); }

    function rematch() {
        _cancelWatchdog();
        _isReconnecting = true;
        _closePeerConnection();
        sessionId = null; _isOfferer = false;
        if (ws && ws.readyState !== WebSocket.CLOSED) {
            ws.close(1000, "rematch");
        } else {
            _isReconnecting = false;
            _openWebSocket();
        }
    }

    function disconnect() {
        _cancelWatchdog();
        _isReconnecting = false;
        _closePeerConnection();
        if (ws) ws.close(1000, "user-disconnect");
    }

    function setLocalStream(stream) {
        localStream = stream;
        if (pc && stream) {
            const ex = pc.getSenders().map(s => s.track);
            stream.getTracks().forEach(t => { if (!ex.includes(t)) pc.addTrack(t, stream); });
        }
    }

    // ── Senders ───────────────────────────────────────────────────────────────
    function sendGameMove(p) { _send({ type: "game_move", ...p }); }
    function sendSync(p)     { _send({ type: "sync",      ...p }); }
    function sendChat(t)     { _send({ type: "chat", text: t   }); }
    function sendCustom(p)   { _send({ type: "custom",    ...p }); }
    function sendReport()    { _send({ type: "report_peer"      }); }
    function startGame(code = "3mm")    { _send({ type: "game_start", game_type: code }); }
    function sendGameOver(winner)       { _send({ type: "game_over", winner }); }
    function sendGameQuit()             { _send({ type: "game_quit" }); }

    // ── WebSocket ─────────────────────────────────────────────────────────────
    function _openWebSocket() {
        ws = new WebSocket(cfg.wsUrl);
        ws.onopen  = () => {};
        ws.onerror = (e) => cfg.onError(e);
        ws.onmessage = ({ data }) => {
            let msg;
            try { msg = JSON.parse(data); } catch { cfg.onError("Non-JSON frame"); return; }
            _route(msg);
        };
        ws.onclose = () => {
            if (_isReconnecting) { _isReconnecting = false; _openWebSocket(); }
        };
    }

    function _send(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    // ── Router ────────────────────────────────────────────────────────────────
    async function _route(msg) {
        switch (msg.type) {
            case "waiting":
                cfg.onWaiting(); break;

            case "matched":
                sessionId = msg.session_id; _isOfferer = !!msg.is_offerer;
                _initPeerConnection();
                cfg.onMatched(sessionId);
                if (_isOfferer) await _createOffer();
                break;

            case "offer":  await _handleOffer(msg.sdp); break;

            case "answer":
                if (pc) {
                    await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
                    await _flushCandidateQueue();
                }
                break;

            case "ice_candidate":
                if (msg.candidate) {
                    if (pc && pc.remoteDescription) {
                        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
                    } else { _iceCandidateQueue.push(msg.candidate); }
                }
                break;

            // ADD 1: auto-rematch after 1 s UI delay
            case "peer_left":
                _cancelWatchdog();
                _closePeerConnection();
                sessionId = null; _isOfferer = false;
                cfg.onPeerLeft();                       // UI shows "Skipping..."
                setTimeout(() => rematch(), 1000);      // auto-rematch
                break;

            // ADD 2: server confirmed watchdog session teardown
            case "watchdog_ack":
                rematch(); break;

            // ADD 3: game engine
            case "game_start":   cfg.onGameStart(msg);  break;
            case "game_result":  cfg.onGameResult(msg); break;

            case "report_ack":
                if (typeof cfg.onReportAck === "function") cfg.onReportAck(msg); break;

            case "game_move": cfg.onGameMove(msg); break;
            case "sync":      cfg.onSync(msg);     break;
            case "chat":      cfg.onChat(msg);     break;
            case "custom":    cfg.onCustom(msg);   break;
            case "error":     cfg.onError(msg.message); break;
        }
    }

    // ── WebRTC ────────────────────────────────────────────────────────────────
    function _initPeerConnection() {
        _closePeerConnection();
        _iceCandidateQueue = [];
        pc = new RTCPeerConnection({ iceServers: cfg.iceServers, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });

        _startWatchdog();   // ADD 2

        pc.onicecandidate = ({ candidate }) => {
            if (candidate) _send({ type: "ice_candidate", candidate: candidate.toJSON() });
        };
        pc.oniceconnectionstatechange = () => {
            const s = pc.iceConnectionState;
            cfg.onIceState(s);
            if (s === "connected" || s === "completed") _cancelWatchdog();   // ADD 2: success
            else if (s === "failed")                    _triggerWatchdog();  // ADD 2: hard fail
        };
        pc.ontrack       = (e) => cfg.onTrack(e);
        pc.ondatachannel = (e) => cfg.onDataChannel(e.channel);
        if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    // ADD 2: watchdog
    function _startWatchdog() {
        _cancelWatchdog();
        _watchdogTimer = setTimeout(_triggerWatchdog, cfg.watchdogMs);
    }
    function _cancelWatchdog() {
        if (_watchdogTimer !== null) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
    }
    function _triggerWatchdog() {
        _cancelWatchdog();
        cfg.onWatchdogTimeout();
        _send({ type: "watchdog_timeout" });
        // Safety net: if server doesn't ack in 3 s, rematch anyway
        setTimeout(() => { if (sessionId !== null) rematch(); }, 3000);
    }

    async function _createOffer() {
        if (!pc) return;
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            _send({ type: "offer", sdp: offer.sdp });
        } catch (e) { cfg.onError("createOffer failed: " + e.message); }
    }

    async function _handleOffer(sdp) {
        if (!pc) _initPeerConnection();
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp }));
            await _flushCandidateQueue();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            _send({ type: "answer", sdp: answer.sdp });
        } catch (e) { cfg.onError("handleOffer failed: " + e.message); }
    }

    async function _flushCandidateQueue() {
        while (_iceCandidateQueue.length && pc) {
            try { await pc.addIceCandidate(new RTCIceCandidate(_iceCandidateQueue.shift())); } catch {}
        }
    }

    function _closePeerConnection() {
        _cancelWatchdog();
        _iceCandidateQueue = [];
        if (pc) {
            pc.onicecandidate = pc.oniceconnectionstatechange = pc.ontrack = pc.ondatachannel = null;
            pc.close(); pc = null;
        }
    }

    return {
        configure, connect, rematch, disconnect, setLocalStream,
        sendGameMove, sendSync, sendChat, sendCustom, sendReport,
        startGame, sendGameOver, sendGameQuit,
        get sessionId()  { return sessionId; },
        get iceState()   { return pc ? pc.iceConnectionState : "none"; },
        get isOfferer()  { return _isOfferer; },
    };

})();