const API_BASE = "https://jsonblob.com/api/jsonBlob";
const LS_KEY = "webrtc_room_id";
const ICE_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// ========== JSONBlob API ==========
async function createRoom(data) {
  const res = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error("createRoom failed");
  const location = res.headers.get("Location");
  return location.split("/").pop();
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

// ========== Utils ==========
function waitIceComplete(pc) {
  // Резолвим, когда закончилось iceGathering или пришёл null-candidate
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise(resolve => {
    function done() {
      pc.removeEventListener("icegatheringstatechange", onState);
      pc.removeEventListener("icecandidate", onCand);
      resolve();
    }
    function onState() {
      if (pc.iceGatheringState === "complete") done();
    }
    function onCand(e) {
      if (!e.candidate) done();
    }
    pc.addEventListener("icegatheringstatechange", onState);
    pc.addEventListener("icecandidate", onCand);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========== Host (answerer per client) ==========
let HOST_ROOM_ID = null;
const hostPeers = new Map(); // clientId -> { pc, dc }

async function startHost() {
  // 1) Берём roomId из localStorage или создаём новый
  let rid = localStorage.getItem(LS_KEY);
  if (!rid) {
    rid = await createRoom({ clients: [] });
    localStorage.setItem(LS_KEY, rid);
    console.log("Создан новый roomId:", rid);
  } else {
    console.log("Найден roomId в localStorage:", rid);
  }
  HOST_ROOM_ID = rid;

  // 2) Жёстко обнуляем состояние комнаты (даже если roomId уже был)
  await updateRoom(HOST_ROOM_ID, { clients: [] });
  console.log("Комната очищена:", HOST_ROOM_ID);
  alert("Room ID для клиентов: " + HOST_ROOM_ID);

  // 3) Запускаем опрос клиентов
  pollClientOffers();
}

async function pollClientOffers() {
  while (true) {
    try {
      const room = await getRoom(HOST_ROOM_ID);
      for (const c of room.clients || []) {
        // Ждём только тех, у кого есть offer и ещё нет answer и нет активного pc
        if (c.offer && !c.answer && !hostPeers.has(c.id)) {
          console.log("Новый клиент (offer получен):", c.id);
          await hostAcceptClientOffer(c.id, c.offer, room);
        }
      }
    } catch (err) {
      console.warn("pollClientOffers error:", err);
    }
    await sleep(1500);
  }
}

async function hostAcceptClientOffer(clientId, clientOffer, currentRoomSnapshot) {
  const pc = new RTCPeerConnection(ICE_CONFIG);

  // Host будет получать datachannel от клиента (клиент создаёт канал при offer)
  pc.ondatachannel = (e) => {
    const ch = e.channel;
    hostPeers.set(clientId, { pc, dc: ch });
    setupDataChannel(ch, `Client ${clientId}`);
  };

  // Применяем remote offer клиента
  await pc.setRemoteDescription(clientOffer);

  // Генерируем answer
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceComplete(pc);

  // Пишем answer клиенту (read-modify-write)
  const room = currentRoomSnapshot || await getRoom(HOST_ROOM_ID);
  const idx = room.clients.findIndex(x => x.id === clientId);
  if (idx === -1) {
    room.clients.push({ id: clientId, offer: clientOffer, answer: pc.localDescription });
  } else {
    room.clients[idx].answer = pc.localDescription;
  }
  await updateRoom(HOST_ROOM_ID, room);
  console.log("Answer отправлен для клиента:", clientId);
}

// Отправка сообщений хостом
function hostSendTo(clientId, text) {
  const entry = hostPeers.get(clientId);
  if (entry?.dc?.readyState === "open") entry.dc.send(text);
  else console.warn("Канала нет или не открыт для", clientId);
}

function hostBroadcast(text) {
  for (const [cid, { dc }] of hostPeers.entries()) {
    if (dc?.readyState === "open") dc.send(text);
  }
}

// ========== Client (offerer) ==========
let clientPC = null;
let clientDC = null;
let clientPollTimer = null;

async function startClient(roomId, clientId) {
  // Создаём PC и канал ДО createOffer — чтобы он зашёл в SDP
  clientPC = new RTCPeerConnection(ICE_CONFIG);
  clientDC = clientPC.createDataChannel("chat");
  setupDataChannel(clientDC, "Host");

  // Готовим offer
  const offer = await clientPC.createOffer();
  await clientPC.setLocalDescription(offer);
  await waitIceComplete(clientPC);

  // Пишем/обновляем свою запись в clients[]
  let room = await getRoom(roomId);
  const existing = room.clients.find(c => c.id === clientId);
  if (existing) {
    existing.offer = clientPC.localDescription;
    existing.answer = null; // заново коннектимся — сбрасываем старый answer
  } else {
    room.clients.push({ id: clientId, offer: clientPC.localDescription, answer: null });
  }
  await updateRoom(roomId, room);
  console.log("Offer клиента записан:", clientId);

  // Ждём answer
  if (clientPollTimer) clearInterval(clientPollTimer);
  clientPollTimer = setInterval(async () => {
    try {
      room = await getRoom(roomId);
      const me = room.clients.find(c => c.id === clientId);
      if (me?.answer) {
        clearInterval(clientPollTimer);
        await clientPC.setRemoteDescription(me.answer);
        console.log("Answer получен, соединение установлено для", clientId);
      }
    } catch (e) {
      console.warn("client poll error:", e);
    }
  }, 1200);
}

// ========== DataChannel ==========
function setupDataChannel(channel, label) {
  channel.onopen = () => console.log(`DataChannel открыт (${label})`);
  channel.onmessage = e => console.log(`[${label}]`, e.data);
  channel.onclose = () => console.log(`DataChannel закрыт (${label})`);
  channel.onerror = e => console.warn(`DataChannel ошибка (${label})`, e);
}

// ========== UI helpers ==========
window.startHost = startHost;
window.startClient2 = async () => {
  const roomId = prompt("Room ID:");
  const clientId = prompt("Client ID (уникальный):");
  await startClient(roomId, clientId);
};
window.hostBroadcast = () => {
  const msg = prompt("Broadcast от Host:");
  if (msg != null) hostBroadcast(msg);
};
window.hostSendTo = () => {
  const clientId = prompt("Кому (clientId)?");
  const msg = prompt("Сообщение:");
  if (clientId && msg != null) hostSendTo(clientId, msg);
};
window.clientSend = () => {
  const msg = prompt("Client → Host:");
  if (clientDC?.readyState === "open") clientDC.send(msg);
  else alert("Канал клиента ещё не открыт");
};
