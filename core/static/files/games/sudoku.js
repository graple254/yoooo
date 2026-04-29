/**
 * static/js/games/sudoku.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Collaborative-competitive Sudoku engine for two players.
 *
 * sub_types relayed via MatchClient.sendGameMove:
 *   "sudoku_ready"   answerer → offerer  (UI mounted; please send puzzle)
 *   "sudoku_init"    offerer → answerer  { puzzle, solution }
 *   "sudoku_fill"    either  → other     { idx, digit }
 *   "sudoku_erase"   either  → other     { idx }
 *   "sudoku_mistake" either  → other     { mistakes }
 *
 * Rules:
 *   • Race to fill cells correctly. Correct fill = +1 pt.
 *   • Wrong guess flashes red, increments mistakes, is NOT placed.
 *   • Hit 3 mistakes → immediate loss.
 *   • Board fills before 3 mistakes → most fills wins; tie = draw.
 *
 * Features:
 *   • Row/col/box highlight on cell select.
 *   • Same-digit highlight across board when a cell is selected.
 *   • Numpad badges showing remaining count per digit (button dims at 0).
 *   • ❤️ heart display tracking your 3 lives.
 */

const Sudoku = (() => {

    let _container, _myRole, _oppRole, _onGameOver;
    let _puzzle, _solution, _board;
    let _scores, _mistakes, _gameOver;
    let _selected, _isOfferer, _puzzleQueued;

    // ── Generator ────────────────────────────────────────────────────────────
    function generateSolved() {
        const grid = Array(81).fill(0);
        function possible(idx, n) {
            const r = Math.floor(idx / 9), c = idx % 9;
            for (let i = 0; i < 9; i++) {
                if (grid[r * 9 + i] === n) return false;
                if (grid[i * 9 + c] === n) return false;
            }
            const br = Math.floor(r/3)*3, bc = Math.floor(c/3)*3;
            for (let dr = 0; dr < 3; dr++)
                for (let dc = 0; dc < 3; dc++)
                    if (grid[(br+dr)*9+(bc+dc)] === n) return false;
            return true;
        }
        function solve(idx) {
            if (idx === 81) return true;
            const digits = [1,2,3,4,5,6,7,8,9].sort(() => Math.random() - 0.5);
            for (const d of digits) {
                if (possible(idx, d)) {
                    grid[idx] = d;
                    if (solve(idx+1)) return true;
                    grid[idx] = 0;
                }
            }
            return false;
        }
        solve(0);
        return grid;
    }

    function makePuzzle(solution, clues = 36) {
        const puzzle = [...solution];
        const pos = Array.from({length:81},(_,i)=>i).sort(()=>Math.random()-0.5);
        let removed = 0;
        for (const p of pos) {
            if (removed >= 81 - clues) break;
            puzzle[p] = 0; removed++;
        }
        return puzzle;
    }

    function remainingCount(digit) {
        if (!_board || !_solution) return 0;
        const total  = _solution.filter(d => d === digit).length;
        const placed = _board.filter(c => c.digit === digit).length;
        return Math.max(0, total - placed);
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function init(containerId, isOfferer, onGameOver) {
        destroy();
        _container   = document.getElementById(containerId);
        if (!_container) return;

        _isOfferer   = isOfferer;
        _myRole      = isOfferer ? 'offerer' : 'answerer';
        _oppRole     = isOfferer ? 'answerer' : 'offerer';
        _onGameOver  = onGameOver || (() => {});
        _scores      = { offerer:0, answerer:0 };
        _mistakes    = { offerer:0, answerer:0 };
        _gameOver    = false;
        _selected    = null;
        _puzzleQueued = null;

        buildUI();

        if (isOfferer) {
            _solution = generateSolved();
            _puzzle   = makePuzzle(_solution);
            _puzzleQueued = { puzzle: _puzzle, solution: _solution };
            _board = _puzzle.map(d => ({ digit: d||null, given: d!==0, filler: null }));
            render();
        } else {
            _showLoading();
            // Signal offerer that answerer's UI is mounted and ready
            _send({ sub_type: 'sudoku_ready' });
        }
    }

    function _showLoading() {
        const wrap = document.getElementById('sdk-board-wrap');
        if (!wrap || document.getElementById('sdk-loading')) return;
        const el = document.createElement('div');
        el.id = 'sdk-loading';
        el.style.cssText = `
            position:absolute;inset:0;display:flex;flex-direction:column;
            align-items:center;justify-content:center;gap:12px;
            background:white;z-index:10;border-radius:12px;
        `;
        el.innerHTML = `
            <div style="
                width:32px;height:32px;border-radius:50%;
                border:3px solid #e5e7eb;border-top-color:#6366f1;
                animation:sdk-spin 0.8s linear infinite;
            "></div>
            <span style="font-size:0.85rem;color:#888;">Loading puzzle…</span>
            <style>@keyframes sdk-spin{to{transform:rotate(360deg)}}</style>
        `;
        wrap.appendChild(el);
    }

    function _send(obj) {
        if (typeof MatchClient !== 'undefined') MatchClient.sendGameMove(obj);
    }

    // ── Build UI ──────────────────────────────────────────────────────────────
    function buildUI() {
        _container.innerHTML = '';
        _container.style.cssText = `
            display:flex;flex-direction:column;align-items:center;
            gap:0.55rem;padding:0.75rem;user-select:none;
        `;

        // Top bar
        const bar = document.createElement('div');
        bar.style.cssText = `
            display:flex;align-items:center;justify-content:space-between;
            width:min(380px,94vw);gap:8px;
        `;
        bar.innerHTML = `
            <span id="sdk-status" style="
                font-weight:600;font-size:0.76rem;color:#374151;
                flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
            ">—</span>
            <div style="
                display:flex;align-items:center;gap:0;flex-shrink:0;
                background:#f3f4f6;border-radius:20px;padding:3px;
                font-size:0.72rem;font-weight:600;
            ">
                <div style="
                    display:flex;align-items:center;gap:5px;
                    padding:3px 10px;border-radius:16px;
                    background:white;box-shadow:0 1px 3px rgba(0,0,0,0.08);
                ">
                    <span style="width:8px;height:8px;border-radius:50%;background:#2563eb;display:inline-block;flex-shrink:0;"></span>
                    <span style="color:#374151;">You</span>
                    <strong id="sdk-my-score" style="color:#2563eb;min-width:14px;text-align:center;">0</strong>
                    <span id="sdk-my-err" style="color:#dc2626;font-size:0.64rem;"></span>
                </div>
                <div style="width:1px;height:16px;background:#e5e7eb;margin:0 2px;"></div>
                <div style="
                    display:flex;align-items:center;gap:5px;
                    padding:3px 10px;border-radius:16px;
                ">
                    <span style="width:8px;height:8px;border-radius:50%;background:#7c3aed;display:inline-block;flex-shrink:0;"></span>
                    <span style="color:#374151;">Them</span>
                    <strong id="sdk-op-score" style="color:#7c3aed;min-width:14px;text-align:center;">0</strong>
                    <span id="sdk-op-err" style="color:#dc2626;font-size:0.64rem;"></span>
                </div>
            </div>
        `;
        _container.appendChild(bar);

        // Board
        const wrap = document.createElement('div');
        wrap.id = 'sdk-board-wrap';
        wrap.style.cssText = `
            position:relative;width:min(380px,94vw);aspect-ratio:1;
            border:2.5px solid #1f2937;border-radius:14px;overflow:hidden;
            box-shadow:0 6px 32px rgba(0,0,0,0.13), 0 1px 4px rgba(0,0,0,0.08);
        `;
        const grid = document.createElement('div');
        grid.id = 'sdk-grid';
        grid.style.cssText = `
            display:grid;grid-template-columns:repeat(9,1fr);
            grid-template-rows:repeat(9,1fr);width:100%;height:100%;
        `;
        for (let i = 0; i < 81; i++) {
            const cell = document.createElement('div');
            cell.dataset.idx = i;
            const r = Math.floor(i/9), c = i%9;
            const bt = r%3===0 ? '2px' : '0.5px';
            const bl = c%3===0 ? '2px' : '0.5px';
            const bb = r===8 ? '0' : (r%3===2 ? '2px' : '0.5px');
            const br = c===8 ? '0' : (c%3===2 ? '2px' : '0.5px');
            cell.style.cssText = `
                display:flex;align-items:center;justify-content:center;
                font-size:clamp(0.75rem,2.6vw,1.05rem);font-weight:600;
                border-top:${bt} solid #9ca3af;border-left:${bl} solid #9ca3af;
                border-bottom:${bb} solid #9ca3af;border-right:${br} solid #9ca3af;
                cursor:pointer;transition:background 0.08s;
            `;
            cell.addEventListener('click', () => handleCellClick(i));
            grid.appendChild(cell);
        }
        wrap.appendChild(grid);
        _container.appendChild(wrap);

        // Numpad
        const pad = document.createElement('div');
        pad.id = 'sdk-pad';
        pad.style.cssText = `
            display:flex;gap:4px;flex-wrap:nowrap;justify-content:center;
            width:min(380px,94vw);
        `;
        for (let d = 1; d <= 9; d++) {
            const wr = document.createElement('div');
            wr.style.cssText = 'position:relative;flex:1;max-width:36px;';
            const btn = document.createElement('button');
            btn.dataset.padDigit = d;
            btn.textContent = d;
            btn.style.cssText = `
                width:100%;aspect-ratio:1;border-radius:10px;
                border:1.5px solid #e5e7eb;background:#f9fafb;
                font-size:clamp(0.85rem,2.5vw,1rem);font-weight:700;
                cursor:pointer;transition:all 0.12s;font-family:inherit;
                color:#1f2937;box-shadow:0 1px 2px rgba(0,0,0,0.06);
            `;
            btn.onmouseenter = () => { if(!btn.disabled){btn.style.background='#eff6ff';btn.style.borderColor='#3b82f6';btn.style.color='#2563eb';btn.style.transform='scale(1.06)';} };
            btn.onmouseleave = () => { if(!btn.disabled){btn.style.background='#f9fafb';btn.style.borderColor='#e5e7eb';btn.style.color='#1f2937';btn.style.transform='';} };
            btn.onmousedown  = () => { if(!btn.disabled) btn.style.transform='scale(0.94)'; };
            btn.onmouseup    = () => { if(!btn.disabled) btn.style.transform='scale(1.06)'; };
            btn.onclick = () => handleDigit(d);
            const badge = document.createElement('span');
            badge.dataset.padBadge = d;
            badge.style.cssText = `
                position:absolute;top:-5px;right:-5px;
                background:#6366f1;color:white;font-size:0.57rem;font-weight:700;
                width:14px;height:14px;border-radius:50%;
                display:none;align-items:center;justify-content:center;
                pointer-events:none;border:1.5px solid white;
            `;
            wr.appendChild(btn);
            wr.appendChild(badge);
            pad.appendChild(wr);
        }
        // Erase
        const erWr = document.createElement('div');
        erWr.style.cssText = 'flex:1;max-width:36px;';
        const er = document.createElement('button');
        er.textContent = '⌫';
        er.style.cssText = `
            width:100%;aspect-ratio:1;border-radius:8px;
            border:1.5px solid #fecaca;background:#fff5f5;
            font-size:clamp(0.85rem,2.5vw,1rem);cursor:pointer;
            transition:all 0.15s;font-family:inherit;
        `;
        er.onmouseenter = ()=>{ er.style.background='#fee2e2'; };
        er.onmouseleave = ()=>{ er.style.background='#fff5f5'; };
        er.onclick = handleErase;
        erWr.appendChild(er);
        pad.appendChild(erWr);
        _container.appendChild(pad);

        // Lives display
        const hearts = document.createElement('div');
        hearts.style.cssText = `
            display:flex;align-items:center;gap:8px;
            font-size:0.72rem;color:#6b7280;font-weight:500;
        `;
        hearts.innerHTML = `
            <span>Lives</span>
            <div id="sdk-hearts" style="display:flex;gap:4px;"></div>
            <span id="sdk-lives-label" style="font-size:0.68rem;color:#9ca3af;"></span>
        `;
        _container.appendChild(hearts);

        // Give up
        const quit = document.createElement('button');
        quit.textContent = 'Give up';
        quit.style.cssText = `
            padding:4px 16px;border-radius:40px;
            border:1px solid #dc2626;background:white;color:#dc2626;
            font-size:0.75rem;cursor:pointer;transition:all 0.2s;
        `;
        quit.onmouseenter = ()=>{quit.style.background='#dc2626';quit.style.color='white';};
        quit.onmouseleave = ()=>{quit.style.background='white';quit.style.color='#dc2626';};
        quit.onclick = quitGame;
        _container.appendChild(quit);
    }

    // ── Render ────────────────────────────────────────────────────────────────
    function render() {
        if (!_board) return;

        // Status
        const statusEl = document.getElementById('sdk-status');
        if (statusEl && !_gameOver) {
            const rem = _board.filter(c => !c.given && !c.digit).length;
            statusEl.textContent = rem === 0 ? '✅ Complete!' : `${rem} cells left`;
            statusEl.style.color = rem === 0 ? '#16a34a' : '#374151';
        }

        // Scores + errors
        const myEl = document.getElementById('sdk-my-score');
        const opEl = document.getElementById('sdk-op-score');
        const myErrEl = document.getElementById('sdk-my-err');
        const opErrEl = document.getElementById('sdk-op-err');
        if (myEl) myEl.textContent = _scores[_myRole];
        if (opEl) opEl.textContent = _scores[_oppRole];
        if (myErrEl) myErrEl.textContent = _mistakes[_myRole] > 0 ? ` ✕${_mistakes[_myRole]}` : '';
        if (opErrEl) opErrEl.textContent = _mistakes[_oppRole] > 0 ? ` ✕${_mistakes[_oppRole]}` : '';

        // Hearts — segmented pips
        const heartsEl = document.getElementById('sdk-hearts');
        const livesLbl = document.getElementById('sdk-lives-label');
        if (heartsEl) {
            const lives = Math.max(0, 3 - _mistakes[_myRole]);
            heartsEl.innerHTML = '';
            for (let h = 0; h < 3; h++) {
                const pip = document.createElement('div');
                const alive = h < lives;
                pip.style.cssText = `
                    width:18px;height:18px;border-radius:50%;
                    display:flex;align-items:center;justify-content:center;
                    font-size:12px;line-height:1;
                    background:${alive ? '#fee2e2' : '#f3f4f6'};
                    border:1.5px solid ${alive ? '#fca5a5' : '#e5e7eb'};
                    transition:all 0.25s;
                `;
                pip.textContent = alive ? '❤️' : '🩶';
                heartsEl.appendChild(pip);
            }
            if (livesLbl) {
                livesLbl.textContent = lives === 0 ? 'No lives left!' : lives === 1 ? '1 left' : '';
                livesLbl.style.color = lives <= 1 ? '#dc2626' : '#9ca3af';
            }
        }

        // Selected cell context
        const selDigit = (_selected !== null && _board[_selected]?.digit) || null;
        const sr = _selected !== null ? Math.floor(_selected/9) : -1;
        const sc = _selected !== null ? _selected%9 : -1;
        const sbr = sr >= 0 ? Math.floor(sr/3) : -1;
        const sbc = sc >= 0 ? Math.floor(sc/3) : -1;

        // Cells
        document.querySelectorAll('#sdk-grid [data-idx]').forEach(cell => {
            const i = parseInt(cell.dataset.idx);
            const entry = _board[i];
            if (!entry) return;

            const cr = Math.floor(i/9), cc = i%9;
            const isSel      = _selected === i;
            const sameGroup  = _selected !== null && !isSel &&
                (cr===sr || cc===sc || (Math.floor(cr/3)===sbr && Math.floor(cc/3)===sbc));
            const sameDigit  = selDigit !== null && entry.digit === selDigit && !isSel;

            let bg;
            if (isSel)          bg = '#c7d2fe';           // indigo — selected
            else if (sameDigit) bg = '#bfdbfe';           // blue — matching digit
            else if (sameGroup) bg = entry.given ? '#e5e7eb' : '#f0f4ff';
            else if (entry.given) bg = '#f3f4f6';
            else                bg = 'white';

            cell.style.background = bg;
            cell.style.cursor = entry.given ? 'default' : 'pointer';

            if (entry.digit) {
                cell.textContent = entry.digit;
                cell.style.color = entry.given
                    ? '#111827'
                    : entry.filler === _myRole ? '#2563eb' : '#7c3aed';
                cell.style.fontWeight = entry.given ? '800' : '600';
            } else {
                cell.textContent = '';
            }
        });

        // Numpad badges
        for (let d = 1; d <= 9; d++) {
            const btn   = document.querySelector(`[data-pad-digit="${d}"]`);
            const badge = document.querySelector(`[data-pad-badge="${d}"]`);
            if (!btn || !badge) continue;
            const rem = remainingCount(d);
            if (rem === 0) {
                btn.disabled = true;
                btn.style.opacity = '0.28';
                btn.style.cursor  = 'not-allowed';
                badge.style.display = 'none';
            } else {
                btn.disabled = false;
                btn.style.opacity = '1';
                btn.style.cursor  = 'pointer';
                badge.textContent   = rem;
                badge.style.display = 'flex';
            }
        }
    }

    // ── Interaction ───────────────────────────────────────────────────────────
    function handleCellClick(i) {
        if (_gameOver || !_board) return;
        _selected = (_selected === i) ? null : i;
        render();
    }

    function handleDigit(d) {
        if (_gameOver || _selected === null || !_board) return;
        const entry = _board[_selected];
        if (entry.given || entry.digit) return;

        if (_solution[_selected] === d) {
            entry.digit  = d;
            entry.filler = _myRole;
            _scores[_myRole]++;
            _send({ sub_type:'sudoku_fill', idx:_selected, digit:d });
            render();
            checkComplete();
        } else {
            _mistakes[_myRole]++;
            // Include wrongIdx + wrongDigit so the opponent's board also flashes
            _send({ sub_type:'sudoku_mistake', mistakes:_mistakes[_myRole], wrongIdx:_selected, wrongDigit:d });
            flashWrong(_selected, d);
            render();
            if (_mistakes[_myRole] >= 3) endGame(_oppRole);
        }
    }

    function handleErase() {
        if (_gameOver || _selected === null || !_board) return;
        const entry = _board[_selected];
        if (entry.given || !entry.digit || entry.filler !== _myRole) return;
        entry.digit = null; entry.filler = null;
        _scores[_myRole] = Math.max(0, _scores[_myRole] - 1);
        _send({ sub_type:'sudoku_erase', idx:_selected });
        render();
    }

    function flashWrong(idx, digit) {
        const cell = document.querySelector(`#sdk-grid [data-idx="${idx}"]`);
        if (!cell) return;

        // Inject shared keyframes once
        if (!document.getElementById('sdk-flash-style')) {
            const s = document.createElement('style');
            s.id = 'sdk-flash-style';
            s.textContent = `
                @keyframes sdk-shake {
                    0%,100%{ transform:translateX(0); }
                    20%    { transform:translateX(-4px); }
                    40%    { transform:translateX(4px); }
                    60%    { transform:translateX(-3px); }
                    80%    { transform:translateX(2px); }
                }
                @keyframes sdk-fade-out {
                    0%   { opacity:1; transform:scale(1); }
                    70%  { opacity:0.85; transform:scale(1.04); }
                    100% { opacity:0; transform:scale(0.88); }
                }
                @keyframes sdk-x-pop {
                    0%   { opacity:0; transform:translate(-50%,-50%) scale(0.4); }
                    40%  { opacity:1; transform:translate(-50%,-50%) scale(1.2); }
                    100% { opacity:1; transform:translate(-50%,-50%) scale(1); }
                }
                .sdk-wrong-cell {
                    position: relative;
                    animation: sdk-shake 0.38s ease;
                }
                .sdk-wrong-digit {
                    color: #dc2626 !important;
                    font-weight: 700 !important;
                }
                .sdk-wrong-x {
                    position: absolute;
                    top: 50%; left: 50%;
                    transform: translate(-50%, -50%);
                    font-size: 1.6em;
                    font-weight: 900;
                    color: #dc2626;
                    line-height: 1;
                    pointer-events: none;
                    animation: sdk-x-pop 0.22s cubic-bezier(0.34,1.56,0.64,1) forwards;
                    text-shadow: 0 0 6px rgba(220,38,38,0.35);
                    z-index: 5;
                }
                .sdk-wrong-bg {
                    background: #fee2e2 !important;
                }
                .sdk-fading {
                    animation: sdk-fade-out 0.45s ease forwards;
                }
            `;
            document.head.appendChild(s);
        }

        const DURATION = 1400; // ms visible before fade

        // Show wrong digit
        cell.textContent = digit ?? '';
        cell.classList.add('sdk-wrong-cell', 'sdk-wrong-digit', 'sdk-wrong-bg');

        // Overlay ✕
        const xEl = document.createElement('span');
        xEl.className = 'sdk-wrong-x';
        xEl.textContent = '✕';
        cell.style.position = 'relative';
        cell.appendChild(xEl);

        // After DURATION ms start fade, then clear
        const fadeTimer = setTimeout(() => {
            xEl.classList.add('sdk-fading');
            cell.style.transition = 'background 0.45s ease, color 0.45s ease';
            setTimeout(() => {
                cell.classList.remove('sdk-wrong-cell','sdk-wrong-digit','sdk-wrong-bg');
                cell.style.transition = '';
                if (xEl.parentNode === cell) cell.removeChild(xEl);
                cell.textContent = '';
                render();
            }, 450);
        }, DURATION);

        // Safety: if cell gets re-rendered before timer fires, clean up
        cell._sdkFlashTimer = fadeTimer;
    }

    // ── Win check ─────────────────────────────────────────────────────────────
    function checkComplete() {
        if (!_board || !_board.every(c => c.digit !== null)) return;
        const my = _scores[_myRole], op = _scores[_oppRole];
        endGame(my > op ? _myRole : op > my ? _oppRole : 'draw');
    }

    function endGame(winnerRole) {
        if (_gameOver) return;
        _gameOver = true;
        const statusEl = document.getElementById('sdk-status');
        if (statusEl) {
            const isDraw = winnerRole === 'draw';
            statusEl.textContent = isDraw ? '🤝 Draw!' : winnerRole===_myRole ? '🏆 You win!' : '💀 You lose';
            statusEl.style.color = isDraw ? '#6b7280' : winnerRole===_myRole ? '#16a34a' : '#dc2626';
        }
        if (_onGameOver) _onGameOver(winnerRole);
    }

    // ── Remote ────────────────────────────────────────────────────────────────
    function handleRemoteMove(data) {

        if (data.sub_type === 'sudoku_ready') {
            // Answerer is ready — offerer now sends the puzzle
            if (_isOfferer && _puzzleQueued) {
                _send({
                    sub_type: 'sudoku_init',
                    puzzle:   _puzzleQueued.puzzle,
                    solution: _puzzleQueued.solution,
                });
                _puzzleQueued = null;
            }
            return;
        }

        if (data.sub_type === 'sudoku_init') {
            _solution = data.solution;
            _puzzle   = data.puzzle;
            _board    = _puzzle.map(d => ({ digit:d||null, given:d!==0, filler:null }));
            const loading = document.getElementById('sdk-loading');
            if (loading) loading.remove();
            render();
            return;
        }

        if (!_board) return;

        if (data.sub_type === 'sudoku_fill') {
            const entry = _board[data.idx];
            if (entry && !entry.digit) {
                entry.digit  = data.digit;
                entry.filler = _oppRole;
                _scores[_oppRole]++;
                render();
                checkComplete();
            }
            return;
        }

        if (data.sub_type === 'sudoku_erase') {
            const entry = _board[data.idx];
            if (entry && entry.filler === _oppRole) {
                entry.digit = null; entry.filler = null;
                _scores[_oppRole] = Math.max(0, _scores[_oppRole]-1);
                render();
            }
            return;
        }

        if (data.sub_type === 'sudoku_mistake') {
            _mistakes[_oppRole] = Math.min(data.mistakes, 99);
            // Flash the wrong cell on our board too if coordinates were sent
            if (data.wrongIdx !== undefined && data.wrongDigit !== undefined) {
                flashWrong(data.wrongIdx, data.wrongDigit);
            }
            render();
            if (_mistakes[_oppRole] >= 3) endGame(_myRole);
            return;
        }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    function quitGame() {
        if (_gameOver) return;
        _send({ sub_type:'sudoku_mistake', mistakes:99 });
        if (typeof MatchClient !== 'undefined') MatchClient.sendGameQuit();
        endGame(_oppRole);
    }

    function destroy() {
        if (_container) _container.innerHTML = '';
        _container = _board = _puzzle = _solution = _puzzleQueued = null;
        _scores    = { offerer:0, answerer:0 };
        _mistakes  = { offerer:0, answerer:0 };
        _selected  = null;
        _gameOver  = false;
    }

    return { init, handleRemoteMove, destroy };

})();