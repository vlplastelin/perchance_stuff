const API_BASE = "https://jsonblob.com/api/jsonBlob";
const LS_KEY = "webrtc_room_id";
const ICE_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// ===== JSONBlob API =====
async function createRoom(data) {
  const res = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error("createRoom failed");
  return res.headers.get("Location").split("/").pop();
}

async function getRoom(roomId) {
  const res = await fetch(`${API_BASE}/${roomId}`);
  if (!res.ok) throw new Error("getRoom failed");
  return res.json();
}

async function updateRoom(roomId, data) {
  const res = await fetch(`${API_BASE}/${roomId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error("updateRoom failed");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== Host =====
let HOST_ROOM_ID = null;
const hostPeers = new Map(); // clientId -> { pc, dc }

async function startHost() {
  let rid = localStorage.getItem(LS_KEY);
  if (!rid) {
    rid = await createRoom({ clients: [] });
    localStorage.setItem(LS_KEY, rid);
    console.log("Создан новый roomId:", rid);
  } else {
    console.log("Найден roomId:", rid);
  }
  HOST_ROOM_ID = rid;

  await updateRoom(HOST_ROOM_ID, { clients: [] });
  console.log("Комната очищена:", HOST_ROOM_ID);

  pollClientOffers();
  return HOST_ROOM_ID;
}

async function pollClientOffers() {
  while (true) {
    try {
      const room = await getRoom(HOST_ROOM_ID);
      for (const c of room.clients || []) {
        if (c.offer && !c.answer && !hostPeers.has(c.id)) {
          console.log("Новый клиент:", c.id);
          await hostAcceptClientOffer(c.id, c.offer);
        }
      }
    } catch (err) {
      console.warn("pollClientOffers error:", err);
    }
    await sleep(400);
  }
}

async function hostAcceptClientOffer(clientId, clientOffer) {
  const pc = new RTCPeerConnection(ICE_CONFIG);

  pc.ondatachannel = (e) => {
    const ch = e.channel;
    hostPeers.set(clientId, { pc, dc: ch });
    setupDataChannel(ch, `Client ${clientId}`);
  };

  // Trickle ICE — отправляем кандидатов по мере появления
  pc.onicecandidate = async (e) => {
    if (e.candidate) {
      let room = await getRoom(HOST_ROOM_ID);
      const cli = room.clients.find(c => c.id === clientId);
      if (cli) {
        cli.hostCandidates = cli.hostCandidates || [];
        cli.hostCandidates.push(e.candidate);
        await updateRoom(HOST_ROOM_ID, room);
      }
    }
  };

  await pc.setRemoteDescription(clientOffer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  let room = await getRoom(HOST_ROOM_ID);
  const idx = room.clients.findIndex(x => x.id === clientId);
  if (idx === -1) {
    room.clients.push({ id: clientId, offer: clientOffer, answer: pc.localDescription });
  } else {
    room.clients[idx].answer = pc.localDescription;
  }
  await updateRoom(HOST_ROOM_ID, room);

  // Подгружаем кандидаты клиента
  pollClientCandidates(pc, clientId, "candidates");
}

// ===== Client =====
let clientPC = null;
let clientDC = null;
let clientPollTimer = null;

async function startClient(roomId, clientId) {
  clientPC = new RTCPeerConnection(ICE_CONFIG);
  clientDC = clientPC.createDataChannel("chat");
  setupDataChannel(clientDC, "Host");

  clientPC.onicecandidate = async (e) => {
    if (e.candidate) {
      let room = await getRoom(roomId);
      const me = room.clients.find(c => c.id === clientId);
      if (me) {
        me.candidates = me.candidates || [];
        me.candidates.push(e.candidate);
        await updateRoom(roomId, room);
      }
    }
  };

  const offer = await clientPC.createOffer();
  await clientPC.setLocalDescription(offer);

  let room = await getRoom(roomId);
  const existing = room.clients.find(c => c.id === clientId);
  if (existing) {
    existing.offer = clientPC.localDescription;
    existing.answer = null;
    existing.candidates = [];
  } else {
    room.clients.push({ id: clientId, offer: clientPC.localDescription, answer: null, candidates: [] });
  }
  await updateRoom(roomId, room);

  if (clientPollTimer) clearInterval(clientPollTimer);
  clientPollTimer = setInterval(async () => {
    try {
      room = await getRoom(roomId);
      const me = room.clients.find(c => c.id === clientId);
      if (me?.answer) {
        await clientPC.setRemoteDescription(me.answer);
        clearInterval(clientPollTimer);
        console.log("Answer получен:", clientId);
        pollClientCandidates(clientPC, clientId, "hostCandidates", roomId);
      }
    } catch (e) {
      console.warn("client poll error:", e);
    }
  }, 400);
}

// ===== Кандидаты =====
async function pollClientCandidates(pc, clientId, field, roomId = HOST_ROOM_ID) {
  const seen = new Set();
  while (true) {
    try {
      const room = await getRoom(roomId);
      const cli = room.clients.find(c => c.id === clientId);
      if (cli && cli[field]) {
        for (const cand of cli[field]) {
          const key = JSON.stringify(cand);
          if (!seen.has(key)) {
            seen.add(key);
            await pc.addIceCandidate(cand);
          }
        }
      }
    } catch (err) {
      console.warn("poll candidates error:", err);
    }
    await sleep(400);
  }
}

// ===== DataChannel =====
// Глобальные колбэки (можно переопределить в коде страницы)
window.onRTCMessage = (fromId, text) => {
  console.log(`Сообщение от ${fromId}:`, text);
};

window.onRTCOpen = (fromId) => {
  console.log(`Канал открыт с ${fromId}`);
};

window.onRTCClose = (fromId) => {
  console.log(`Канал закрыт с ${fromId}`);
};

window.onRTCError = (fromId, error) => {
  console.warn(`Ошибка канала с ${fromId}:`, error);
};

// Универсальная настройка канала
function setupDataChannel(channel, label, id = label) {
  channel.onopen = () => window.onRTCOpen?.(id);
  channel.onmessage = e => window.onRTCMessage?.(id, e.data);
  channel.onclose = () => window.onRTCClose?.(id);
  channel.onerror = e => window.onRTCError?.(id, e);
}

// ===== UI =====
window.startHost = startHost;
window.startClient = startClient;
window.hostBroadcast = () => {
  const msg = prompt("Broadcast от Host:");
  if (msg != null) {
    for (const { dc } of hostPeers.values()) {
      if (dc?.readyState === "open") dc.send(msg);
    }
  }
};
window.clientSend = () => {
  const msg = prompt("Client → Host:");
  if (clientDC?.readyState === "open") clientDC.send(msg);
  else alert("Канал клиента ещё не открыт");
};
