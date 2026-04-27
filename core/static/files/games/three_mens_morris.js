/**
 * static/js/games/three_mens_morris.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone Three Men's Morris (3MM) game engine.
 *
 * API surface:
 *   ThreeMensMorris.init(containerId, isOfferer, onGameOver)
 *   ThreeMensMorris.handleRemoteMove(data)
 *   ThreeMensMorris.destroy()
 *
 * UX improvements:
 *   • Selected piece glows and pulses with a ring highlight.
 *   • Valid destination cells show a subtle drop-target indicator.
 *   • Drag-to-move: grab a piece and drop it on a valid cell (mouse & touch).
 *   • Click-to-move still works as before.
 *
 * Board layout (indices):
 *   0 — 1 — 2
 *   |   |   |
 *   3 — 4 — 5
 *   |   |   |
 *   6 — 7 — 8
 */

const ThreeMensMorris = (() => {

    const ADJACENT = {
        0: [1, 3, 4],
        1: [0, 2, 4],
        2: [1, 4, 5],
        3: [0, 4, 6],
        4: [0,1,2,3,5,6,7,8],
        5: [2, 4, 8],
        6: [3, 4, 7],
        7: [4, 6, 8],
        8: [4, 5, 7],
    };

    const WIN_LINES = [
        [0,1,2],[3,4,5],[6,7,8],
        [0,3,6],[1,4,7],[2,5,8],
        [0,4,8],[2,4,6]
    ];

    let _container, _myRole, _currentTurn, _board;
    let _phase, _selected, _gameOver, _onGameOver;

    // ── Drag state ────────────────────────────────────────────────────────────
    let _dragFrom   = null;   // board index being dragged
    let _dragEl     = null;   // floating clone element
    let _boardWrap  = null;   // reference for bounding rect

    function init(containerId, isOfferer, onGameOver) {
        destroy();

        _container = document.getElementById(containerId);
        if (!_container) return;

        _myRole      = isOfferer ? "offerer" : "answerer";
        _currentTurn = "offerer";
        _board       = Array(9).fill(null);
        _phase       = "place";
        _selected    = null;
        _gameOver    = false;
        _onGameOver  = onGameOver || (()=>{});

        // Inject shared styles once
        if (!document.getElementById("tmm-styles")) {
            const style = document.createElement("style");
            style.id = "tmm-styles";
            style.textContent = `
                @keyframes tmm-pulse {
                    0%,100% { box-shadow: 0 0 0 3px rgba(99,102,241,0.6), 0 0 0 6px rgba(99,102,241,0.2); }
                    50%     { box-shadow: 0 0 0 4px rgba(99,102,241,0.8), 0 0 0 9px rgba(99,102,241,0.1); }
                }
                @keyframes tmm-place {
                    0%   { transform: scale(0.4); opacity:0; }
                    60%  { transform: scale(1.15); }
                    100% { transform: scale(1);   opacity:1; }
                }
                @keyframes tmm-dropring {
                    0%,100% { transform: scale(1);   opacity:0.55; }
                    50%     { transform: scale(1.18); opacity:0.9;  }
                }
                .tmm-piece {
                    width:72%; aspect-ratio:1; border-radius:50%;
                    display:flex; align-items:center; justify-content:center;
                    transition: transform 0.15s ease, box-shadow 0.15s ease;
                    cursor: grab;
                    user-select: none;
                    -webkit-user-select: none;
                    position: relative;
                }
                .tmm-piece.selected {
                    transform: scale(1.12);
                    animation: tmm-pulse 1.2s ease-in-out infinite;
                    z-index: 2;
                }
                .tmm-piece.placed {
                    animation: tmm-place 0.28s cubic-bezier(0.34,1.4,0.64,1) forwards;
                }
                .tmm-drop-ring {
                    width:38%; aspect-ratio:1; border-radius:50%;
                    border: 2.5px dashed rgba(99,102,241,0.55);
                    animation: tmm-dropring 0.9s ease-in-out infinite;
                }
                .tmm-empty-dot {
                    width:22%; aspect-ratio:1; border-radius:50%;
                    background:#e5e5e5;
                }
                .tmm-drag-clone {
                    position: fixed;
                    width: 52px; height: 52px;
                    border-radius: 50%;
                    pointer-events: none;
                    z-index: 9999;
                    opacity: 0.82;
                    transform: translate(-50%,-50%) scale(1.15);
                    transition: none;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.22);
                }
            `;
            document.head.appendChild(style);
        }

        buildUI();
        render();
    }

    function buildUI() {
        _container.innerHTML = "";
        _container.style.cssText = `
            display:flex; flex-direction:column;
            align-items:center; justify-content:center;
            gap:1rem; padding:1rem;
        `;

        // Turn indicator
        const indicator = document.createElement("div");
        indicator.id = "tmm-indicator";
        indicator.style.cssText = `font-weight:600; font-size:0.9rem;`;
        _container.appendChild(indicator);

        // Board wrapper
        const boardWrap = document.createElement("div");
        boardWrap.setAttribute("data-board", "true");
        boardWrap.style.cssText = `
            position:relative; width:min(340px,90vw); aspect-ratio:1;
        `;
        _boardWrap = boardWrap;

        // SVG grid lines
        const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
        svg.setAttribute("viewBox","0 0 100 100");
        svg.style.cssText = `position:absolute;inset:0;width:100%;height:100%;`;

        [
            [33.33,0,33.33,100], [66.66,0,66.66,100],
            [0,33.33,100,33.33], [0,66.66,100,66.66],
            [0,0,100,100],       [100,0,0,100],
        ].forEach(([x1,y1,x2,y2])=>{
            const l = document.createElementNS("http://www.w3.org/2000/svg","line");
            l.setAttribute("x1",x1); l.setAttribute("y1",y1);
            l.setAttribute("x2",x2); l.setAttribute("y2",y2);
            l.setAttribute("stroke","#e5e5e5");
            l.setAttribute("stroke-width","2");
            svg.appendChild(l);
        });
        boardWrap.appendChild(svg);

        // Cell grid
        const grid = document.createElement("div");
        grid.id = "tmm-grid";
        grid.style.cssText = `
            position:absolute; inset:0;
            display:grid;
            grid-template-columns:repeat(3,1fr);
            grid-template-rows:repeat(3,1fr);
        `;

        for (let i = 0; i < 9; i++) {
            const cell = document.createElement("div");
            cell.dataset.idx = i;
            cell.style.cssText = `
                display:flex; align-items:center; justify-content:center;
                width:100%; height:100%;
            `;
            cell.addEventListener("click", () => handleClick(i));

            // Drag-over / drop listeners (for piece-drop targets)
            cell.addEventListener("dragover",  e => onDragOver(e, i));
            cell.addEventListener("dragleave", e => onDragLeave(e, i));
            cell.addEventListener("drop",      e => onDrop(e, i));

            // Touch drop detection handled globally (see _bindDragListeners)
            grid.appendChild(cell);
        }

        boardWrap.appendChild(grid);
        _container.appendChild(boardWrap);

        // Quit button
        const quit = document.createElement("button");
        quit.textContent = "Quit (−1 pt)";
        quit.style.cssText = `
            padding:6px 18px; border-radius:40px;
            border:1px solid #dc2626; background:white;
            color:#dc2626; cursor:pointer;
        `;
        quit.onclick = quitGame;
        _container.appendChild(quit);
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function render() {
        const ind = document.getElementById("tmm-indicator");
        if (ind && !_gameOver) {
            ind.textContent = _currentTurn === _myRole ? "Your turn" : "Opponent's turn";
        }

        document.querySelectorAll("[data-idx]").forEach(cell => {
            const i     = parseInt(cell.dataset.idx, 10);
            const owner = _board[i];
            const isSel = _selected === i;
            const isValidDrop = _phase === "move" && _selected !== null
                && _board[i] === null
                && ADJACENT[_selected].includes(i);

            cell.innerHTML = "";

            if (owner) {
                const color = owner === "offerer" ? "#ef4444" : "#3b82f6";
                const piece = document.createElement("div");
                piece.className = "tmm-piece" + (isSel ? " selected" : "");
                piece.style.background = color;

                // Drag events on piece (mouse)
                if (owner === _myRole && _phase === "move" && !_gameOver && _currentTurn === _myRole) {
                    piece.draggable = true;
                    piece.addEventListener("dragstart", e => onDragStart(e, i));
                    piece.addEventListener("dragend",   () => onDragEnd());
                    // Touch events
                    piece.addEventListener("touchstart", e => onTouchStart(e, i), { passive: false });
                    piece.addEventListener("touchmove",  e => onTouchMove(e),      { passive: false });
                    piece.addEventListener("touchend",   e => onTouchEnd(e),        { passive: false });
                }

                cell.appendChild(piece);
                cell.style.cursor = isClickable(i) ? "pointer" : "default";
            } else if (isValidDrop) {
                const ring = document.createElement("div");
                ring.className = "tmm-drop-ring";
                cell.appendChild(ring);
                cell.style.cursor = "pointer";
            } else {
                const dot = document.createElement("div");
                dot.className = "tmm-empty-dot";
                cell.appendChild(dot);
                cell.style.cursor = isClickable(i) ? "pointer" : "default";
            }
        });
    }

    // ── Click logic ───────────────────────────────────────────────────────────
    function isClickable(i) {
        if (_gameOver) return false;
        if (_currentTurn !== _myRole) return false;
        if (_phase === "place") return _board[i] === null;
        if (_selected === null) return _board[i] === _myRole;
        if (i === _selected) return true;
        return _board[i] === null && ADJACENT[_selected].includes(i);
    }

    function handleClick(i) {
        if (!isClickable(i)) return;

        if (_phase === "place") {
            place(i, _myRole, true);
            sendMove(null, i);
        } else {
            if (_selected === null) {
                _selected = i;
            } else if (i === _selected) {
                _selected = null;
            } else {
                const from = _selected;
                _selected = null;
                move(from, i, _myRole);
                sendMove(from, i);
            }
        }
        render();
    }

    // ── Drag (mouse) ──────────────────────────────────────────────────────────
    function onDragStart(e, idx) {
        if (_gameOver || _currentTurn !== _myRole) { e.preventDefault(); return; }
        _dragFrom = idx;
        _selected = idx;
        // Create invisible drag image so browser doesn't show default ghost
        const ghost = document.createElement("div");
        ghost.style.cssText = "position:fixed;top:-999px;left:-999px;width:1px;height:1px;";
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        setTimeout(() => document.body.removeChild(ghost), 0);

        // Custom floating clone
        _spawnDragClone(e.clientX, e.clientY, _myRole === "offerer" ? "#ef4444" : "#3b82f6");

        // Update clone position on mousemove globally
        document.addEventListener("dragover", _moveDragClone);

        render();
    }

    function onDragOver(e, idx) {
        const valid = _dragFrom !== null && _board[idx] === null && ADJACENT[_dragFrom].includes(idx);
        if (valid) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
        }
    }

    function onDragLeave(e, idx) { /* ring handled by render */ }

    function onDrop(e, idx) {
        e.preventDefault();
        if (_dragFrom === null) return;
        const from = _dragFrom;
        _dragFrom  = null;
        _selected  = null;
        _removeDragClone();
        document.removeEventListener("dragover", _moveDragClone);
        if (_board[idx] === null && ADJACENT[from].includes(idx)) {
            move(from, idx, _myRole);
            sendMove(from, idx);
        }
        render();
    }

    function onDragEnd() {
        _dragFrom = null;
        _selected = null;
        _removeDragClone();
        document.removeEventListener("dragover", _moveDragClone);
        render();
    }

    // ── Touch drag ────────────────────────────────────────────────────────────
    function onTouchStart(e, idx) {
        if (_gameOver || _currentTurn !== _myRole) return;
        e.preventDefault();
        _dragFrom = idx;
        _selected = idx;
        const t = e.touches[0];
        _spawnDragClone(t.clientX, t.clientY, _myRole === "offerer" ? "#ef4444" : "#3b82f6");
        render();
    }

    function onTouchMove(e) {
        if (_dragFrom === null) return;
        e.preventDefault();
        const t = e.touches[0];
        if (_dragEl) {
            _dragEl.style.left = t.clientX + "px";
            _dragEl.style.top  = t.clientY + "px";
        }
    }

    function onTouchEnd(e) {
        if (_dragFrom === null) return;
        e.preventDefault();
        const t = e.changedTouches[0];
        _removeDragClone();

        // Find which cell the finger lifted over
        const el = document.elementFromPoint(t.clientX, t.clientY);
        const cell = el ? el.closest("[data-idx]") : null;
        const from = _dragFrom;
        _dragFrom  = null;
        _selected  = null;

        if (cell) {
            const idx = parseInt(cell.dataset.idx, 10);
            if (_board[idx] === null && ADJACENT[from].includes(idx)) {
                move(from, idx, _myRole);
                sendMove(from, idx);
            }
        }
        render();
    }

    // ── Drag clone helpers ────────────────────────────────────────────────────
    function _spawnDragClone(x, y, color) {
        _removeDragClone();
        _dragEl = document.createElement("div");
        _dragEl.className = "tmm-drag-clone";
        _dragEl.style.background = color;
        _dragEl.style.left = x + "px";
        _dragEl.style.top  = y + "px";
        document.body.appendChild(_dragEl);
    }

    function _moveDragClone(e) {
        if (_dragEl) {
            _dragEl.style.left = e.clientX + "px";
            _dragEl.style.top  = e.clientY + "px";
        }
    }

    function _removeDragClone() {
        if (_dragEl) { _dragEl.remove(); _dragEl = null; }
    }

    // ── Game logic ────────────────────────────────────────────────────────────
    function place(i, role, animate = false) {
        _board[i] = role;

        if (checkWin(role)) return endGame(role);
        if (_board.filter(x => x).length === 6) _phase = "move";
        switchTurn();
    }

    function move(from, to, role) {
        _board[to]   = role;
        _board[from] = null;
        if (checkWin(role)) return endGame(role);
        switchTurn();
    }

    function checkWin(role) {
        return WIN_LINES.some(line => line.every(i => _board[i] === role));
    }

    function switchTurn() {
        _currentTurn = _currentTurn === "offerer" ? "answerer" : "offerer";
    }

    function endGame(winner) {
        _gameOver = true;
        const win = winner === _myRole;
        showOverlay(win ? "You win 🎉" : "You lose");
        if (_onGameOver) _onGameOver(winner);
    }

    function showOverlay(text) {
        const board = _container.querySelector("[data-board]");
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position:absolute; inset:0;
            background:rgba(255,255,255,0.92);
            display:flex; align-items:center; justify-content:center;
            font-weight:700; font-size:1.2rem;
            animation: tmm-place 0.3s ease;
        `;
        overlay.textContent = text;
        board.appendChild(overlay);
    }

    function sendMove(from, to) {
        if (typeof MatchClient !== "undefined") {
            MatchClient.sendGameMove({ sub_type: "3mm", from, to });
        }
    }

    function handleRemoteMove(data) {
        if (_gameOver) return;
        const role = _myRole === "offerer" ? "answerer" : "offerer";
        if (_phase === "place") {
            place(data.to, role);
        } else {
            move(data.from, data.to, role);
        }
        render();
    }

    function quitGame() {
        _gameOver = true;
        _removeDragClone();
        if (typeof MatchClient !== "undefined") MatchClient.sendGameQuit();
        showOverlay("You quit");
    }

    function destroy() {
        _removeDragClone();
        document.removeEventListener("dragover", _moveDragClone);
        _dragFrom = null; _dragEl = null;
        if (_container) _container.innerHTML = "";
    }

    return { init, handleRemoteMove, destroy };

})();