/**
 * match_client.js  — hardened edition
 * ─────────────────────────────────────────────────────────────────────────────
 * What changed vs the previous version and WHY each fix is necessary:
 *
 *  FIX 1 · Secure WebSocket URL (wss:// on https://)
 *    The old code hardcoded `ws://`. Browsers block mixed-content: if the page
 *    is served over https (ngrok, production) a plain ws:// connection is
 *    silently rejected. We now derive the scheme from window.location.protocol.
 *
 *  FIX 2 · ICE candidate queue
 *    ICE candidates can arrive from the remote peer BEFORE we have called
 *    setRemoteDescription(). Calling addIceCandidate() without a remote
 *    description throws and silently drops the candidate. We buffer every
 *    incoming candidate in _iceCandidateQueue and flush the queue immediately
 *    after setRemoteDescription() succeeds in both _handleOffer() and the
 *    "answer" branch. Without this, on slow/mobile connections almost all
 *    candidates are discarded → ICE never completes → black video.
 *
 *  FIX 3 · Offer sent only after tracks are added
 *    The old code fired _createOffer() via setTimeout(400ms). If getUserMedia
 *    hadn't resolved yet, createOffer() produced an SDP with no media sections.
 *    The remote peer's answer would similarly have no media, so no audio/video
 *    track is ever negotiated. We now call _createOffer() only from inside
 *    _initPeerConnection(), which is always called after setLocalStream() has
 *    already attached tracks (or after the "matched" message confirms the stream
 *    is ready). The offerer role is decided by the server: the second peer to
 *    connect ("peer2") sends the offer; the waiting peer ("peer1") answers.
 *    The server includes `is_offerer: true/false` in the "matched" message.
 *
 *  FIX 4 · TURN server support
 *    STUN alone fails against Symmetric NAT (common on mobile networks and
 *    corporate Wi-Fi). A TURN relay guarantees connectivity. Fill in your
 *    TURN credentials in cfg.iceServers below; the rest of the code already
 *    handles it because RTCPeerConnection uses the iceServers array as-is.
 */

const MatchClient = (() => {

    // ─────────────────────────────────────────────────────────────────────────
    //  CONFIG  — override any key via MatchClient.configure({…}) before connect
    // ─────────────────────────────────────────────────────────────────────────
    const cfg = {

        // FIX 1: derive ws/wss from page protocol so ngrok / https works
        get wsUrl() {
            const proto = location.protocol === "https:" ? "wss" : "ws";
            return `${proto}://${location.host}/ws/match/`;
        },

        // FIX 4: STUN + TURN  — replace YOUR_* with real values
        iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            // ── Uncomment and fill in when you have a coturn server ──────────
            // {
            //   urls:       "turn:YOUR_TURN_HOST:3478",
            //   username:   "YOUR_TURN_USERNAME",
            //   credential: "YOUR_TURN_SECRET",
            // },
            // {
            //   urls:       "turns:YOUR_TURN_HOST:5349",   // TLS fallback
            //   username:   "YOUR_TURN_USERNAME",
            //   credential: "YOUR_TURN_SECRET",
            // },
        ],

        // ── Lifecycle ──────────────────────────────────────────────────────
        onWaiting:     () => {},
        onMatched:     (_sessionId) => {},
        onPeerLeft:    () => {},
        // ── Media ─────────────────────────────────────────────────────────
        onTrack:       (_event) => {},
        onDataChannel: (_ch) => {},
        // ── App messages ──────────────────────────────────────────────────
        onGameMove:    (_msg) => {},
        onSync:        (_msg) => {},
        onChat:        (_msg) => {},
        onCustom:      (_msg) => {},
        // ── Diagnostics ───────────────────────────────────────────────────
        onIceState:    (_state) => {},   // hook for a debug HUD
        onError:       (_msg) => console.error("[MatchClient]", _msg),
    };

    // ─────────────────────────────────────────────────────────────────────────
    //  STATE
    // ─────────────────────────────────────────────────────────────────────────
    let ws               = null;
    let pc               = null;
    let localStream      = null;
    let sessionId        = null;
    let _isOfferer       = false;       // set from server "matched" message
    let _isReconnecting  = false;

    // FIX 2: candidate queue — filled while remoteDescription is null
    let _iceCandidateQueue = [];

    // ─────────────────────────────────────────────────────────────────────────
    //  PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────
    function configure(overrides) { Object.assign(cfg, overrides); }

    function connect() { _openWebSocket(); }

    /** Close WS (server cleans session) then immediately reopen → back in pool. */
    function rematch() {
        _isReconnecting = true;
        _closePeerConnection();
        sessionId  = null;
        _isOfferer = false;
        if (ws && ws.readyState !== WebSocket.CLOSED) {
            ws.close(1000, "rematch");      // ws.onclose fires → _openWebSocket()
        } else {
            _isReconnecting = false;
            _openWebSocket();
        }
    }

    function disconnect() {
        _isReconnecting = false;
        _closePeerConnection();
        if (ws) ws.close(1000, "user-disconnect");
    }

    /**
     * Attach the local MediaStream.  Must be called BEFORE connect() so tracks
     * are added to the RTCPeerConnection before the offer is created (FIX 3).
     */
    function setLocalStream(stream) {
        localStream = stream;
        // If a pc already exists (e.g. called after matched), add tracks now
        if (pc && stream) {
            const existingTracks = pc.getSenders().map(s => s.track);
            stream.getTracks().forEach(t => {
                if (!existingTracks.includes(t)) pc.addTrack(t, stream);
            });
        }
    }

    // Convenience senders
    function sendGameMove(p) { _send({ type: "game_move", ...p }); }
    function sendSync(p)     { _send({ type: "sync",      ...p }); }
    function sendChat(t)     { _send({ type: "chat", text: t   }); }
    function sendCustom(p)   { _send({ type: "custom",    ...p }); }
    function sendReport()    { _send({ type: "report_peer"      }); }

    // ─────────────────────────────────────────────────────────────────────────
    //  WEBSOCKET
    // ─────────────────────────────────────────────────────────────────────────
    function _openWebSocket() {
        // cfg.wsUrl is a getter so it evaluates fresh every time (FIX 1)
        ws = new WebSocket(cfg.wsUrl);

        ws.onopen    = () => { /* server speaks first */ };
        ws.onerror   = (e) => cfg.onError(e);
        ws.onmessage = ({ data }) => {
            let msg;
            try { msg = JSON.parse(data); }
            catch { cfg.onError("Non-JSON frame received"); return; }
            _route(msg);
        };
        ws.onclose = () => {
            if (_isReconnecting) {
                _isReconnecting = false;
                _openWebSocket();           // instant reconnect for rematch
            }
        };
    }

    function _send(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  MESSAGE ROUTER
    // ─────────────────────────────────────────────────────────────────────────
    async function _route(msg) {
        switch (msg.type) {

            case "waiting":
                cfg.onWaiting();
                break;

            case "matched": {
                sessionId  = msg.session_id;
                _isOfferer = !!msg.is_offerer;   // server decides who offers

                // FIX 3: build the pc now — tracks are already in localStream
                // (caller must call setLocalStream before connect / rematch)
                _initPeerConnection();
                cfg.onMatched(sessionId);

                // Only the designated offerer creates and sends the offer.
                // The answerer waits for the offer to arrive.
                if (_isOfferer) {
                    await _createOffer();
                }
                break;
            }

            case "offer":
                await _handleOffer(msg.sdp);
                break;

            case "answer":
                if (pc) {
                    await pc.setRemoteDescription(
                        new RTCSessionDescription({ type: "answer", sdp: msg.sdp })
                    );
                    // FIX 2: flush queued candidates now that remote desc is set
                    await _flushCandidateQueue();
                }
                break;

            case "ice_candidate":
                // FIX 2: queue if no remote description yet; apply immediately otherwise
                if (msg.candidate) {
                    if (pc && pc.remoteDescription) {
                        try {
                            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        } catch { /* stale candidate — safe to ignore */ }
                    } else {
                        _iceCandidateQueue.push(msg.candidate);
                    }
                }
                break;

            case "peer_left":
                cfg.onPeerLeft();
                _closePeerConnection();
                sessionId  = null;
                _isOfferer = false;
                break;

            case "report_ack":
                if (typeof cfg.onReportAck === "function") {
                    cfg.onReportAck(msg);
                }
                break;    

            case "game_move":  cfg.onGameMove(msg); break;
            case "sync":       cfg.onSync(msg);     break;
            case "chat":       cfg.onChat(msg);     break;
            case "custom":     cfg.onCustom(msg);   break;
            case "error":      cfg.onError(msg.message); break;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  WEBRTC
    // ─────────────────────────────────────────────────────────────────────────
    function _initPeerConnection() {
        _closePeerConnection();
        _iceCandidateQueue = [];        // FIX 2: fresh queue for this session

        pc = new RTCPeerConnection({
            iceServers:         cfg.iceServers,   // FIX 4: includes TURN entries
            bundlePolicy:       "max-bundle",
            rtcpMuxPolicy:      "require",
        });

        // Trickle ICE — send each candidate as it's gathered
        pc.onicecandidate = ({ candidate }) => {
            if (candidate) _send({ type: "ice_candidate", candidate: candidate.toJSON() });
        };

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            cfg.onIceState(state);
            if (state === "failed") {
                cfg.onError("ICE connection failed — try rematching or check TURN config");
            }
        };

        pc.ontrack       = (e) => cfg.onTrack(e);
        pc.ondatachannel = (e) => cfg.onDataChannel(e.channel);

        // FIX 3: add tracks BEFORE createOffer so the SDP has media sections
        if (localStream) {
            localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
        }
    }

    // FIX 3: called only after _initPeerConnection() (tracks already attached)
    async function _createOffer() {
        if (!pc) return;
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            _send({ type: "offer", sdp: offer.sdp });
        } catch (e) {
            cfg.onError("createOffer failed: " + e.message);
        }
    }

    async function _handleOffer(sdp) {
        // Answerer may not have called _initPeerConnection yet in rare timings
        if (!pc) _initPeerConnection();
        try {
            await pc.setRemoteDescription(
                new RTCSessionDescription({ type: "offer", sdp })
            );
            // FIX 2: flush any candidates that beat the offer
            await _flushCandidateQueue();

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            _send({ type: "answer", sdp: answer.sdp });
        } catch (e) {
            cfg.onError("handleOffer failed: " + e.message);
        }
    }

    // FIX 2: drain the queue after remoteDescription is guaranteed to be set
    async function _flushCandidateQueue() {
        while (_iceCandidateQueue.length && pc) {
            const candidate = _iceCandidateQueue.shift();
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch { /* stale */ }
        }
    }

    function _closePeerConnection() {
        _iceCandidateQueue = [];
        if (pc) {
            pc.onicecandidate            = null;
            pc.oniceconnectionstatechange = null;
            pc.ontrack                   = null;
            pc.ondatachannel             = null;
            pc.close();
            pc = null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  EXPORTS
    // ─────────────────────────────────────────────────────────────────────────
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
        sendReport,
        get sessionId()  { return sessionId; },
        get iceState()   { return pc ? pc.iceConnectionState : "none"; },
    };

})();