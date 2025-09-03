(function(){
const SIGNAL_URL = 'https://jsonblob.com/api/jsonBlob';
let peerConnection = null;
let dataChannel = null;
let roomId = null;
let isHost = false;
let polling = null;
let onMessageCb = null;
let clientId = null;
let onConnectCb = null;
let onLeaveCb = null;
let onHostReadyCb = null;
let onClientReadyCb = null;
let clientRetryInterval = null;
let clientRetryTimeout = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function createRoom() {
  const res = await fetch(SIGNAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({host: {}, clients: []})
  });
  roomId = res.headers.get('Location').split('/').pop();
  localStorage.setItem('webrtc_room_id', roomId);
  return roomId;
}

async function getRoom(roomId) {
  const res = await fetch(SIGNAL_URL + '/' + roomId);
  return await res.json();
}

async function updateRoom(roomId, data) {
  await fetch(SIGNAL_URL + '/' + roomId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

function setupPeerConnection() {
  peerConnection = new RTCPeerConnection();
  peerConnection.onicecandidate = async (event) => {
    if (event.candidate) {
      let room = await getRoom(roomId);
      if (isHost) {
        room.host.candidates = room.host.candidates || [];
        room.host.candidates.push(event.candidate);
      } else {
        let client = room.clients.find(c => c.clientId === clientId);
        if (client) {
          client.candidates = client.candidates || [];
          client.candidates.push(event.candidate);
        }
      }
      await updateRoom(roomId, room);
    }
  };
  peerConnection.ondatachannel = e => {
    dataChannel = e.channel;
    dataChannel.onmessage = e => onMessageCb && onMessageCb(e.data);
    dataChannel.onopen = () => onConnectCb && onConnectCb();
    dataChannel.onclose = () => onLeaveCb && onLeaveCb();
  };
}

function setupDataChannel() {
  dataChannel = peerConnection.createDataChannel('chat');
  dataChannel.onmessage = e => onMessageCb && onMessageCb(e.data);
  dataChannel.onopen = () => onConnectCb && onConnectCb();
  dataChannel.onclose = () => onLeaveCb && onLeaveCb();
}

async function addRemoteCandidates(room) {
  const candidates = isHost
    ? (room.clients.find(c => c.clientId === clientId)?.candidates || [])
    : (room.host.candidates || []);
  for (let c of candidates) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(c));
    } catch (e) {}
  }
}

async function startHost() {
  isHost = true;
  roomId = localStorage.getItem('webrtc_room_id');
  if (!roomId) roomId = await createRoom();
  setupPeerConnection();
  setupDataChannel();
  window.rtc._dataChannels = window.rtc._dataChannels || {};
  await updateRoom(roomId, {host: {}, clients: []});

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  // Ждём, пока offer будет полностью установлен
  await sleep(500);

  let room = await getRoom(roomId);
  room.host.offer = {
    type: peerConnection.localDescription.type,
    sdp: peerConnection.localDescription.sdp
  };
  await updateRoom(roomId, room);

  if (onHostReadyCb) onHostReadyCb(roomId);
  return roomId;
}

function generateClientId() {
  return 'client_' + Date.now() + '_' + Math.floor(Math.random()*100000);
}

async function startClient(inputRoomId, timeoutSec = 30, pollIntervalMs = 2000) {
  isHost = false;
  roomId = inputRoomId;
  clientId = generateClientId();
  setupPeerConnection();

  let room = await getRoom(roomId);
let retries = 10;
let offer = null;

while (retries-- > 0) {
  const room = await getRoom(roomId);
  offer = room?.host?.offer;
  if (offer?.type && offer?.sdp) break;
  await sleep(1000);
}

if (!offer || !offer.sdp || !offer.type) {
  console.error('Offer не найден или некорректен после ожидания');
  return;
}

await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  room.clients = room.clients || [];
  room.clients.push({answer, clientId});
  await updateRoom(roomId, room);
  await sleep(1000);
  await addRemoteCandidates(room);
  if (onClientReadyCb) onClientReadyCb(roomId, clientId);

  let start = Date.now();
  clientRetryTimeout = setTimeout(() => {
    if (clientRetryInterval) clearInterval(clientRetryInterval);
  }, timeoutSec * 1000);
  clientRetryInterval = setInterval(async () => {
    if (dataChannel && dataChannel.readyState === 'open') {
      clearInterval(clientRetryInterval);
      clearTimeout(clientRetryTimeout);
      return;
    }
    let room = await getRoom(roomId);
    await addRemoteCandidates(room);
    if ((Date.now()-start)/1000 > timeoutSec) {
      clearInterval(clientRetryInterval);
      clearTimeout(clientRetryTimeout);
    }
  }, pollIntervalMs);
}

function sendMessage(json, toId = null, excludeId = null) {
  if (!isHost) {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify(json));
    }
    return;
  }
  if (typeof window.rtc._dataChannels === 'object') {
    const channels = window.rtc._dataChannels;
    if (toId && channels[toId]) {
      channels[toId].send(JSON.stringify(json));
    } else {
      Object.entries(channels).forEach(([id, ch]) => {
        if (excludeId && id === excludeId) return;
        ch.send(JSON.stringify(json));
      });
    }
  } else {
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify(json));
    }
  }
}

function onMessage(cb) {
  onMessageCb = function(raw) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch(e) {
      obj = { msg: raw };
    }
    const senderId = obj.from || obj.clientId || null;
    cb(obj, senderId);
  };
}

async function waitForClients(timeoutSec = 30, pollIntervalMs = 2000) {
  let start = Date.now();
  let room;
  polling = setInterval(async () => {
    room = await getRoom(roomId);
    if (room.clients && room.clients.length) {
      for (let client of room.clients) {
        if (client.answer && !peerConnection.currentRemoteDescription) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(client.answer));
          await addRemoteCandidates(room);
        }
      }
    }
    if ((Date.now()-start)/1000 > timeoutSec) {
      clearInterval(polling);
      room.clients = (room.clients||[]).filter(c=>!!c.answer);
      await updateRoom(roomId, room);
    }
  }, pollIntervalMs);
}

function onConnect(cb) { onConnectCb = cb; }
function onLeave(cb) { onLeaveCb = cb; }
function onHostReady(cb) { onHostReadyCb = cb; }
function onClientReady(cb) { onClientReadyCb = cb; }
function retry(timeoutSec = 30, pollIntervalMs = 2000) {
  if (clientRetryInterval) clearInterval(clientRetryInterval);
  if (clientRetryTimeout) clearTimeout(clientRetryTimeout);
  startClient(roomId, timeoutSec, pollIntervalMs);
}

window.rtc = {
  startHost,
  startClient,
  sendMessage,
  onMessage,
  waitForClients,
  onConnect,
  onLeave,
  onHostReady,
  onClientReady,
  retry
};
})();
