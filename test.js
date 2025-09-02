const API_BASE = "https://jsonblob.com/api/jsonBlob";
const LS_KEY = "webrtc_room_id";
const ICE_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
window.API = window.API || {};

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
  let pollInterval = 2000;
  let fastPoll = false;
  while (true) {
    let hasNewOffers = false;
    try {
      // Ждем завершения запроса, не запускаем следующий до окончания этого
      const room = await getRoom(HOST_ROOM_ID);
      const now = Date.now();
      let changed = false;
      // Удаляем клиентов с offer старше 30 сек и без answer
      room.clients = (room.clients || []).filter(c => {
        if (c.offer && !c.answer && c.offerTimestamp && now - c.offerTimestamp > 30000) {
          changed = true;
          console.log("Удаляем просроченного клиента:", c.id);
          return false;
        }
        return true;
      });
      if (changed) await updateRoom(HOST_ROOM_ID, room);

      for (const c of room.clients || []) {
        if (c.offer && !c.answer && !hostPeers.has(c.id)) {
          hasNewOffers = true;
          console.log("Новый клиент:", c.id);
          await hostAcceptClientOffer(c.id, c.offer);
        }
      }
    } catch (err) {
      console.warn("pollClientOffers error:", err);
    }
    // Если есть новые offers — ускоряемся
    if (hasNewOffers) {
      pollInterval = 400;
      fastPoll = true;
    } else if (fastPoll) {
      // Если новых нет, возвращаемся к медленному режиму
      pollInterval = 2000;
      fastPoll = false;
    }
    await sleep(pollInterval);
  }
}

async function hostAcceptClientOffer(clientId, clientOffer) {
  const pc = new RTCPeerConnection(ICE_CONFIG);

  pc.ondatachannel = (e) => {
    const ch = e.channel;
    hostPeers.set(clientId, { pc, dc: ch });
    setupDataChannel(ch, `Client ${clientId}`);
  };

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
  const now = Date.now();
  if (existing) {
    existing.offer = clientPC.localDescription;
    existing.answer = null;
    existing.candidates = [];
    existing.offerTimestamp = now;
  } else {
    room.clients.push({
      id: clientId,
      offer: clientPC.localDescription,
      answer: null,
      candidates: [],
      offerTimestamp: now
    });
  }
  await updateRoom(roomId, room);

  // Заменяем setInterval на асинхронный цикл с await
  if (clientPollTimer) clearInterval(clientPollTimer);
  let answerReceived = false;
  (async function pollAnswer() {
    while (!answerReceived) {
      try {
        room = await getRoom(roomId);
        const me = room.clients.find(c => c.id === clientId);
        if (me?.answer) {
          await clientPC.setRemoteDescription(me.answer);
          answerReceived = true;
          console.log("Answer получен:", clientId);
          pollClientCandidates(clientPC, clientId, "hostCandidates", roomId);
        }
      } catch (e) {
        console.warn("client poll error:", e);
      }
      if (!answerReceived) await sleep(1500);
    }
  })();
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
let rtcMessageHandler = null;
let rtcOpenHandler = null;
let rtcCloseHandler = null;
let rtcErrorHandler = null;

window.onRTCMessage = (fromId, text) => {
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
parsed
  if (typeof rtcMessageHandler === "function") {
    rtcMessageHandler(fromId, parsed);
  }
};

window.onRTCOpen = (fromId) => {
  console.log(`Канал открыт с ${fromId}`);
  if (typeof rtcOpenHandler === "function") {
    rtcOpenHandler(fromId);
  }
};

window.onRTCClose = (fromId) => {
  console.log(`Канал закрыт с ${fromId}`);
  if (typeof rtcCloseHandler === "function") {
    rtcCloseHandler(fromId);
  }
};

window.onRTCError = (fromId, error) => {
  console.warn(`Ошибка канала с ${fromId}:`, error);
  if (typeof rtcErrorHandler === "function") {
    rtcErrorHandler(fromId, error);
  }
};

function setupDataChannel(channel, label, id = label) {
  channel.onopen = () => window.onRTCOpen?.(id);
  channel.onmessage = e => window.onRTCMessage?.(id, e.data);
  channel.onclose = () => window.onRTCClose?.(id);
  channel.onerror = e => window.onRTCError?.(id, e);
}

// ===== Определение роли =====
function getRole() {
  const hasRoomId = !!localStorage.getItem(LS_KEY);
  const hasClientPC = typeof clientPC !== "undefined" && clientPC !== null;
  if (hasRoomId && !hasClientPC) return "host";
  if (hasClientPC) return "client";
  return "none";
}
function isHost() { return getRole() === "host"; }
function isClient() { return getRole() === "client"; }

// ===== Универсальная отправка =====
function sendMessage(data, toClientId = null, exceptClientId = null) {
  const payload = (typeof data === "object") ? JSON.stringify(data) : String(data);
  if (isHost()) {
    if (toClientId) {
      if (toClientId !== exceptClientId) {
        const peer = hostPeers.get(toClientId);
        if (peer?.dc?.readyState === "open") peer.dc.send(payload);
      }
    } 
    if(!toClientId && exceptClientId) {
      for (const [clientId, { dc }] of hostPeers.entries()) {
        if (clientId !== exceptClientId && dc?.readyState === "open") dc.send(payload);
      }
    }
  } else if (isClient()) {
    if (clientDC?.readyState === "open") clientDC.send(payload);
  } else {
    console.warn("Не определена роль — сообщение не отправлено");
  }
}

// ===== API =====
window.API = {
  startHost,
  startClient,
  sendMessage,
  getRole,
  isHost,
  isClient,
  hostBroadcast: (msg) => sendMessage(msg),
  clientSend: (msg) => sendMessage(msg),
  onRTCMessage: (handler) => { rtcMessageHandler = handler; },
  onRTCOpen: (handler) => { rtcOpenHandler = handler; },
  onRTCClose: (handler) => { rtcCloseHandler = handler; },
  onRTCError: (handler) => { rtcErrorHandler = handler; }
};
