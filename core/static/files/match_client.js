/**
 * match_client.js — Vibe-Aware Matchmaking Edition
 *
 *  VIBE-1: Vibe selection before matching
 *    MatchClient.configure() now accepts:
 *      vibe:  "casual" | "board_game"   (required before connect())
 *      game:  "<code>"                  (required when vibe === "board_game")
 *    These are sent to the server as a "join" message immediately after the
 *    WebSocket opens, so the server can place the user in the right pool.
 *
 *  VIBE-2: Vibe context forwarded on match
 *    The server's "matched" message now includes { vibe, game, game_label }.
 *    cfg.onMatched(sessionId, matchCtx) receives a second argument:
 *      matchCtx = { vibe, game, gameLabel }
 *    The UI uses this to render the context banner.
 *
 *  VIBE-3: Waiting state includes vibe context
 *    cfg.onWaiting(waitCtx) receives { vibe, game, gameLabel } so the UI can
 *    display "Looking for someone to play Tic Tac Toe…" while waiting.
 *
 *  VIBE-4: Board game auto-start
 *    When the server sends game_start with { auto: true } the client fires
 *    cfg.onGameStart(msg) exactly as before; connect.html watches msg.auto
 *    to skip the countdown and launch immediately.
 *
 *  All previous fixes/features are preserved unchanged:
 *    ADD 1  Auto-rematch on peer_left (1s delay)
 *    ADD 2  ICE watchdog (5s), watchdog_ack → rematch
 *    ADD 3  Game engine signals (startGame, sendGameOver, sendGameQuit)
 *    ADD 4  Video frame detection (one-way + freeze)
 *    FIX 1-4  wss, ICE queue, offer-after-tracks, TURN
 */

const MatchClient = (() => {

    // ── Config ─────────────────────────────────────────────────────────────────
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
        watchdogMs:         5_000,
        videoCheckMs:       6_000,
        frameMonitorMs:     8_000,

        // ── VIBE-1: vibe/game selection ─────────────────────────────────────
        // Set these via configure() before calling connect().
        vibe:               null,   // "casual" | "board_game"
        game:               null,   // game code when vibe === "board_game"

        // ── Callbacks ───────────────────────────────────────────────────────
        // VIBE-3: onWaiting now receives waitCtx = { vibe, game, gameLabel }
        onWaiting:          (_ctx) => {},
        // VIBE-2: onMatched now receives (sessionId, matchCtx)
        onMatched:          (_sid, _ctx) => {},
        onPeerLeft:         () => {},
        onWatchdogTimeout:  () => {},
        onVideoCheckFailed: () => {},
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

    // ── Core state ─────────────────────────────────────────────────────────────
    let ws = null, pc = null, localStream = null;
    let sessionId = null, _isOfferer = false, _isReconnecting = false;

    // ── Timer handles ──────────────────────────────────────────────────────────
    let _watchdogTimer     = null;
    let _videoCheckTimer   = null;
    let _frameMonitorTimer = null;

    // ── ICE + video state ──────────────────────────────────────────────────────
    let _iceCandidateQueue = [];
    let _videoCheckPassed  = false;
    let _lastFrameCount    = 0;

    // ── Public API ─────────────────────────────────────────────────────────────
    function configure(o) { Object.assign(cfg, o); }
    function connect()    { _openWebSocket(); }

    function rematch() {
        _cancelAllTimers();
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
        _cancelAllTimers();
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

    // ── Senders ────────────────────────────────────────────────────────────────
    function sendGameMove(p) { _send({ type: "game_move",   ...p }); }
    function sendSync(p)     { _send({ type: "sync",        ...p }); }
    function sendChat(t)     { _send({ type: "chat", text: t     }); }
    function sendCustom(p)   { _send({ type: "custom",      ...p }); }
    function sendReport()    { _send({ type: "report_peer"        }); }
    function startGame(code) { _send({ type: "game_start", game_type: code }); }
    function sendGameOver(w) { _send({ type: "game_over",  winner: w      }); }
    function sendGameQuit()  { _send({ type: "game_quit"              }); }

    // ── WebSocket ──────────────────────────────────────────────────────────────
    function _openWebSocket() {
        ws = new WebSocket(cfg.wsUrl);
        ws.onopen = () => {
            // VIBE-1: immediately declare vibe/game selection so the server
            // can route us to the correct pool. This must be the first message.
            _send({
                type: "join",
                vibe: cfg.vibe,
                game: cfg.game || undefined,
            });
        };
        ws.onerror   = (e) => cfg.onError(e);
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

    // ── Router ─────────────────────────────────────────────────────────────────
    async function _route(msg) {
        switch (msg.type) {

            case "waiting":
                // VIBE-3: pass context to callback
                cfg.onWaiting({
                    vibe:      msg.vibe      || cfg.vibe,
                    game:      msg.game      || cfg.game,
                    gameLabel: msg.game_label || "",
                });
                break;

            case "matched":
                sessionId  = msg.session_id;
                _isOfferer = !!msg.is_offerer;
                _initPeerConnection();
                // VIBE-2: surface context to UI
                cfg.onMatched(sessionId, {
                    vibe:      msg.vibe      || "",
                    game:      msg.game      || "",
                    gameLabel: msg.game_label || "",
                });
                if (_isOfferer) await _createOffer();
                break;

            case "offer":
                await _handleOffer(msg.sdp);
                break;

            case "answer":
                if (pc) {
                    await pc.setRemoteDescription(
                        new RTCSessionDescription({ type: "answer", sdp: msg.sdp })
                    );
                    await _flushCandidateQueue();
                }
                break;

            case "ice_candidate":
                if (msg.candidate) {
                    if (pc && pc.remoteDescription) {
                        try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
                    } else {
                        _iceCandidateQueue.push(msg.candidate);
                    }
                }
                break;

            // ADD 1: auto-rematch after 1s UI delay
            case "peer_left":
                _cancelAllTimers();
                _closePeerConnection();
                sessionId = null; _isOfferer = false;
                cfg.onPeerLeft();
                setTimeout(() => rematch(), 1000);
                break;

            // ADD 2: server confirmed watchdog teardown
            case "watchdog_ack":
                rematch();
                break;

            // ADD 3 / VIBE-4: game engine
            case "game_start":  cfg.onGameStart(msg);  break;
            case "game_result": cfg.onGameResult(msg); break;

            case "report_ack":
                if (typeof cfg.onReportAck === "function") cfg.onReportAck(msg);
                break;

            case "game_move": cfg.onGameMove(msg); break;
            case "sync":      cfg.onSync(msg);     break;
            case "chat":      cfg.onChat(msg);     break;
            case "custom":    cfg.onCustom(msg);   break;
            case "error":     cfg.onError(msg.message); break;
        }
    }

    // ── WebRTC ─────────────────────────────────────────────────────────────────
    function _initPeerConnection() {
        _closePeerConnection();
        _iceCandidateQueue = [];
        _videoCheckPassed  = false;
        _lastFrameCount    = 0;

        pc = new RTCPeerConnection({
            iceServers:    cfg.iceServers,
            bundlePolicy:  "max-bundle",
            rtcpMuxPolicy: "require",
        });

        _startWatchdog();

        pc.onicecandidate = ({ candidate }) => {
            if (candidate) _send({ type: "ice_candidate", candidate: candidate.toJSON() });
        };

        pc.oniceconnectionstatechange = () => {
            const s = pc.iceConnectionState;
            cfg.onIceState(s);

            if (s === "connected" || s === "completed") {
                _cancelWatchdog();
                _startVideoCheck();
            } else if (s === "failed" || s === "disconnected") {
                _cancelVideoCheck();
                _cancelFrameMonitor();
                _triggerWatchdog();
            }
        };

        pc.ontrack       = (e) => cfg.onTrack(e);
        pc.ondatachannel = (e) => cfg.onDataChannel(e.channel);

        if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    // ── Watchdog (ADD 2) ───────────────────────────────────────────────────────
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
        setTimeout(() => {
            if (sessionId !== null && pc) rematch();
        }, 3000);
    }

    // ── Video frame detection (ADD 4) ──────────────────────────────────────────
    function _startVideoCheck() {
        _cancelVideoCheck();
        _videoCheckTimer = setTimeout(async () => {
            if (!pc || _videoCheckPassed) return;
            const failed = await _checkRemoteVideoFrames();
            if (failed) {
                console.warn("[MatchClient] Video check failed — 0 frames decoded after check interval");
                cfg.onVideoCheckFailed();
                _triggerWatchdog();
            }
        }, cfg.videoCheckMs);
    }

    function _cancelVideoCheck() {
        if (_videoCheckTimer !== null) { clearTimeout(_videoCheckTimer); _videoCheckTimer = null; }
    }

    async function _checkRemoteVideoFrames() {
        if (!pc) return false;
        try {
            const stats  = await pc.getStats();
            let hasVideo = false;
            let decoded  = 0;

            stats.forEach(report => {
                if (report.type === "inbound-rtp" && report.kind === "video") {
                    hasVideo = true;
                    decoded  = report.framesDecoded ?? 0;
                }
            });

            if (!hasVideo) return false;

            if (decoded > 0) {
                _videoCheckPassed = true;
                _lastFrameCount   = decoded;
                _startFrameMonitor();
                return false;
            }

            return true;
        } catch {
            return false;
        }
    }

    function _startFrameMonitor() {
        _cancelFrameMonitor();
        _frameMonitorTimer = setInterval(async () => {
            if (!pc) { _cancelFrameMonitor(); return; }
            try {
                const stats = await pc.getStats();
                stats.forEach(report => {
                    if (report.type === "inbound-rtp" && report.kind === "video") {
                        const current = report.framesDecoded ?? 0;
                        if (_lastFrameCount > 0 && current === _lastFrameCount) {
                            console.warn("[MatchClient] Video frozen — framesDecoded stuck at", current);
                            _cancelFrameMonitor();
                            cfg.onVideoCheckFailed();
                            _triggerWatchdog();
                        }
                        _lastFrameCount = current;
                    }
                });
            } catch {}
        }, cfg.frameMonitorMs);
    }

    function _cancelFrameMonitor() {
        if (_frameMonitorTimer !== null) {
            clearInterval(_frameMonitorTimer);
            _frameMonitorTimer = null;
            _lastFrameCount    = 0;
        }
    }

    function _cancelAllTimers() {
        _cancelWatchdog();
        _cancelVideoCheck();
        _cancelFrameMonitor();
    }

    // ── Offer / Answer / Candidates ────────────────────────────────────────────
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
        _cancelAllTimers();
        _iceCandidateQueue = [];
        _videoCheckPassed  = false;
        _lastFrameCount    = 0;
        if (pc) {
            pc.onicecandidate             = null;
            pc.oniceconnectionstatechange = null;
            pc.ontrack                    = null;
            pc.ondatachannel              = null;
            pc.close();
            pc = null;
        }
    }

    // ── Public interface ───────────────────────────────────────────────────────
    return {
        configure, connect, rematch, disconnect, setLocalStream,
        sendGameMove, sendSync, sendChat, sendCustom, sendReport,
        startGame, sendGameOver, sendGameQuit,
        get sessionId() { return sessionId;  },
        get iceState()  { return pc ? pc.iceConnectionState : "none"; },
        get isOfferer() { return _isOfferer; },
    };

})();