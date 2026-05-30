/*
 * スパルタクス LocalCAST server v1.0.6
 */
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const VERSION = '1.0.6';
const PORT = Number(process.env.PORT || 3000);
const COLORS = ['#d04b3f','#4a91d1','#53a86b','#caa03e','#8b68d8'];
const DEFAULT_NAMES = ['プレイヤー1','プレイヤー2','プレイヤー3','プレイヤー4','プレイヤー5'];
const CARD_B = 'B';
const rooms = new Map();
let eventSeq = 1;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.json({ ok: true, app: 'spartacus-localcast', version: VERSION }));

function deck(){ return [1,2,3,4,5,6,7,8,9,10,CARD_B]; }
function isB(card){ return card === CARD_B; }
function cardLabel(card){ return isB(card) ? 'B' : String(card); }
function sortHand(hand){ return hand.slice().sort((a,b)=> (isB(a)?99:a) - (isB(b)?99:b)); }
function mod(n,m){ return ((n % m) + m) % m; }
function scoreCards(cards){ const sum = cards.reduce((acc,c)=> acc + (isB(c.card) ? 0 : Number(c.card)), 0); const b = cards.filter(c=>isB(c.card)).length; return sum * Math.pow(2,b); }
function scoreHandPenalty(hand){ const sum = hand.reduce((acc,c)=> acc + (isB(c) ? 0 : Number(c)), 0); const b = hand.filter(isB).length; return -(sum * Math.pow(2,b)); }
function trickSummary(cards){ const nums = cards.filter(c=>!isB(c.card)).map(c=>c.card).join('+') || '0'; const b = cards.filter(c=>isB(c.card)).length; return b ? `${nums} × ${Math.pow(2,b)}` : nums; }
function addLog(s, text){ s.logs.unshift(text); s.logs = s.logs.slice(0,100); }
function makeEvent(kind, data={}){ return Object.assign({ id: eventSeq++, kind }, data); }
function roomCode(){ let code; do { code = Math.random().toString(36).slice(2,6).toUpperCase(); } while(rooms.has(code)); return code; }
function findRoomBySocket(socketId){ for(const room of rooms.values()){ if(room.players.some(p=>p.socketId === socketId)) return room; } return null; }
function findPlayer(room, socketId){ return room.players.find(p=>p.socketId === socketId); }
function createState({playerCount=4, names=[], starterMode='random', hideHands=false}={}){
  const players = Array.from({length:playerCount},(_,i)=>({ id:i, name:(names[i] || DEFAULT_NAMES[i]).trim() || DEFAULT_NAMES[i], color:COLORS[i], hand:deck(), captured:[], passed:false }));
  const starter = starterMode === 'p1' ? 0 : Math.floor(Math.random()*playerCount);
  return { version: VERSION, phase:'playing', playerCount, players, leaderIndex:starter, currentPlayerIndex:starter, trickNo:1, currentTrick:{cards:[], currentLowest:null, lowestPlayer:null, active:Array(playerCount).fill(true)}, hideHands, turnUnlocked:true, logs:[`${players[starter].name}から開始します。`], final:null };
}
function getActiveIndexes(s){ return s.players.map((p,i)=>s.currentTrick.active[i] && p.hand.length>0 ? i : null).filter(i=>i!==null); }
function getLegalCardsForState(s, playerIndex){ const p = s.players[playerIndex]; if(!p || s.phase !== 'playing' || !s.currentTrick.active[playerIndex]) return []; const lowest = s.currentTrick.currentLowest; return sortHand(p.hand).filter(card => isB(card) || lowest === null || Number(card) < lowest); }
function canManualPassForState(s, playerIndex=s.currentPlayerIndex){ return !!(s && s.phase === 'playing' && s.currentTrick.active[playerIndex] && s.currentTrick.cards.length > 0); }
function findNextActive(s, fromIndex){ for(let step=1; step<=s.playerCount; step++){ const idx = mod(fromIndex + step, s.playerCount); if(s.currentTrick.active[idx] && s.players[idx].hand.length > 0) return idx; } return fromIndex; }
function removeCardFromHand(hand, card){ const idx = hand.findIndex(c=>String(c)===String(card)); if(idx < 0) return false; hand.splice(idx,1); return true; }
function startNewTrick(s, leader){ s.trickNo += 1; s.leaderIndex = leader; s.currentPlayerIndex = leader; s.currentTrick = {cards:[], currentLowest:null, lowestPlayer:null, active:Array(s.playerCount).fill(true)}; s.players.forEach(p=>p.passed=false); addLog(s, `第${s.trickNo}トリック開始。${s.players[leader].name}がリードします。`); }
function chooseWinner(s){ if(s.currentTrick.lowestPlayer !== null && s.currentTrick.lowestPlayer !== undefined) return s.currentTrick.lowestPlayer; const active = getActiveIndexes(s); if(active.length) return active[0]; if(s.currentTrick.cards.length) return s.currentTrick.cards[s.currentTrick.cards.length-1].player; return s.leaderIndex; }
function computeScoresForState(s){ return s.players.map((p,i)=>{ const capturedDetails = p.captured.map((cards,idx)=>({ index:idx+1, formula:trickSummary(cards), points:scoreCards(cards), cards:cards.map(c=>c.card) })); const capturedScore = capturedDetails.reduce((a,d)=>a+d.points,0); const penalty = scoreHandPenalty(p.hand); return {playerIndex:i,name:p.name,color:p.color,capturedScore,penalty,total:capturedScore+penalty,remaining:sortHand(p.hand),tricks:p.captured.length,details:capturedDetails}; }).sort((a,b)=> b.total - a.total || b.capturedScore - a.capturedScore || a.playerIndex - b.playerIndex); }
function resolveCurrentTrick(room, s, {gameEnd=false}={}){ if(!s.currentTrick.cards.length) return null; const winner = chooseWinner(s); const cards = s.currentTrick.cards.slice(); const points = scoreCards(cards); s.players[winner].captured.push(cards); const formula = trickSummary(cards); const winnerName = s.players[winner].name; addLog(s, `${winnerName}が第${s.trickNo}トリックを獲得（${formula} = ${points}点）。`); room.lastEvent = makeEvent('score', {name:winnerName, player:winner, points, formula}); s.currentTrick.cards = []; if(gameEnd) return winner; const nextLeader = mod(winner + 1, s.playerCount); startNewTrick(s, nextLeader); return winner; }
function finishGame(room, s){ resolveCurrentTrick(room, s,{gameEnd:true}); s.phase = 'gameover'; s.players.forEach(p=>p.passed=false); s.final = computeScoresForState(s); const top = s.final[0]; addLog(s, `ゲーム終了。勝者は${top.name}、${top.total}点です。`); room.lastEvent = makeEvent('gameover', {name:top.name, total:top.total}); }
function autoPassIfNoLegal(room, s){ let count = 0; const guardLimit = s.playerCount + 2; while(s.phase === 'playing' && count < guardLimit){ const idx = s.currentPlayerIndex; if(!canManualPassForState(s, idx)) break; if(getLegalCardsForState(s, idx).length > 0) break; s.currentTrick.active[idx] = false; s.players[idx].passed = true; count += 1; const name = s.players[idx].name; addLog(s, `${name}は出せるカードがないため、自動的にパスしました。`); room.lastEvent = makeEvent('autoPass', {name, player:idx}); const active = getActiveIndexes(s); if(active.length <= 1){ resolveCurrentTrick(room, s); break; } s.currentPlayerIndex = findNextActive(s, idx); } return count; }
function playCardCore(room, card, actor){ const s = room.gameState; if(s.phase !== 'playing') return {ok:false, message:'ゲームは終了しています。'}; const idx = s.currentPlayerIndex; if(actor !== idx) return {ok:false, message:'現在はあなたの手番ではありません。'}; const player = s.players[idx]; const normalized = card === CARD_B || String(card).toUpperCase()==='B' ? CARD_B : Number(card); const legal = getLegalCardsForState(s, idx).map(String); if(!legal.includes(String(normalized))) return {ok:false, message:'このカードは現在出せません。'}; if(!removeCardFromHand(player.hand, normalized)) return {ok:false, message:'手札にそのカードがありません。'}; s.currentTrick.cards.push({player:idx, card:normalized}); if(!isB(normalized)){ const v = Number(normalized); if(s.currentTrick.currentLowest === null || v < s.currentTrick.currentLowest){ s.currentTrick.currentLowest = v; s.currentTrick.lowestPlayer = idx; } } addLog(s, `${player.name}が「${cardLabel(normalized)}」を出しました。`); room.lastEvent = makeEvent('play', {name:player.name, player:idx, card:normalized}); if(player.hand.length === 0){ addLog(s, `${player.name}の手札がなくなったためゲーム終了です。場札を精算します。`); finishGame(room, s); return {ok:true, ended:true}; } const active = getActiveIndexes(s); if(active.length <= 1 && s.currentTrick.cards.length){ resolveCurrentTrick(room, s); return {ok:true, resolved:true}; } s.currentPlayerIndex = findNextActive(s, idx); autoPassIfNoLegal(room, s); return {ok:true}; }
function passCore(room, actor){ const s = room.gameState; if(s.phase !== 'playing') return {ok:false,message:'ゲームは終了しています。'}; const idx = s.currentPlayerIndex; if(actor !== idx) return {ok:false, message:'現在はあなたの手番ではありません。'}; if(!s.currentTrick.active[idx]) return {ok:false,message:'すでにパスしています。'}; if(!canManualPassForState(s, idx)) return {ok:false,message:'各トリックの初手はパスできません。まずカードを1枚出してください。'}; s.currentTrick.active[idx] = false; s.players[idx].passed = true; addLog(s, `${s.players[idx].name}がパスしました。`); room.lastEvent = makeEvent('pass', {name:s.players[idx].name, player:idx}); const active = getActiveIndexes(s); if(active.length <= 1){ resolveCurrentTrick(room, s); return {ok:true,resolved:true}; } s.currentPlayerIndex = findNextActive(s, idx); autoPassIfNoLegal(room, s); return {ok:true}; }
function publicLobby(room, socketId){ return { roomCode: room.code, started: !!room.gameState, isHost: room.hostSocketId === socketId, players: room.players.map(p=>({seat:p.seat, name:p.name, color:p.color, connected:p.connected, isHost:p.socketId === room.hostSocketId}))}; }
function redactedState(room, viewerSeat){ const s = JSON.parse(JSON.stringify(room.gameState)); s.players.forEach((p,i)=>{ if(i !== viewerSeat && s.phase !== 'gameover'){ p.hand = Array(p.hand.length).fill('?'); } }); return s; }
function broadcastLobby(room){ for(const p of room.players){ io.to(p.socketId).emit('room:lobby', publicLobby(room, p.socketId)); } }
function broadcastGame(room){ if(!room.gameState) { broadcastLobby(room); return; } for(const p of room.players){ io.to(p.socketId).emit('game:state', {roomCode:room.code, mySeat:p.seat, isHost:p.socketId===room.hostSocketId, state:redactedState(room,p.seat), event:room.lastEvent || null}); } }

io.on('connection', socket => {
  socket.on('room:create', ({name}={}) => {
    const existing = findRoomBySocket(socket.id); if(existing) return socket.emit('room:error', 'すでに部屋に参加しています。ページを更新してから試してください。');
    const code = roomCode();
    const room = { code, hostSocketId: socket.id, players:[{seat:0, socketId:socket.id, name:String(name || 'プレイヤー1').slice(0,18), color:COLORS[0], connected:true}], gameState:null, lastEvent:null };
    rooms.set(code, room); socket.join(code);
    socket.emit('room:joined', {roomCode:code, mySeat:0, isHost:true}); broadcastLobby(room);
  });
  socket.on('room:join', ({roomCode, name}={}) => {
    const code = String(roomCode || '').trim().toUpperCase(); const room = rooms.get(code);
    if(!room) return socket.emit('room:error', 'そのルームIDの部屋が見つかりません。');
    if(room.gameState) return socket.emit('room:error', 'この部屋はすでに対戦中です。');
    if(room.players.length >= 5) return socket.emit('room:error', 'この部屋は満席です。');
    const seat = room.players.length;
    room.players.push({seat, socketId:socket.id, name:String(name || DEFAULT_NAMES[seat]).slice(0,18), color:COLORS[seat], connected:true});
    socket.join(code); socket.emit('room:joined', {roomCode:code, mySeat:seat, isHost:false}); broadcastLobby(room);
  });
  socket.on('game:start', ({playerCount, starterMode, hideHands}={}) => {
    const room = findRoomBySocket(socket.id); if(!room) return socket.emit('room:error','部屋に参加していません。');
    if(room.hostSocketId !== socket.id) return socket.emit('room:error','オンライン開始はホストだけができます。');
    const count = Number(playerCount || 4); if(count < 3 || count > 5) return socket.emit('room:error','人数は3〜5人にしてください。');
    if(room.players.length < count) return socket.emit('room:error',`設定人数${count}人に対して参加者が${room.players.length}人です。`);
    const names = room.players.slice(0,count).map(p=>p.name);
    room.gameState = createState({playerCount:count, names, starterMode, hideHands:false});
    room.lastEvent = makeEvent('start', {name:'開始'});
    broadcastGame(room);
  });
  socket.on('game:action', payload => {
    const room = findRoomBySocket(socket.id); if(!room || !room.gameState) return socket.emit('room:error','対戦中の部屋がありません。');
    const player = findPlayer(room, socket.id); if(!player || player.seat >= room.gameState.playerCount) return socket.emit('room:error','この対戦の参加席ではありません。');
    let result;
    if(payload && payload.type === 'playCard') result = playCardCore(room, payload.card, player.seat);
    else if(payload && payload.type === 'pass') result = passCore(room, player.seat);
    else result = {ok:false, message:'不明な操作です。'};
    if(!result.ok) return socket.emit('room:error', result.message);
    broadcastGame(room);
  });
  socket.on('room:reset', () => {
    const room = findRoomBySocket(socket.id); if(!room) return;
    if(room.hostSocketId !== socket.id) return socket.emit('room:error','最初から始める操作はホストだけができます。');
    room.gameState = null; room.lastEvent = null;
    for(const p of room.players){ io.to(p.socketId).emit('room:resetDone', {lobby:publicLobby(room,p.socketId)}); }
    broadcastLobby(room);
  });
  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket.id); if(!room) return;
    const player = findPlayer(room, socket.id); if(player) player.connected = false;
    if(room.hostSocketId === socket.id){
      const next = room.players.find(p=>p.connected); if(next) room.hostSocketId = next.socketId;
    }
    if(room.players.every(p=>!p.connected)) rooms.delete(room.code); else broadcastLobby(room);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Spartacus LocalCAST v${VERSION} listening on http://localhost:${PORT}`);
});
