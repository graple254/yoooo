"use strict";

/**
 * TicTacToe — chichi game module
 *
 * Interface (mirrors ThreeMensMorris):
 *   TicTacToe.init(boardId, isOfferer, onGameOver)
 *   TicTacToe.handleRemoteMove(msg)
 *   TicTacToe.destroy()
 *
 * Move message shape: { game: "ttt", index: 0-8 }
 *
 * isOfferer → plays as X and goes first.
 * answerer  → plays as O.
 */
const TicTacToe = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  let _board       = Array(9).fill(null);   // null | 'X' | 'O'
  let _mySymbol    = null;                  // 'X' | 'O'
  let _myTurn      = false;
  let _onGameOver  = null;
  let _container   = null;
  let _cells       = [];
  let _statusEl    = null;
  let _gameOver    = false;

  const LINES = [
    [0,1,2],[3,4,5],[6,7,8],   // rows
    [0,3,6],[1,4,7],[2,5,8],   // cols
    [0,4,8],[2,4,6],           // diagonals
  ];

  // ── Init ───────────────────────────────────────────────────────────────────
  function init(boardId, isOfferer, onGameOver) {
    destroy(); // clean any previous game

    _board      = Array(9).fill(null);
    _mySymbol   = isOfferer ? 'X' : 'O';
    _myTurn     = isOfferer;           // X always goes first
    _onGameOver = onGameOver;
    _gameOver   = false;

    _render(boardId);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function _render(boardId) {
    _container = document.getElementById(boardId);
    if (!_container) return;

    _container.innerHTML = '';
    _container.style.cssText = `
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0;
      width: 100%;
      user-select: none;
    `;

    // Status bar
    _statusEl = document.createElement('div');
    _statusEl.style.cssText = `
      font-size: 0.92rem;
      font-weight: 500;
      color: #555;
      margin-bottom: 18px;
      letter-spacing: 0.01em;
      min-height: 1.4em;
      text-align: center;
    `;
    _container.appendChild(_statusEl);

    // Board wrapper (keeps square aspect)
    const boardWrap = document.createElement('div');
    boardWrap.style.cssText = `
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      width: min(300px, 80vw);
      aspect-ratio: 1;
      gap: 0;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.10);
      background: #e5e5e5;
    `;

    _cells = [];
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('button');
      cell.dataset.index = i;
      cell.style.cssText = `
        background: #fff;
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: clamp(2rem, 8vw, 3.2rem);
        font-weight: 700;
        cursor: pointer;
        transition: background 0.15s;
        aspect-ratio: 1;
        position: relative;
        outline: none;
        color: #111;
      `;

      // Grid gap via margin — create the line effect
      const row = Math.floor(i / 3);
      const col = i % 3;
      if (row < 2) cell.style.marginBottom = '2px';
      if (col < 2) cell.style.marginRight  = '2px';
      cell.style.borderRadius = '0';

      cell.addEventListener('click', () => _handleCellClick(i));
      cell.addEventListener('mouseenter', () => {
        if (!_board[i] && _myTurn && !_gameOver) {
          cell.style.background = '#f5f5f5';
        }
      });
      cell.addEventListener('mouseleave', () => {
        if (!_board[i]) cell.style.background = '#fff';
      });

      boardWrap.appendChild(cell);
      _cells.push(cell);
    }

    _container.appendChild(boardWrap);

    // Symbol legend
    const legend = document.createElement('div');
    legend.style.cssText = `
      margin-top: 16px;
      font-size: 0.78rem;
      color: #aaa;
      text-align: center;
    `;
    legend.textContent = `You are ${_mySymbol}`;
    _container.appendChild(legend);

    _updateStatus();
  }

  // ── Cell click ─────────────────────────────────────────────────────────────
  function _handleCellClick(index) {
    if (_gameOver || !_myTurn || _board[index]) return;

    _applyMove(index, _mySymbol);

    // Send to peer via MatchClient
    if (typeof MatchClient !== 'undefined') {
      const payload = { game_type: 'ttt', game: 'ttt', sub_type: 'ttt', index };
      if (MatchClient.sendMove) {
        MatchClient.sendMove(payload);
      } else if (MatchClient.sendGameMove) {
        MatchClient.sendGameMove(payload);
      }
    }
  }

  // ── Apply move (local or remote) ───────────────────────────────────────────
  function _applyMove(index, symbol) {
    if (_board[index] || _gameOver) return;

    _board[index] = symbol;
    _renderCell(index, symbol);
    _myTurn = !_myTurn;

    const winner = _checkWinner();
    if (winner) {
      _endGame(winner);
    } else if (_board.every(Boolean)) {
      _endGame('draw');
    } else {
      _updateStatus();
    }
  }

  // ── Render a single cell value ─────────────────────────────────────────────
  function _renderCell(index, symbol) {
    const cell = _cells[index];
    if (!cell) return;
    cell.textContent = symbol;
    cell.style.color  = symbol === 'X' ? '#111111' : '#6366f1';
    cell.style.cursor = 'default';
    cell.style.background = '#fff';
  }

  // ── Check winner ───────────────────────────────────────────────────────────
  function _checkWinner() {
    for (const [a, b, c] of LINES) {
      if (_board[a] && _board[a] === _board[b] && _board[a] === _board[c]) {
        _highlightWinLine(a, b, c);
        return _board[a]; // 'X' or 'O'
      }
    }
    return null;
  }

  function _highlightWinLine(a, b, c) {
    [a, b, c].forEach(i => {
      if (_cells[i]) {
        _cells[i].style.background = '#f0f0ff';
      }
    });
  }

  // ── End game ───────────────────────────────────────────────────────────────
  function _endGame(winner) {
    _gameOver = true;

    // Disable all cells
    _cells.forEach(c => { c.style.pointerEvents = 'none'; });

    _updateStatus(winner);

    if (_onGameOver) {
      // connect.html's showGameResult compares winner === myRole ('offerer'|'answerer'|'draw')
      // isOfferer plays X, answerer plays O — translate symbol to role.
      let result;
      if (winner === 'draw') {
        result = 'draw';
      } else {
        // isOfferer plays X, answerer plays O
        result = winner === 'X' ? 'offerer' : 'answerer';
      }
      _onGameOver(result);
    }
  }

  // ── Status text ────────────────────────────────────────────────────────────
  function _updateStatus(winner) {
    if (!_statusEl) return;

    if (winner) {
      if (winner === 'draw') {
        _statusEl.textContent = "It's a draw!";
        _statusEl.style.color = '#888';
      } else if (winner === _mySymbol) {
        _statusEl.textContent = '🎉 You win!';
        _statusEl.style.color = '#10b981';
      } else {
        _statusEl.textContent = 'You lose.';
        _statusEl.style.color = '#dc2626';
      }
    } else {
      if (_myTurn) {
        _statusEl.textContent = 'Your turn';
        _statusEl.style.color = '#111';
      } else {
        _statusEl.textContent = "Partner's turn...";
        _statusEl.style.color = '#888';
      }
    }
  }

  // ── Handle remote move (called by connect.html routing) ────────────────────
  function handleRemoteMove(msg) {
    // Routing is already guaranteed by _activeGame in connect.html.
    // Don't re-check msg.game — the field name varies by MatchClient wrapping.
    const index = msg.index ?? msg.move?.index;
    if (index === undefined || index === null) return;
    const opponentSymbol = _mySymbol === 'X' ? 'O' : 'X';
    _applyMove(index, opponentSymbol);
  }

  // ── Destroy ────────────────────────────────────────────────────────────────
  function destroy() {
    if (_container) {
      _container.innerHTML = '';
      _container = null;
    }
    _cells      = [];
    _statusEl   = null;
    _board      = Array(9).fill(null);
    _mySymbol   = null;
    _myTurn     = false;
    _onGameOver = null;
    _gameOver   = false;
  }

  return { init, handleRemoteMove, destroy };

})();