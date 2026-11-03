import {
  collection, doc, getDoc, getDocs, onSnapshot, orderBy, query,
  runTransaction, serverTimestamp,
} from 'firebase/firestore';
import { auth, db } from './firebase.js';
import { drawRandomGenre, drawWords } from './word-pools.js';

const rooms = () => collection(db, 'rooms');
const roomDocument = (roomId) => doc(db, 'rooms', roomId);
const memberDocument = (roomId, uid) => doc(db, 'rooms', roomId, 'members', uid);
const gameDocument = (roomId, gameId) => doc(db, 'rooms', roomId, 'games', gameId);
function currentUid() {
  if (!auth?.currentUser) throw new Error('ログイン状態を確認してください。');
  return auth.currentUser.uid;
}
function reject(code, message) {
  const error = new Error(message); error.code = `functions/${code}`; throw error;
}
function assert(condition, code, message) { if (!condition) reject(code, message); }

export async function call(name, data = {}) {
  if (!db) throw new Error('Firebaseの接続設定を確認してください。');
  const uid = currentUid();
  const handlers = {
    createRoom, joinRoom, startGame, getGameView, submitQuestion,
    submitAnswer, submitGuess, castGuessVote, resolveVotes,
    removeMember, setSpectatorToPlayer, startNextGame,
  };
  const handler = handlers[name];
  if (!handler) throw new Error(`未対応の操作です: ${name}`);
  return handler(uid, data);
}

export function watchRoom(roomId, callbacks) {
  const roomRef = roomDocument(roomId);
  const stopRoom = onSnapshot(roomRef,
    (snapshot) => callbacks.onRoom(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null), callbacks.onError);
  const stopMembers = onSnapshot(collection(roomRef, 'members'),
    (snapshot) => callbacks.onMembers(snapshot.docs.map((item) => ({ uid: item.id, ...item.data() }))), callbacks.onError);
  let stopGame = () => {};
  let stopEvents = () => {};
  let activeGameId = null;
  const stopGameSwitch = onSnapshot(roomRef, (snapshot) => {
    const nextId = snapshot.data()?.currentGameId || null;
    if (nextId === activeGameId) return;
    stopGame(); stopEvents(); activeGameId = nextId;
    callbacks.onGame(null); callbacks.onEvents([]);
    if (!nextId) return;
    stopGame = onSnapshot(gameDocument(roomId, nextId),
      (gameSnapshot) => callbacks.onGame(gameSnapshot.exists() ? { id: gameSnapshot.id, ...gameSnapshot.data() } : null), callbacks.onError);
    stopEvents = onSnapshot(query(collection(roomRef, 'games', nextId, 'events'), orderBy('sequence', 'desc')),
      (eventsSnapshot) => callbacks.onEvents(eventsSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }))), callbacks.onError);
  }, callbacks.onError);
  return () => { stopRoom(); stopMembers(); stopGameSwitch(); stopGame(); stopEvents(); };
}

async function createRoom(uid, data) {
  const displayName = cleanName(data.displayName);
  const roomRef = doc(rooms()); const memberRef = memberDocument(roomRef.id, uid);
  await runTransaction(db, async (tx) => {
    tx.set(roomRef, {
      status: 'waiting', hostUid: uid, currentGameId: null, genreId: null,
      playerCount: 1, spectatorCount: 0, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    tx.set(memberRef, { uid, displayName, role: 'host', status: 'active', seat: 0, joinedAt: serverTimestamp(), lastSeenAt: serverTimestamp() });
  });
  return { roomId: roomRef.id };
}

async function joinRoom(uid, data) {
  const displayName = cleanName(data.displayName); const roomRef = roomDocument(data.roomId);
  const memberRef = memberDocument(data.roomId, uid);
  return runTransaction(db, async (tx) => {
    const [roomSnap, memberSnap] = await Promise.all([tx.get(roomRef), tx.get(memberRef)]);
    assert(roomSnap.exists(), 'not-found', '部屋が見つかりません。');
    const room = roomSnap.data(); const prior = memberSnap.data();
    assert(['waiting', 'active', 'finished'].includes(room.status), 'failed-precondition', 'この部屋では参加を受け付けていません。');
    if (prior?.status === 'active') {
      tx.update(memberRef, { displayName, lastSeenAt: serverTimestamp() });
      return { roomId: roomRef.id, role: prior.role };
    }
    const waiting = room.status === 'waiting';
    const role = waiting ? 'player' : 'spectator';
    if (waiting) assert(Number(room.playerCount) < 8, 'resource-exhausted', '待機室は8人までです。');
    tx.set(memberRef, {
      uid, displayName, role, status: 'active', seat: waiting ? Number(room.playerCount) : null,
      joinedAt: serverTimestamp(), lastSeenAt: serverTimestamp(),
    });
    tx.update(roomRef, waiting
      ? { playerCount: Number(room.playerCount) + 1, updatedAt: serverTimestamp() }
      : { spectatorCount: Number(room.spectatorCount || 0) + 1, updatedAt: serverTimestamp() });
    return { roomId: roomRef.id, role };
  });
}

function cleanName(value) {
  if (typeof value !== 'string') reject('invalid-argument', '表示名を入力してください。');
  const result = value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 20);
  assert(result.length > 0, 'invalid-argument', '表示名を入力してください。');
  return result;
}
function cleanText(value, label, max) {
  if (typeof value !== 'string') reject('invalid-argument', `${label}を入力してください。`);
  const result = value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  assert(result.length > 0 && result.length <= max, 'invalid-argument', `${label}は1〜${max}文字で入力してください。`);
  return result;
}
function canHost(room, uid) { assert(room.hostUid === uid, 'permission-denied', 'ホストだけが実行できます。'); }
function canPlay(member) { assert(member?.status === 'active' && ['host', 'player'].includes(member.role), 'permission-denied', 'この操作ができる参加者ではありません。'); }

async function makeGame(tx, roomRef, room, playerDocs, genreId) {
  const players = playerDocs.map((item) => ({ uid: item.id, ref: item.ref, member: item.data() }));
  assert(players.length >= 2 && players.length <= 8, 'failed-precondition', '参加者は2〜8人で開始してください。');
  const words = drawWords(genreId, players.length);
  const gameRef = doc(collection(roomRef, 'games'));
  const uids = players.map((item) => item.uid);
  tx.set(gameRef, {
    status: 'active', phase: 'turn', genreId, currentTurnUid: uids[0],
    turnOrderUids: uids, turnIndex: 0, activePlayerUids: uids, winnerUids: [],
    currentEventId: null, currentGuessUid: null, voteEligibleUids: [], voteVotedUids: [],
    voteEligibleCount: 0, eventSequence: 0, nextGamePlayerUids: uids,
    createdAt: serverTimestamp(), endedAt: null, version: 1,
  });
  players.forEach((player, index) => {
    tx.set(doc(gameRef, 'privateWords', player.uid), { wordText: words[index], assignedAt: serverTimestamp() });
    tx.set(doc(gameRef, 'publicCards', player.uid), { wordText: words[index], assignedAt: serverTimestamp() });
    if (player.member.role !== 'host' || player.member.seat !== index) tx.update(player.ref, { role: player.member.role === 'host' ? 'host' : 'player', status: 'active', seat: index });
  });
  tx.update(roomRef, { status: 'active', currentGameId: gameRef.id, genreId, playerCount: players.length, updatedAt: serverTimestamp() });
  return gameRef.id;
}

async function startGame(uid, data) {
  const roomRef = roomDocument(data.roomId); const genreId = drawRandomGenre();
  const membersSnap = await getDocs(collection(roomRef, 'members'));
  const roster = membersSnap.docs.filter((item) => item.data().status === 'active' && ['host', 'player'].includes(item.data().role)).sort((a, b) => Number(a.data().seat) - Number(b.data().seat));
  return runTransaction(db, async (tx) => {
    const roomSnap = await tx.get(roomRef); assert(roomSnap.exists(), 'not-found', '部屋が見つかりません。');
    const room = roomSnap.data(); canHost(room, uid); assert(room.status === 'waiting', 'failed-precondition', 'ゲームは開始済みです。');
    const currentMembers = await Promise.all(roster.map((item) => tx.get(item.ref)));
    assert(Number(room.playerCount) === roster.length && currentMembers.every((item) => item.data()?.status === 'active'), 'aborted', '参加者が変わりました。もう一度お試しください。');
    return { gameId: await makeGame(tx, roomRef, room, roster, genreId) };
  });
}

async function getGameView(uid, data) {
  const roomRef = roomDocument(data.roomId); const gameRef = gameDocument(data.roomId, data.gameId);
  const [memberSnap, gameSnap] = await Promise.all([getDoc(memberDocument(data.roomId, uid)), getDoc(gameRef)]);
  assert(memberSnap.exists() && memberSnap.data().status === 'active', 'permission-denied', 'この部屋の参加者ではありません。');
  assert(gameSnap.exists(), 'not-found', 'ゲームが見つかりません。');
  const activeUids = gameSnap.data().activePlayerUids || [];
  const member = memberSnap.data();
  const myWordSnap = activeUids.includes(uid) && member.role !== 'spectator' ? await getDoc(doc(gameRef, 'privateWords', uid)) : null;
  const otherUids = activeUids.filter((playerUid) => playerUid !== uid);
  const cards = await Promise.all(otherUids.map(async (playerUid) => {
    const card = await getDoc(doc(gameRef, 'publicCards', playerUid));
    return { uid: playerUid, wordText: card.data()?.wordText || '' };
  }));
  return { myWord: myWordSnap?.data()?.wordText || '', cards };
}

async function submitQuestion(uid, data) {
  const text = cleanText(data.text, '質問内容', 160); const roomRef = roomDocument(data.roomId); const gameRef = gameDocument(data.roomId, data.gameId);
  const memberRef = memberDocument(data.roomId, uid); const eventRef = doc(collection(gameRef, 'events'));
  return runTransaction(db, async (tx) => {
    const [roomSnap, gameSnap, memberSnap] = await Promise.all([tx.get(roomRef), tx.get(gameRef), tx.get(memberRef)]);
    assert(roomSnap.data()?.status === 'active' && gameSnap.data()?.status === 'active', 'failed-precondition', 'ゲームは進行中ではありません。');
    const game = gameSnap.data(); canPlay(memberSnap.data());
    assert(game.phase === 'turn' && game.currentTurnUid === uid, 'failed-precondition', 'あなたの手番ではありません。');
    const sequence = Number(game.eventSequence || 0) + 1;
    tx.set(eventRef, { type: 'question', actorUid: uid, questionText: text, answer: null, answeredByUid: null, sequence, createdAt: serverTimestamp() });
    tx.update(gameRef, { phase: 'answering', currentEventId: eventRef.id, eventSequence: sequence, version: Number(game.version || 0) + 1 });
  });
}

function advanceTurn(tx, roomRef, gameRef, game, winnerUids = game.winnerUids || []) {
  const nextIndex = Number(game.turnIndex) + 1; const order = game.turnOrderUids;
  if (nextIndex >= order.length) {
    tx.update(gameRef, {
      status: 'finished', phase: 'finished', currentTurnUid: null, currentEventId: null,
      currentGuessUid: null, voteEligibleUids: [], voteVotedUids: [], winnerUids,
      nextGamePlayerUids: [...game.activePlayerUids], endedAt: serverTimestamp(), version: Number(game.version || 0) + 1,
    });
    tx.update(roomRef, { status: 'finished', updatedAt: serverTimestamp() });
  } else {
    tx.update(gameRef, {
      phase: 'turn', turnIndex: nextIndex, currentTurnUid: order[nextIndex], currentEventId: null,
      currentGuessUid: null, voteEligibleUids: [], voteVotedUids: [], voteEligibleCount: 0,
      winnerUids, version: Number(game.version || 0) + 1,
    });
  }
}

async function submitAnswer(uid, data) {
  const roomRef = roomDocument(data.roomId); const gameRef = gameDocument(data.roomId, data.gameId);
  const memberRef = memberDocument(data.roomId, uid); const eventRef = doc(gameRef, 'events', data.eventId);
  const answer = data.answer;
  assert(['yes', 'no', 'maybe'].includes(answer), 'invalid-argument', '回答を選んでください。');
  return runTransaction(db, async (tx) => {
    const [roomSnap, gameSnap, memberSnap, eventSnap] = await Promise.all([tx.get(roomRef), tx.get(gameRef), tx.get(memberRef), tx.get(eventRef)]);
    const room = roomSnap.data(); const game = gameSnap.data(); const event = eventSnap.data(); canPlay(memberSnap.data());
    assert(room?.status === 'active' && game?.status === 'active' && game.phase === 'answering' && game.currentEventId === data.eventId, 'failed-precondition', 'この質問は回答受付中ではありません。');
    assert(event?.type === 'question' && event.actorUid !== uid, 'permission-denied', '質問者は自分の質問に回答できません。');
    assert(!event.answer, 'already-exists', '回答はすでに確定しています。');
    tx.update(eventRef, { answer, answeredByUid: uid, answeredAt: serverTimestamp() });
    advanceTurn(tx, roomRef, gameRef, game);
  });
}

async function submitGuess(uid, data) {
  const guessText = cleanText(data.guess, '解答', 80); const roomRef = roomDocument(data.roomId); const gameRef = gameDocument(data.roomId, data.gameId);
  const memberRef = memberDocument(data.roomId, uid); const eventRef = doc(collection(gameRef, 'events'));
  return runTransaction(db, async (tx) => {
    const [roomSnap, gameSnap, memberSnap] = await Promise.all([tx.get(roomRef), tx.get(gameRef), tx.get(memberRef)]);
    const room = roomSnap.data(); const game = gameSnap.data(); canPlay(memberSnap.data());
    assert(room?.status === 'active' && game?.status === 'active' && game.phase === 'turn' && game.currentTurnUid === uid, 'failed-precondition', 'あなたの手番ではありません。');
    const eligible = game.activePlayerUids.filter((playerUid) => playerUid !== uid);
    const sequence = Number(game.eventSequence || 0) + 1;
    tx.set(eventRef, { type: 'guess', actorUid: uid, guessText, voteResult: null, correctVotes: 0, incorrectVotes: 0, sequence, createdAt: serverTimestamp() });
    tx.update(gameRef, {
      phase: 'voting', currentEventId: eventRef.id, currentGuessUid: uid,
      voteEligibleUids: eligible, voteEligibleCount: eligible.length, voteVotedUids: [],
      eventSequence: sequence, version: Number(game.version || 0) + 1,
    });
  });
}

async function castGuessVote(uid, data) {
  const roomRef = roomDocument(data.roomId); const gameRef = gameDocument(data.roomId, data.gameId);
  const memberRef = memberDocument(data.roomId, uid); const eventRef = doc(gameRef, 'events', data.eventId); const voteRef = doc(eventRef, 'votes', uid);
  assert(['correct', 'incorrect'].includes(data.choice), 'invalid-argument', '投票を選んでください。');
  await runTransaction(db, async (tx) => {
    const [roomSnap, gameSnap, memberSnap, eventSnap, voteSnap] = await Promise.all([tx.get(roomRef), tx.get(gameRef), tx.get(memberRef), tx.get(eventRef), tx.get(voteRef)]);
    const room = roomSnap.data(); const game = gameSnap.data(); canPlay(memberSnap.data());
    assert(room?.status === 'active' && game?.status === 'active' && game.phase === 'voting' && game.currentEventId === data.eventId, 'failed-precondition', '現在は投票受付中ではありません。');
    assert(game.voteEligibleUids.includes(uid), 'permission-denied', 'この解答には投票できません。');
    assert(!voteSnap.exists(), 'already-exists', '投票はすでに受け付けられています。');
    tx.set(voteRef, { uid, choice: data.choice, createdAt: serverTimestamp() });
    tx.update(gameRef, { voteVotedUids: [...new Set([...game.voteVotedUids, uid])], version: Number(game.version || 0) + 1 });
  });
  await resolveVotes(uid, data);
}

async function resolveVotes(uid, data) {
  const roomRef = roomDocument(data.roomId); const gameRef = gameDocument(data.roomId, data.gameId);
  const gameSnap = await getDoc(gameRef); const game = gameSnap.data();
  if (!gameSnap.exists() || game.phase !== 'voting' || game.voteVotedUids.length < game.voteEligibleUids.length) return;
  const eventRef = doc(gameRef, 'events', game.currentEventId);
  const voteSnaps = await getDocs(collection(eventRef, 'votes'));
  const correctVotes = voteSnaps.docs.filter((vote) => vote.data().choice === 'correct').length;
  const incorrectVotes = voteSnaps.docs.filter((vote) => vote.data().choice === 'incorrect').length;
  const outcome = correctVotes > incorrectVotes ? 'correct' : 'incorrect';
  const memberRef = memberDocument(data.roomId, uid);
  return runTransaction(db, async (tx) => {
    const [roomSnap, currentGameSnap, eventSnap, memberSnap] = await Promise.all([tx.get(roomRef), tx.get(gameRef), tx.get(eventRef), tx.get(memberRef)]);
    const room = roomSnap.data(); const currentGame = currentGameSnap.data(); canPlay(memberSnap.data());
    if (room?.status !== 'active' || currentGame?.phase !== 'voting' || currentGame.currentEventId !== eventRef.id) return;
    assert(currentGame.voteVotedUids.length === currentGame.voteEligibleUids.length, 'failed-precondition', '投票がそろっていません。');
    const winnerUids = [...(currentGame.winnerUids || [])];
    if (outcome === 'correct' && !winnerUids.includes(currentGame.currentGuessUid)) winnerUids.push(currentGame.currentGuessUid);
    tx.update(eventRef, { voteResult: outcome, correctVotes, incorrectVotes, resolvedAt: serverTimestamp() });
    advanceTurn(tx, roomRef, gameRef, currentGame, winnerUids);
  });
}

async function setSpectatorToPlayer(uid, data) {
  const roomRef = roomDocument(data.roomId); const gameRef = gameDocument(data.roomId, data.gameId); const memberRef = memberDocument(data.roomId, data.targetUid);
  return runTransaction(db, async (tx) => {
    const [roomSnap, gameSnap, memberSnap] = await Promise.all([tx.get(roomRef), tx.get(gameRef), tx.get(memberRef)]);
    const room = roomSnap.data(); const game = gameSnap.data(); canHost(room || {}, uid);
    assert(room?.status === 'finished' && gameSnap.exists(), 'failed-precondition', '次のゲームの準備中にのみ変更できます.');
    const member = memberSnap.data(); assert(member?.status === 'active' && member.role === 'spectator', 'failed-precondition', 'この人は観戦者ではありません。');
    const roster = [...game.nextGamePlayerUids]; if (!roster.includes(data.targetUid)) roster.push(data.targetUid);
    assert(roster.length <= 8, 'resource-exhausted', '次のゲームは8人までです。');
    tx.update(memberRef, { role: 'player', seat: roster.length - 1 });
    tx.update(gameRef, { nextGamePlayerUids: roster, version: Number(game.version || 0) + 1 });
  });
}

async function removeMember(uid, data) {
  assert(data.targetUid !== uid, 'invalid-argument', 'ホストは参加者一覧から削除できません。');
  const roomRef = roomDocument(data.roomId); const gameRef = gameDocument(data.roomId, data.gameId); const memberRef = memberDocument(data.roomId, data.targetUid);
  return runTransaction(db, async (tx) => {
    const [roomSnap, gameSnap, memberSnap] = await Promise.all([tx.get(roomRef), tx.get(gameRef), tx.get(memberRef)]);
    const room = roomSnap.data(); const game = gameSnap.data(); canHost(room || {}, uid);
    assert(room?.status === 'finished' && gameSnap.exists(), 'failed-precondition', '次のゲームの準備中にのみ削除できます。');
    assert(memberSnap.data()?.role !== 'host', 'failed-precondition', 'ホストは削除できません。');
    tx.update(memberRef, { role: 'spectator', status: 'removed' });
    tx.update(gameRef, { nextGamePlayerUids: game.nextGamePlayerUids.filter((playerUid) => playerUid !== data.targetUid), version: Number(game.version || 0) + 1 });
  });
}

async function startNextGame(uid, data) {
  const roomRef = roomDocument(data.roomId); const gameRef = gameDocument(data.roomId, data.gameId);
  const initialGame = await getDoc(gameRef);
  const selected = initialGame.data()?.nextGamePlayerUids || [];
  const memberRefs = selected.map((playerUid) => memberDocument(data.roomId, playerUid));
  const genreId = drawRandomGenre();
  return runTransaction(db, async (tx) => {
    const [roomSnap, gameSnap, ...memberSnaps] = await Promise.all([tx.get(roomRef), tx.get(gameRef), ...memberRefs.map((ref) => tx.get(ref))]);
    const room = roomSnap.data(); const game = gameSnap.data(); canHost(room || {}, uid);
    assert(room?.status === 'finished' && gameSnap.exists(), 'failed-precondition', 'ゲームが終了していません。');
    const roster = game.nextGamePlayerUids;
    assert(roster.length === memberSnaps.length && roster.length >= 2 && roster.length <= 8, 'failed-precondition', '次の参加者は2〜8人にしてください。');
    const players = roster.map((playerUid, index) => {
      const snapshot = memberSnaps[index];
      assert(snapshot.data()?.status === 'active', 'failed-precondition', '参加者一覧に無効なメンバーが含まれています。');
      return { id: playerUid, ref: memberRefs[index], data: snapshot.data() };
    });
    return { gameId: await makeGame(tx, roomRef, room, players.map((p) => ({ id: p.id, ref: p.ref, data: p.data })), genreId) };
  });
}
