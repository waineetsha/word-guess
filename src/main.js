import './style.css';
import { isFirebaseConfigured, ensureAnonymousUser, auth } from './firebase.js';
import { call, watchRoom } from './api.js';

const root = document.querySelector('#app');
const state = {
  uid: null, roomId: new URLSearchParams(location.search).get('room') || '',
  room: null, members: [], game: null, events: [], secretWord: '', gameCards: [], secretGameId: '', secretRevealGameId: '',
  busy: false, error: '', notice: '', unsubscribe: null, selectedVote: '', resolvingGameId: '',
};
const genres = { animals: '動物', food: '食べ物', objects: '身の回りのもの' };
const savedName = localStorage.getItem('word-game-display-name') || '';

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function errorMessage(error) {
  const code = String(error?.code || '');
  const messages = {
    'functions/unauthenticated': '認証に失敗しました。ページを再読み込みしてください。',
    'functions/permission-denied': 'この操作を行う権限がありません。最新の状態を確認してください。',
    'functions/not-found': '部屋またはゲームが見つかりません。URLを確認してください。',
    'functions/failed-precondition': error?.message || '現在のゲーム状態ではその操作を行えません。',
    'functions/invalid-argument': error?.message || '入力内容を確認してください。',
    'functions/resource-exhausted': error?.message || '部屋が満員です。',
    'functions/already-exists': error?.message || 'この操作はすでに受け付けられています。',
    'permission-denied': '部屋を読み取れません。参加状態を確認してください。',
  };
  if (messages[code]) return messages[code];
  if (error?.message?.includes('FirebaseのWeb設定')) return error.message;
  return '通信に失敗しました。接続を確認して、もう一度お試しください。';
}
function showNotice(message, isError = false) {
  state.notice = message; state.noticeIsError = isError; render();
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => { state.notice = ''; render(); }, 3800);
}
function header() {
  const room = state.room;
  return `<header class="site-header"><div class="brand"><span class="brand-mark">?</span><span>ことばの正体</span></div><div class="header-meta"><span class="connection ${navigator.onLine ? '' : 'offline'}"><i></i>${navigator.onLine ? '接続中' : 'オフライン'}</span>${state.uid ? `<span class="display-name">${escapeHtml(memberForMe()?.displayName || '参加中')}</span>` : ''}${room ? `<span>部屋 ${escapeHtml(state.roomId)}</span>` : ''}</div></header>`;
}
function homeView() {
  const roomParam = new URLSearchParams(location.search).get('room') || '';
  const error = state.error ? `<div class="callout error" role="alert">${escapeHtml(state.error)}</div>` : '';
  const setup = isFirebaseConfigured ? '' : '<div class="callout warn">Firebase接続設定がまだありません。READMEの「Firebase設定」を完了すると、部屋作成と参加が使えます。</div>';
  return `<main class="layout"><span class="eyebrow">オンラインで遊ぶ</span><h1 class="page-title">みんなで、ことばを当てよう。</h1><p class="page-subtitle">自分だけ見えないワードを、質問と推理で探すゲームです。</p><p class="note">無料プラン向けの構成です。信頼できる参加者同士でお楽しみください。</p>${setup}${error}<div class="grid two-col"><section class="panel"><h2>部屋に参加</h2><form id="join-form"><div class="field"><label for="join-name">あなたの表示名</label><input class="input" id="join-name" name="displayName" maxlength="20" required value="${escapeHtml(savedName)}" placeholder="表示名を入力"></div><div class="field"><label for="room-id">部屋コードまたはURL</label><input class="input" id="room-id" name="roomId" required value="${escapeHtml(roomParam)}" placeholder="例：AbC123xY"></div><button class="btn btn-block" ${state.busy || !isFirebaseConfigured ? 'disabled' : ''}>${state.busy ? '参加しています…' : '部屋に参加する'}</button></form><p class="note">ゲーム開始後の参加者は観戦者として入室します。</p><div style="height:1px;background:var(--line);margin:20px 0"></div><h3>新しい部屋を作る</h3><form id="create-form"><div class="field"><label for="create-name">あなたの表示名</label><input class="input" id="create-name" name="displayName" maxlength="20" required value="${escapeHtml(savedName)}" placeholder="表示名を入力"></div><button class="btn btn-dark btn-block" ${state.busy || !isFirebaseConfigured ? 'disabled' : ''}>部屋を作成</button></form></section><aside class="hero"><div><span class="eyebrow">遊び方</span><h2>ほかの人のワードから、自分のワードを推理。</h2><p>手番では質問か解答を選択。解答の成否は、ほかのプレイヤーの投票で決まります。2〜8人で遊べます。</p></div><p class="note" style="color:#d0e1e5">制限時間はありません。最後のプレイヤーまで順番に遊びます。</p></aside></div></main>`;
}
function memberForMe() { return state.members.find((m) => m.uid === state.uid); }
function isHost() { return state.room?.hostUid === state.uid; }
function activePlayers() { return state.members.filter((m) => m.status === 'active' && ['host', 'player'].includes(m.role)); }
function avatar(name = '?') { return escapeHtml([...String(name)][0] || '?'); }
function memberCard(member, currentGame = state.game) {
  const isMe = member.uid === state.uid;
  const won = currentGame?.winnerUids?.includes(member.uid);
  const isPlayer = member.status === 'active' && ['host', 'player'].includes(member.role);
  const word = isMe ? '？？？' : (state.gameCards.find((card) => card.uid === member.uid)?.wordText || 'ワード');
  return `<article class="player-card ${isMe ? 'me' : ''}">${won ? '<span class="winner-mark">★ 勝利</span>' : ''}${isMe ? '<div class="player-you">あなた</div>' : ''}<div class="player-name">${escapeHtml(member.displayName || '参加者')}${!isPlayer ? ' <span class="tag">観戦者</span>' : ''}</div><div class="player-word ${isMe ? 'hidden' : ''}">${escapeHtml(word)}</div></article>`;
}
function eventCard(event) {
  const actor = state.members.find((m) => m.uid === event.actorUid)?.displayName || '参加者';
  if (event.type === 'question') {
    if (event.actorUid === state.uid && !event.answer) return '<article class="event question"><div class="event-meta">あなたの質問</div><div class="event-text">回答を待っています。</div></article>';
    const answerer = state.members.find((m) => m.uid === event.answeredByUid)?.displayName || '回答待ち';
    const answers = { yes: 'はい', no: 'いいえ', maybe: 'どちらともいえない' };
    return `<article class="event question"><div class="event-meta">#${Number(event.sequence) || ''} · ${escapeHtml(actor)}の質問</div><div class="event-text">${escapeHtml(event.questionText)}<br><span class="answer-text">${event.answer ? `${answers[event.answer] || '回答'} · ${escapeHtml(answerer)}が回答` : '回答待ち'}</span></div></article>`;
  }
  if (event.type === 'guess') {
    const result = event.voteResult === 'correct' ? `投票結果：正解票 ${Number(event.correctVotes) || 0} · 不正解票 ${Number(event.incorrectVotes) || 0}` : event.voteResult === 'incorrect' ? `投票結果：不正解票 ${Number(event.incorrectVotes) || 0} · 正解票 ${Number(event.correctVotes) || 0}` : '投票中';
    return `<article class="event guess"><div class="event-meta">#${Number(event.sequence) || ''} · ${escapeHtml(actor)}の解答</div><div class="event-text">「${escapeHtml(event.guessText)}」<br><span class="answer-text">${result}</span></div></article>`;
  }
  return '';
}
function historyView() {
  const events = state.events.map(eventCard).filter(Boolean).join('') || '<p class="note">まだ履歴はありません。</p>';
  return `<aside class="history"><div class="history-heading">これまでのやりとり <span class="tag">全件</span></div><div class="history-list">${events}</div></aside>`;
}
function lobbyView() {
  const members = state.members.filter((m) => m.status !== 'removed');
  const players = members.filter((m) => ['host', 'player'].includes(m.role) && m.status === 'active').length;
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.roomId)}`;
  const memberCards = members.map((m) => `<div class="member"><span class="avatar">${avatar(m.displayName)}</span><div class="member-text"><div class="member-name">${escapeHtml(m.displayName || '参加者')}</div><div class="member-meta">${m.uid === state.room?.hostUid ? 'ホスト' : m.role === 'spectator' ? '観戦者' : '参加者'}</div></div>${m.uid === state.room?.hostUid ? '<span class="tag host">ホスト</span>' : ''}</div>`).join('');
  return `<main class="layout"><div class="room-head"><div><span class="eyebrow">ゲーム開始前</span><h1 class="page-title">待機室</h1><div class="room-code">部屋コード <strong>${escapeHtml(state.roomId)}</strong></div></div><span class="tag">${players} / 8人</span></div>${state.error ? `<div class="callout error">${escapeHtml(state.error)}</div>` : ''}<div class="grid two-col"><section class="panel"><h2>参加者</h2><div class="member-grid">${memberCards}</div><div class="share-box"><code>${escapeHtml(url)}</code><button class="small-btn" data-action="copy-url">URLをコピー</button></div><div class="room-progress">${Array.from({ length: 8 }, (_, i) => `<i class="${i < players ? 'on' : ''}"></i>`).join('')}</div>${isHost() ? `<form id="start-form"><button class="btn btn-block" ${state.busy || players < 2 || players > 8 ? 'disabled' : ''}>${state.busy ? '開始しています…' : 'ゲームを開始する'}</button></form>` : '<div class="callout">ホストがゲームを開始するまでお待ちください。</div>'}<p class="note">2〜8人で開始できます。開始後の入室は観戦者になります。</p></section><aside class="panel" style="background:var(--soft)"><h3>ゲームの流れ</h3><p class="callout">全員に同じジャンルからワードが配られます。自分のワードだけ見えません。</p><p class="callout" style="margin-top:9px">手番では「質問」か「解答」のどちらか一方を選びます。</p><p class="callout" style="margin-top:9px">解答は、解答者以外の全プレイヤーが投票して判定します。</p><p class="note">制限時間はありません。正解者が出るまでは次の一巡へ進みます。正解者が出た後は、その一巡の最後の人の手番が終わるとゲーム終了です。</p></aside></div></main>`;
}
function currentQuestion() { return state.events.find((e) => e.id === state.game?.currentEventId); }
function answeringPanel() {
  const q = currentQuestion();
  const already = q?.answeredByUid === state.uid;
  const eligible = state.uid !== q?.actorUid && ['host', 'player'].includes(memberForMe()?.role) && memberForMe()?.status === 'active';
  if (eligible && !q?.answer && !already) return `<div class="action-box"><h3>質問に回答してください</h3><p>${escapeHtml(q?.questionText || '')}</p><div class="btn-row"><button class="btn" data-answer="yes">はい</button><button class="btn btn-soft" data-answer="no">いいえ</button><button class="btn btn-outline" data-answer="maybe">どちらともいえない</button></div></div>`;
  return `<div class="action-box"><h3>回答を待っています</h3><p>${escapeHtml(q?.questionText || '')}</p><div class="callout">${q?.answer ? '回答が確定しました。次の手番へ進みます。' : '質問者以外のプレイヤーが回答できます。'}</div></div>`;
}
function votingPanel() {
  const voted = state.game?.voteVotedUids || [];
  const guesserUid = state.game?.currentGuessUid;
  const eligible = state.uid !== guesserUid && ['host', 'player'].includes(memberForMe()?.role) && memberForMe()?.status === 'active';
  const already = voted.includes(state.uid);
  const event = currentQuestion();
  const guessed = state.events.find((e) => e.id === state.game?.currentEventId);
  const guesser = state.members.find((m) => m.uid === guesserUid);
  const targetWord = guesserUid === state.uid ? state.secretWord : (state.gameCards.find((card) => card.uid === guesserUid)?.wordText || '');
  if (eligible && !already) return `<div class="action-box"><h3>解答は正解？</h3><p>${escapeHtml(guesser?.displayName || 'プレイヤー')}のワード「${escapeHtml(targetWord || '読み込み中')}」を見て投票してください。候補：「${escapeHtml(guessed?.guessText || '')}」</p><div class="vote-options"><button class="vote-choice ${state.selectedVote === 'correct' ? 'selected' : ''}" data-vote="correct"><strong>正解</strong><small>この解答を正解として認める</small></button><button class="vote-choice ${state.selectedVote === 'incorrect' ? 'selected' : ''}" data-vote="incorrect"><strong>不正解</strong><small>この解答は正解ではない</small></button></div><button class="btn btn-block" data-action="submit-vote" ${!state.selectedVote || state.busy ? 'disabled' : ''}>投票を確定する</button><p class="note">投票後は変更できません。票数と投票先は、全員の投票がそろうまで非公開です。</p></div>`;
  const names = voted.map((uid) => state.members.find((m) => m.uid === uid)?.displayName || '参加者').join('、');
  return `<div class="action-box"><h3>${state.uid === guesserUid ? 'ほかのプレイヤーが投票中です' : already ? '投票を受け付けました' : '投票を待っています'}</h3><p>投票済み ${voted.length} / ${state.game?.voteEligibleCount || 0}人${names ? `（${escapeHtml(names)}）` : ''}</p><div class="callout">投票がそろうと多数決で成否が決まり、次の手番へ進みます。</div></div>`;
}
function turnPanel() {
  const current = state.game?.currentTurnUid === state.uid;
  if (!current) {
    const name = state.members.find((m) => m.uid === state.game?.currentTurnUid)?.displayName || '参加者';
    return `<div class="action-box"><h3>${escapeHtml(name)}のターン</h3><p>順番が来るまでお待ちください。</p></div>`;
  }
  return `<div class="action-box"><h3>あなたの番です</h3><p>質問するか、ワードを解答してください。</p><div class="btn-row"><button class="btn" data-action="ask">質問する</button><button class="btn btn-dark" data-action="show-guess">解答する</button></div><form id="question-form" class="field hidden"><label for="question">質問内容</label><textarea class="textarea" id="question" name="question" maxlength="160" required placeholder="例：夜に活動しますか？"></textarea><button class="btn" ${state.busy ? 'disabled' : ''}>${state.busy ? '送信中…' : '質問を送る'}</button><button type="button" class="btn btn-outline" data-action="cancel-question">キャンセル</button></form><form id="guess-form" class="field hidden"><label for="guess">あなたのワードだと思う言葉</label><input class="input" id="guess" name="guess" maxlength="80" required placeholder="ワードを入力"><p class="note">解答後、ほかのプレイヤーの投票で成否が決まります。</p><button class="btn btn-dark" ${state.busy ? 'disabled' : ''}>${state.busy ? '送信中…' : '解答を提出する'}</button><button type="button" class="btn btn-outline" data-action="cancel-guess">キャンセル</button></form></div>`;
}
function gameView() {
  const me = memberForMe();
  const playerList = activePlayers();
  const myTurn = state.game?.currentTurnUid === state.uid;
  const turnName = state.members.find((m) => m.uid === state.game?.currentTurnUid)?.displayName || '参加者';
  const phase = state.game?.phase;
  let action = phase === 'answering' ? answeringPanel() : phase === 'voting' ? votingPanel() : turnPanel();
  if (!me || me.role === 'spectator' || me.status !== 'active') action = '<div class="action-box"><h3>観戦中</h3><p>ゲームの進行と投票結果をリアルタイムで確認できます。</p></div>';
  const list = playerList.map((m) => memberCard(m)).join('');
  const spectatorList = state.members.filter((m) => m.role === 'spectator' && m.status === 'active').map((m) => `<span class="tag">観戦：${escapeHtml(m.displayName)}</span>`).join(' ');
  return `<main class="layout"><div class="turn-banner"><span>${state.room?.genreId ? `ジャンル：${escapeHtml(genres[state.room.genreId] || state.room.genreId)}` : 'ゲーム中'}</span><span>${myTurn ? 'あなたのターンです' : `${escapeHtml(turnName)}のターン`}</span></div>${state.error ? `<div class="callout error">${escapeHtml(state.error)}</div>` : ''}<div class="game-columns"><section><div class="players">${list}</div>${spectatorList ? `<div style="margin-top:10px">${spectatorList}</div>` : ''}${action}<p class="note">自分のワードは他の参加者には表示されません。解答の成否は投票で決まります。</p></section>${historyView()}</div></main>`;
}
function resultsView() {
  const winnerUids = state.game?.winnerUids || [];
  const winnerChips = winnerUids.map((uid) => state.members.find((m) => m.uid === uid)?.displayName || '参加者').map((n) => `<span class="winner-chip">★ ${escapeHtml(n)}</span>`).join('') || '<span class="note">勝者なし</span>';
  const members = state.members.filter((m) => m.status !== 'removed');
  const gamePlayers = members.filter((m) => (state.game?.activePlayerUids || []).includes(m.uid));
  const nextIds = state.game?.nextGamePlayerUids || [];
  const roster = members.map((m) => {
    const included = nextIds.includes(m.uid);
    const control = m.uid === state.uid || m.uid === state.room?.hostUid ? '' : included ? `<button class="small-btn" data-member-action="remove" data-uid="${escapeHtml(m.uid)}">削除</button>` : `<button class="small-btn" data-member-action="add" data-uid="${escapeHtml(m.uid)}">参加に追加</button>`;
    return `<div class="manage-row"><span>${escapeHtml(m.displayName || '参加者')} ${m.uid === state.room?.hostUid ? '<span class="tag host">ホスト</span>' : ''} ${!included ? '<span class="tag">観戦者</span>' : ''}</span>${control}</div>`;
  }).join('');
  const cards = gamePlayers.map((m) => `<div class="member"><span class="avatar">${avatar(m.displayName)}</span><div class="member-text"><div class="member-name">${escapeHtml(m.displayName || '参加者')}</div><div class="member-meta">${escapeHtml(m.uid === state.uid ? state.secretWord : (state.gameCards.find((card) => card.uid === m.uid)?.wordText || ''))}${winnerUids.includes(m.uid) ? ' · 勝利' : ''}</div></div></div>`).join('');
  const canStart = isHost() && nextIds.length >= 2 && nextIds.length <= 8 && !state.busy;
  return `<main class="layout"><section class="result-banner"><div><span class="eyebrow" style="color:#b9e2e1">ゲーム終了</span><h2>今回の勝者</h2><p>最後のプレイヤーの手番が終わりました。</p></div><div aria-hidden="true" style="font-size:38px">🏆</div></section>${state.error ? `<div class="callout error">${escapeHtml(state.error)}</div>` : ''}<div class="grid two-col-even"><section class="panel"><h3>勝者</h3><div class="winner-chips">${winnerChips}</div><h3 style="margin-top:20px">最終ワード</h3><div class="member-grid">${cards}</div></section><section class="panel"><h3>次のゲームの参加者</h3>${isHost() ? roster : '<p class="note">ホストが次の参加者を選びます。</p>'}${isHost() ? `<p class="note">参加者 ${nextIds.length} / 8人。2人以上を選んでください。</p><button class="btn btn-block" data-action="next-game" ${canStart ? '' : 'disabled'}>${state.busy ? '準備中…' : '次のゲームを開始する'}</button>` : ''}</section></div><section class="panel" style="margin-top:17px">${historyView()}</section></main>`;
}
function render() {
  const headerHtml = header();
  let view;
  if (!state.roomId || !state.room) {
    view = state.roomId && state.uid && state.error
      ? `<main class="layout"><div class="callout error" role="alert">${escapeHtml(state.error)}</div><button class="btn btn-soft" data-action="go-home" style="margin-top:14px">トップへ戻る</button></main>`
      : state.roomId && state.uid ? '<main class="layout"><div class="loading">部屋の状態を読み込んでいます…</div></main>' : homeView();
  } else if (state.room.status === 'waiting') view = lobbyView();
  else if (state.room.status === 'finished') view = resultsView();
  else if (state.room.status === 'active' && state.game) view = gameView();
  else view = '<main class="layout"><div class="loading">ゲームを読み込んでいます…</div></main>';
  const notice = state.notice ? `<div class="notice ${state.noticeIsError ? 'error' : ''}" role="status">${escapeHtml(state.notice)}</div>` : '';
  root.innerHTML = `<div class="app-shell">${headerHtml}${view}</div>${notice}`;
}
function startWatching(roomId) {
  state.unsubscribe?.(); state.unsubscribe = null; state.roomId = roomId; state.room = null; state.game = null; state.events = []; state.secretWord = ''; state.secretGameId = ''; state.secretRevealGameId = ''; state.error = '';
  history.replaceState({}, '', `${location.pathname}?room=${encodeURIComponent(roomId)}`);
  state.unsubscribe = watchRoom(roomId, {
    onRoom: (room) => { state.room = room; if (!room) state.error = '部屋が見つかりません。'; render(); },
    onMembers: (members) => { state.members = members; render(); },
    onGame: async (game) => {
      state.game = game;
      if (game?.phase === 'voting' && game.voteEligibleUids?.length && game.voteVotedUids?.length === game.voteEligibleUids.length && state.resolvingGameId !== game.id) {
        state.resolvingGameId = game.id;
        call('resolveVotes', { roomId, gameId: game.id }).catch(() => { state.resolvingGameId = ''; });
      }
      const isNewGame = Boolean(game?.id && game.id !== state.secretGameId);
      const revealFinishedWord = Boolean(game?.id && game.status === 'finished' && state.secretRevealGameId !== game.id);
      if (isNewGame) {
        state.secretGameId = game.id; state.secretWord = ''; state.gameCards = []; state.secretRevealGameId = '';
      }
      if (isNewGame || revealFinishedWord) {
        if (revealFinishedWord) state.secretRevealGameId = game.id;
        try { const result = await call('getGameView', { roomId, gameId: game.id }); state.secretWord = result.myWord || ''; state.gameCards = result.cards || []; }
        catch { /* Spectators have no personal word. */ }
      }
      render();
    },
    onEvents: (events) => { state.events = events; render(); },
    onError: (error) => { state.error = errorMessage(error); render(); },
  });
  render();
}
async function withBusy(action) {
  state.busy = true; state.error = ''; render();
  try { await action(); }
  catch (error) { state.error = errorMessage(error); }
  finally { state.busy = false; render(); }
}
async function enterRoom(roomId, displayName) {
  const user = await ensureAnonymousUser(); state.uid = user.uid;
  localStorage.setItem('word-game-display-name', displayName);
  const result = await call('joinRoom', { roomId: roomId.trim(), displayName });
  startWatching(result.roomId || roomId.trim());
}
root.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === 'create-form') {
    const displayName = new FormData(form).get('displayName')?.toString().trim();
    if (!displayName) return;
    await withBusy(async () => {
      const user = await ensureAnonymousUser(); state.uid = user.uid; localStorage.setItem('word-game-display-name', displayName);
      const { roomId } = await call('createRoom', { displayName }); startWatching(roomId);
    });
  } else if (form.id === 'join-form') {
    const data = new FormData(form); const roomInput = data.get('roomId')?.toString().trim();
    const roomId = roomInput?.match(/[?&]room=([^&]+)/)?.[1] ? decodeURIComponent(roomInput.match(/[?&]room=([^&]+)/)[1]) : roomInput;
    const displayName = data.get('displayName')?.toString().trim();
    if (!displayName || !roomId) return;
    await withBusy(() => enterRoom(roomId, displayName));
  } else if (form.id === 'start-form') {
    await withBusy(() => call('startGame', { roomId: state.roomId }));
  } else if (form.id === 'question-form') {
    const text = new FormData(form).get('question')?.toString().trim();
    if (!text) return;
    await withBusy(() => call('submitQuestion', { roomId: state.roomId, gameId: state.game.id, text }));
  } else if (form.id === 'guess-form') {
    const guess = new FormData(form).get('guess')?.toString().trim();
    if (!guess) return;
    await withBusy(() => call('submitGuess', { roomId: state.roomId, gameId: state.game.id, guess }));
  }
});
root.addEventListener('click', async (event) => {
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.answer) {
    await withBusy(() => call('submitAnswer', { roomId: state.roomId, gameId: state.game.id, eventId: state.game.currentEventId, answer: target.dataset.answer }));
  } else if (target.dataset.vote) {
    state.selectedVote = target.dataset.vote; render();
  } else if (target.dataset.action === 'submit-vote') {
    const choice = state.selectedVote; state.selectedVote = '';
    await withBusy(() => call('castGuessVote', { roomId: state.roomId, gameId: state.game.id, eventId: state.game.currentEventId, choice }));
  } else if (target.dataset.action === 'ask') {
    document.querySelector('#question-form')?.classList.remove('hidden'); document.querySelector('#question-form textarea')?.focus();
  } else if (target.dataset.action === 'show-guess') {
    document.querySelector('#guess-form')?.classList.remove('hidden'); document.querySelector('#guess-form input')?.focus();
  } else if (target.dataset.action === 'cancel-question') document.querySelector('#question-form')?.classList.add('hidden');
  else if (target.dataset.action === 'cancel-guess') document.querySelector('#guess-form')?.classList.add('hidden');
  else if (target.dataset.action === 'copy-url') {
    const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.roomId)}`;
    try { await navigator.clipboard.writeText(url); showNotice('招待URLをコピーしました。'); }
    catch { showNotice(url); }
  } else if (target.dataset.action === 'go-home') {
    state.unsubscribe?.(); state.unsubscribe = null; state.roomId = ''; state.room = null; state.game = null; state.error = '';
    history.replaceState({}, '', location.pathname); render();
  } else if (target.dataset.memberAction) {
    const callable = target.dataset.memberAction === 'add' ? 'setSpectatorToPlayer' : 'removeMember';
    await withBusy(() => call(callable, { roomId: state.roomId, gameId: state.game.id, targetUid: target.dataset.uid }));
  } else if (target.dataset.action === 'next-game') {
    await withBusy(() => call('startNextGame', { roomId: state.roomId, gameId: state.game.id }));
  }
});
window.addEventListener('online', render); window.addEventListener('offline', render);

if (!isFirebaseConfigured) render();
else {
  ensureAnonymousUser().then((user) => {
    state.uid = user.uid;
    const roomId = new URLSearchParams(location.search).get('room');
    if (roomId) {
      // Joining an existing UID restores its seat; a new UID enters as a spectator after game start.
      const name = localStorage.getItem('word-game-display-name');
      if (name) enterRoom(roomId, name).catch((error) => { state.error = errorMessage(error); state.roomId = ''; render(); });
      else {
        // A fresh browser profile has no saved display name. Show the join form with the invite room prefilled.
        state.roomId = '';
        render();
      }
    } else render();
  }).catch((error) => { state.error = errorMessage(error); render(); });
}
