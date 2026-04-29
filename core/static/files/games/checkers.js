/**
 * static/js/games/checkers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Multiplayer Checkers (American Draughts) — rewritten from scratch.
 *
 * API (identical contract to other game modules):
 *   Checkers.init(containerId, isOfferer, onGameOver)
 *   Checkers.handleRemoteMove(data)
 *   Checkers.destroy()
 *
 * Wire format:
 *   MatchClient.sendGameMove({ sub_type:"checkers", steps:[{r,c},...] })
 *   steps = ordered waypoints from origin through all jump squares to landing.
 *   Captured squares are inferred from jump distances (|Δr| === 2).
 *
 * Rules (standard American checkers, 8×8):
 *   • RED (offerer) starts rows 5-7, moves toward row 0. Goes first.
 *   • BLACK (answerer) starts rows 0-2, moves toward row 7.
 *   • Pieces move diagonally forward only; kings move both ways.
 *   • Captures are mandatory; multi-jump must complete in one turn.
 *   • Reaching the back rank promotes to king (ends multi-jump that turn).
 *   • Win: opponent has no pieces or no legal moves.
 *
 * ─── SCOREBOARD DESIGN — first principles ─────────────────────────────────
 *
 * There are exactly two colours: R and B.
 * There are exactly two panels: "You" and "Opponent".
 *
 * Each panel stores its bound colour in dataset.panelColor ("R" or "B").
 * renderScoreboard() reads that attribute and calls countPieces(_board, color).
 * It never touches _myColor inside the display logic.
 *
 * This means both players run the exact same render code and get correct
 * results — because "R remaining" is always correct regardless of perspective.
 */

const Checkers = (() => {

    // ── Piece tokens ─────────────────────────────────────────────────────────
    const R  = 'R';    // Red man   (offerer)
    const B  = 'B';    // Black man (answerer)
    const RK = 'RK';   // Red king
    const BK = 'BK';   // Black king

    // ── Visual palette ────────────────────────────────────────────────────────
    const SQ_LIGHT = '#f0d9b5';
    const SQ_DARK  = '#b58863';
    const SQ_SEL   = '#4ade80';
    const SQ_MOVE  = '#86efac';
    const SQ_JUMP  = '#fbbf24';

    const PALETTE = {
        R:  { fill:'#dc2626', glow:'#ef444444', border:'#fca5a5' },
        B:  { fill:'#1f2937', glow:'#37415144', border:'#6b7280' },
    };

    // ── Module state ──────────────────────────────────────────────────────────
    let _c;          // container element
    let _board;      // 8×8 array, each cell: R | B | RK | BK | null
    let _myColor;    // R or B — set once at init, never changes
    let _myRole;     // "offerer" | "answerer"
    let _turn;       // R or B — whose turn it is right now
    let _sel;        // {r,c} | null — currently selected board square
    let _chain;      // {r,c}[] — landing squares accumulated during a multi-jump
    let _origin;     // {r,c} | null — the square where the multi-jump started
    let _over;       // bool
    let _onGameOver;

    // ── Pure game logic ───────────────────────────────────────────────────────

    const isRed   = p => p === R  || p === RK;
    const isBlack = p => p === B  || p === BK;
    const isKing  = p => p === RK || p === BK;
    const colorOf = p => isRed(p) ? R : B;
    const enemy   = c => c === R ? B : R;
    const owns    = (p, c) => c === R ? isRed(p) : isBlack(p);
    const inBounds= (r,c) => r>=0 && r<8 && c>=0 && c<8;

    function dirs(p) {
        if (isKing(p))  return [[-1,-1],[-1,1],[1,-1],[1,1]];
        if (isRed(p))   return [[-1,-1],[-1,1]];   // red moves up (↑ = decreasing r)
        return [[1,-1],[1,1]];                       // black moves down
    }

    function makeBoard() {
        const b = Array.from({length:8}, () => Array(8).fill(null));
        for (let r=0; r<8; r++)
            for (let c=0; c<8; c++)
                if ((r+c)%2===1) {
                    if (r < 3) b[r][c] = B;
                    if (r > 4) b[r][c] = R;
                }
        return b;
    }

    function cloneBoard(b) { return b.map(row => [...row]); }

    function applyStep(b, from, to, over) {
        const nb = cloneBoard(b);
        nb[to.r][to.c]     = nb[from.r][from.c];
        nb[from.r][from.c] = null;
        if (over) nb[over.r][over.c] = null;
        if (nb[to.r][to.c] === R && to.r === 0) nb[to.r][to.c] = RK;
        if (nb[to.r][to.c] === B && to.r === 7) nb[to.r][to.c] = BK;
        return nb;
    }

    function legalMoves(b, color) {
        const jumps = [], moves = [];
        for (let r=0; r<8; r++) {
            for (let c=0; c<8; c++) {
                const p = b[r][c];
                if (!p || !owns(p,color)) continue;
                for (const [dr,dc] of dirs(p)) {
                    const r1=r+dr, c1=c+dc;
                    if (!inBounds(r1,c1)) continue;
                    if (!b[r1][c1]) {
                        moves.push({from:{r,c},to:{r:r1,c:c1}});
                    } else if (owns(b[r1][c1], enemy(color))) {
                        const r2=r+2*dr, c2=c+2*dc;
                        if (inBounds(r2,c2) && !b[r2][c2])
                            jumps.push({from:{r,c},over:{r:r1,c:c1},to:{r:r2,c:c2}});
                    }
                }
            }
        }
        return jumps.length ? {jumps, moves:[]} : {jumps:[], moves};
    }

    function continuationJumps(b, r, c) {
        const p = b[r][c];
        if (!p) return [];
        const color = colorOf(p);
        const result = [];
        for (const [dr,dc] of dirs(p)) {
            const r1=r+dr, c1=c+dc;
            if (!inBounds(r1,c1) || !b[r1][c1]) continue;
            if (!owns(b[r1][c1], enemy(color))) continue;
            const r2=r+2*dr, c2=c+2*dc;
            if (inBounds(r2,c2) && !b[r2][c2])
                result.push({over:{r:r1,c:c1},to:{r:r2,c:c2}});
        }
        return result;
    }

    function countPieces(b, color) {
        let n = 0;
        for (const row of b) for (const p of row) if (p && owns(p,color)) n++;
        return n;
    }

    function checkWinner(b, justMoved) {
        const opp = enemy(justMoved);
        const {jumps, moves} = legalMoves(b, opp);
        return jumps.length+moves.length===0 ? justMoved : null;
    }

    // ── UI construction ───────────────────────────────────────────────────────

    function buildUI() {
        _c.innerHTML = '';
        _c.style.cssText = `
            display:flex; flex-direction:column; align-items:center;
            gap:10px; padding:12px 8px; user-select:none;
        `;
        injectStyles();
        buildScoreboard();
        buildBoard();
        buildFooter();
    }

    function injectStyles() {
        if (document.getElementById('ck-css')) return;
        const s = document.createElement('style');
        s.id = 'ck-css';
        s.textContent = `
            .ck-pip {
                width:11px; height:11px; border-radius:50%; flex-shrink:0;
                transition: opacity 0.3s ease, transform 0.3s ease,
                            background 0.3s, border-color 0.3s;
            }
            .ck-pip.lost { opacity:0.16; transform:scale(0.6); }
            .ck-cell {
                position:relative; display:flex;
                align-items:center; justify-content:center;
            }
            .ck-piece {
                width:76%; aspect-ratio:1; border-radius:50%;
                display:flex; align-items:center; justify-content:center;
                font-size:clamp(0.65rem,2.2vw,0.95rem); font-weight:700;
                color:#fff; text-shadow:0 1px 3px rgba(0,0,0,0.4);
                transition: border-color 0.12s, box-shadow 0.12s;
            }
            .ck-dot {
                width:30%; aspect-ratio:1; border-radius:50%;
                pointer-events:none;
            }
        `;
        document.head.appendChild(s);
    }

    /**
     * Build the scoreboard.
     *
     * CRITICAL DESIGN:
     * Each panel element gets dataset.panelColor = "R" or "B".
     * renderScoreboard() queries all [data-panel-color] elements and
     * updates each one using countPieces(_board, panelColor).
     *
     * _myColor is used ONLY to decide which panel to label "You" vs "Opponent".
     * It is never used inside the display update path.
     */
    function buildScoreboard() {
        const oppColor = enemy(_myColor);

        const bar = document.createElement('div');
        bar.style.cssText = `
            display:flex; align-items:center; justify-content:space-between;
            width:min(400px,92vw); gap:8px;
        `;

        function makePanel(label, color, align) {
            const pal = PALETTE[color];
            const wrap = document.createElement('div');

            // ← The one source of truth for this panel's colour
            wrap.dataset.panelColor = color;

            wrap.style.cssText = `
                display:flex; flex-direction:column;
                align-items:${align}; gap:5px; flex:1; min-width:0;
            `;

            // Label row
            const labelRow = document.createElement('div');
            labelRow.style.cssText = `display:flex; align-items:center; gap:5px;`;

            const dot = document.createElement('span');
            dot.style.cssText = `
                width:9px; height:9px; border-radius:50%; flex-shrink:0;
                background:${pal.fill};
                box-shadow:0 0 0 2px ${pal.border}44;
            `;

            const lbl = document.createElement('span');
            lbl.style.cssText = `font-size:0.7rem; font-weight:700; color:#374151;`;
            lbl.textContent = label;

            const badge = document.createElement('span');
            badge.className = 'ck-lost-badge';
            badge.style.cssText = `
                font-size:0.62rem; font-weight:700; color:#dc2626;
                opacity:0; transition:opacity 0.2s; margin-left:1px;
            `;

            labelRow.append(dot, lbl, badge);
            wrap.appendChild(labelRow);

            // 12 pip dots
            const tray = document.createElement('div');
            tray.style.cssText = `display:flex; flex-wrap:wrap; gap:3px; max-width:90px;`;
            for (let i=0; i<12; i++) {
                const pip = document.createElement('div');
                pip.className = 'ck-pip';
                pip.style.background  = pal.fill;
                pip.style.border      = `1.5px solid ${pal.border}`;
                tray.appendChild(pip);
            }
            wrap.appendChild(tray);

            // "N left" label
            const remLbl = document.createElement('div');
            remLbl.className = 'ck-rem-lbl';
            remLbl.style.cssText = `font-size:0.62rem; color:#9ca3af; font-weight:500;`;
            remLbl.textContent = '12 left';
            wrap.appendChild(remLbl);

            return wrap;
        }

        // "You" panel bound to _myColor; "Opponent" panel bound to the enemy colour
        const mePanel  = makePanel('You',      _myColor, 'flex-start');
        const oppPanel = makePanel('Opponent', oppColor,  'flex-end');

        // Centre status
        const mid = document.createElement('div');
        mid.style.cssText = `
            display:flex; flex-direction:column; align-items:center;
            gap:3px; flex-shrink:0;
        `;
        const statusEl = document.createElement('div');
        statusEl.id = 'ck-status';
        statusEl.style.cssText = `
            font-size:0.72rem; font-weight:700; color:#374151;
            text-align:center; white-space:nowrap;
        `;
        statusEl.textContent = '—';
        const turnPip = document.createElement('div');
        turnPip.id = 'ck-turn-pip';
        turnPip.style.cssText = `
            width:6px; height:6px; border-radius:50%;
            background:#d1d5db; margin:0 auto; transition:background 0.25s;
        `;
        mid.append(statusEl, turnPip);

        bar.append(mePanel, mid, oppPanel);
        _c.appendChild(bar);
    }

    function buildBoard() {
        const wrap = document.createElement('div');
        wrap.id = 'ck-board';
        wrap.style.cssText = `
            position:relative; width:min(400px,92vw); aspect-ratio:1;
            border-radius:10px; overflow:hidden;
            box-shadow:0 6px 28px rgba(0,0,0,0.15);
            display:grid;
            grid-template-columns:repeat(8,1fr);
            grid-template-rows:repeat(8,1fr);
        `;
        for (let r=0; r<8; r++) {
            for (let c=0; c<8; c++) {
                const cell = document.createElement('div');
                cell.className = 'ck-cell';
                cell.dataset.r = r;
                cell.dataset.c = c;
                cell.style.background = (r+c)%2===0 ? SQ_LIGHT : SQ_DARK;
                cell.addEventListener('click', () => onCellClick(r, c));
                wrap.appendChild(cell);
            }
        }
        _c.appendChild(wrap);
    }

    function buildFooter() {
        const btn = document.createElement('button');
        btn.textContent = 'Resign';
        btn.style.cssText = `
            padding:5px 20px; border-radius:40px;
            border:1px solid #dc2626; background:white;
            color:#dc2626; font-size:0.78rem; cursor:pointer;
            transition:all 0.18s;
        `;
        btn.onmouseenter = () => { btn.style.background='#dc2626'; btn.style.color='white'; };
        btn.onmouseleave = () => { btn.style.background='white';   btn.style.color='#dc2626'; };
        btn.onclick = resign;
        _c.appendChild(btn);
    }

    // ── Render ────────────────────────────────────────────────────────────────

    function render() {
        renderStatus();
        renderScoreboard();
        renderBoard();
    }

    function renderStatus() {
        if (_over) return;
        const el  = document.getElementById('ck-status');
        const pip = document.getElementById('ck-turn-pip');
        if (!el) return;
        const myTurn = _turn === _myColor;
        el.textContent = myTurn ? '▶ Your turn' : '⏳ Waiting…';
        el.style.color = myTurn ? '#16a34a' : '#9ca3af';
        if (pip) pip.style.background = myTurn ? '#16a34a' : '#d1d5db';
    }

    /**
     * Update each panel purely from its dataset.panelColor.
     * No reference to _myColor here — only board state and the panel's own colour.
     */
    function renderScoreboard() {
        document.querySelectorAll('[data-panel-color]').forEach(panel => {
            const color     = panel.dataset.panelColor;   // "R" or "B"
            const remaining = countPieces(_board, color);
            const captured  = 12 - remaining;

            // Pips
            panel.querySelectorAll('.ck-pip').forEach((pip, i) => {
                i < remaining
                    ? pip.classList.remove('lost')
                    : pip.classList.add('lost');
            });

            // "N left"
            const remEl = panel.querySelector('.ck-rem-lbl');
            if (remEl) {
                remEl.textContent  = `${remaining} left`;
                remEl.style.color  = remaining <= 3 ? '#dc2626' : '#9ca3af';
                remEl.style.fontWeight = remaining <= 3 ? '700' : '500';
            }

            // "−N captured" badge
            const badge = panel.querySelector('.ck-lost-badge');
            if (badge) {
                badge.textContent   = captured > 0 ? `−${captured}` : '';
                badge.style.opacity = captured > 0 ? '1' : '0';
            }
        });
    }

    function renderBoard() {
        // Black player sees a flipped board so their pieces are always at the bottom
        const flip = _myColor === B;

        // Compute legal highlights for the current player
        const selMoves = new Set();
        const selJumps = new Set();
        const forced   = new Set();

        const {jumps, moves} = legalMoves(_board, _turn);
        const mustJump = jumps.length > 0;

        if (_turn === _myColor) {
            if (_sel) {
                const {r:sr, c:sc} = _sel;
                if (_chain.length > 0) {
                    continuationJumps(_board, sr, sc)
                        .forEach(j => selJumps.add(`${j.to.r},${j.to.c}`));
                } else if (mustJump) {
                    jumps.filter(j => j.from.r===sr && j.from.c===sc)
                         .forEach(j => selJumps.add(`${j.to.r},${j.to.c}`));
                } else {
                    moves.filter(m => m.from.r===sr && m.from.c===sc)
                         .forEach(m => selMoves.add(`${m.to.r},${m.to.c}`));
                }
            } else if (mustJump) {
                jumps.forEach(j => forced.add(`${j.from.r},${j.from.c}`));
            }
        }

        document.querySelectorAll('#ck-board .ck-cell').forEach(cell => {
            const dr = parseInt(cell.dataset.r);
            const dc = parseInt(cell.dataset.c);
            const br = flip ? 7-dr : dr;   // display → board coordinate
            const bc = flip ? 7-dc : dc;

            const isDark   = (dr+dc)%2===1;
            const key      = `${br},${bc}`;
            const isSel    = _sel && _sel.r===br && _sel.c===bc;
            const isMove   = selMoves.has(key);
            const isJump   = selJumps.has(key);
            const isForced = forced.has(key);

            // Square colour
            let bg = isDark ? SQ_DARK : SQ_LIGHT;
            if (isDark) {
                if (isSel)       bg = SQ_SEL;
                else if (isJump) bg = SQ_JUMP;
                else if (isMove) bg = SQ_MOVE;
            }
            cell.style.background = bg;
            cell.innerHTML = '';

            const piece = _board[br][bc];

            if (piece) {
                const pal = PALETTE[colorOf(piece)];
                const isMyPiece = owns(piece, _myColor);
                const canAct    = isMyPiece && _turn===_myColor && !_over;

                const div = document.createElement('div');
                div.className = 'ck-piece';
                div.style.background = `radial-gradient(circle at 35% 35%,${pal.fill}cc,${pal.fill})`;
                div.style.boxShadow  = `0 3px 8px ${pal.glow},inset 0 -2px 4px rgba(0,0,0,0.25)`;
                div.style.border     = `3px solid ${isSel ? '#22c55e' : isForced ? '#f59e0b' : pal.border}`;
                div.style.cursor     = canAct ? 'pointer' : 'default';
                div.textContent      = isKing(piece) ? '♛' : '';
                cell.appendChild(div);

            } else if (isMove || isJump) {
                const dot = document.createElement('div');
                dot.className = 'ck-dot';
                dot.style.background = isJump
                    ? 'rgba(245,158,11,0.55)'
                    : 'rgba(34,197,94,0.45)';
                cell.appendChild(dot);
            }
        });
    }

    // ── Click handler ─────────────────────────────────────────────────────────

    function onCellClick(displayR, displayC) {
        if (_over || _turn !== _myColor) return;

        // Convert display coords to board coords
        const flip = _myColor === B;
        const r = flip ? 7-displayR : displayR;
        const c = flip ? 7-displayC : displayC;

        const {jumps, moves} = _chain.length
            ? { jumps: continuationJumps(_board, _sel.r, _sel.c)
                    .map(j => ({from:_sel, over:j.over, to:j.to})),
                moves: [] }
            : legalMoves(_board, _myColor);

        const mustJump = jumps.length > 0;

        // Nothing selected yet
        if (!_sel) {
            const p = _board[r][c];
            if (!p || !owns(p, _myColor)) return;
            if (mustJump && !jumps.some(j => j.from.r===r && j.from.c===c)) return;
            _sel = {r,c};
            render();
            return;
        }

        // Tap selected piece again → deselect
        if (_sel.r===r && _sel.c===c && !_chain.length) {
            _sel = null;
            render();
            return;
        }

        // Attempt a jump
        if (mustJump) {
            const jump = jumps.find(j =>
                j.from.r===_sel.r && j.from.c===_sel.c &&
                j.to.r===r        && j.to.c===c);

            if (!jump) {
                // Re-select another piece that can jump (only if not mid-chain)
                if (!_chain.length) {
                    const p = _board[r][c];
                    if (p && owns(p,_myColor) && jumps.some(j=>j.from.r===r&&j.from.c===c)) {
                        _sel = {r,c};
                        render();
                    }
                }
                return;
            }

            // Record where this whole sequence started (only on first jump)
            if (!_chain.length) _origin = {r: jump.from.r, c: jump.from.c};

            _board = applyStep(_board, jump.from, jump.to, jump.over);

            const promoted = (_board[r][c]===RK && jump.from.r!==0 && r===0)
                          || (_board[r][c]===BK && jump.from.r!==7 && r===7);

            // Record this landing square
            _chain.push({r, c});

            const more = continuationJumps(_board, r, c);
            if (more.length && !promoted) {
                _sel = {r,c};
                render();
                return;   // continue multi-jump
            }

            // Sequence complete — steps = [origin, landing1, landing2, ...]
            const steps = [_origin, ..._chain];
            sendMove(steps);
            finishTurn(r, c);
            return;
        }

        // Attempt a regular move
        const mv = moves.find(m =>
            m.from.r===_sel.r && m.from.c===_sel.c &&
            m.to.r===r        && m.to.c===c);

        if (!mv) {
            const p = _board[r][c];
            if (p && owns(p,_myColor)) { _sel={r,c}; render(); }
            return;
        }

        _board = applyStep(_board, mv.from, mv.to, null);
        sendMove([mv.from, mv.to]);
        finishTurn(r, c);
    }

    // Remove consecutive duplicate waypoints
    function dedup(steps) {
        return steps.filter((s,i) =>
            i===0 || s.r!==steps[i-1].r || s.c!==steps[i-1].c);
    }

    function finishTurn(r, c) {
        _sel   = null;
        _chain = [];

        const w = checkWinner(_board, _turn);
        if (w) {
            endGame(w===_myColor ? _myRole : oppRole());
            return;
        }

        _turn = enemy(_turn);
        render();
    }

    // ── Remote move ───────────────────────────────────────────────────────────

    function handleRemoteMove(data) {
        if (_over) return;
        const steps = data.steps;
        for (let i=0; i<steps.length-1; i++) {
            const from = steps[i], to = steps[i+1];
            const dr = to.r - from.r, dc = to.c - from.c;
            const over = Math.abs(dr)===2
                ? {r: from.r+dr/2, c: from.c+dc/2}
                : null;
            _board = applyStep(_board, from, to, over);
        }

        const w = checkWinner(_board, _turn);
        if (w) {
            endGame(w===_myColor ? _myRole : oppRole());
            return;
        }

        _turn = enemy(_turn);
        render();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function sendMove(steps) {
        if (typeof MatchClient !== 'undefined')
            MatchClient.sendGameMove({sub_type:'checkers', steps});
    }

    function oppRole() {
        return _myRole === 'offerer' ? 'answerer' : 'offerer';
    }

    function endGame(winnerRole) {
        _over = true;
        const el  = document.getElementById('ck-status');
        const pip = document.getElementById('ck-turn-pip');
        if (el) {
            const won = winnerRole===_myRole;
            el.textContent = won ? '🏆 You win!' : '💀 You lose';
            el.style.color = won ? '#16a34a' : '#dc2626';
        }
        if (pip) pip.style.background = '#e5e7eb';
        if (_onGameOver) _onGameOver(winnerRole);
    }

    function resign() {
        if (_over) return;
        _over = true;
        const el = document.getElementById('ck-status');
        if (el) { el.textContent='Resigned'; el.style.color='#6b7280'; }
        if (typeof MatchClient !== 'undefined') MatchClient.sendGameQuit();
        if (_onGameOver) _onGameOver(oppRole());
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    function init(containerId, isOfferer, onGameOver) {
        destroy();
        _c          = document.getElementById(containerId);
        if (!_c) return;
        _myRole     = isOfferer ? 'offerer' : 'answerer';
        _myColor    = isOfferer ? R : B;
        _board      = makeBoard();
        _turn       = R;       // Red always goes first
        _sel        = null;
        _chain      = [];
        _origin     = null;
        _over       = false;
        _onGameOver = onGameOver || (() => {});
        buildUI();
        render();
    }

    function destroy() {
        if (_c) _c.innerHTML = '';
        _c     = null;
        _board = null;
        _sel   = null;
        _chain = [];
        _origin= null;
        _over  = false;
    }

    return { init, handleRemoteMove, destroy };

})();