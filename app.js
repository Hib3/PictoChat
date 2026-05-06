import { joinRoom } from "https://esm.sh/trystero@0.21.8/torrent?bundle";

const ROOMS = ["A", "B", "C", "D"];
const APP_ID = `pictochat-online-${location.host}${location.pathname}`.replace(/[^a-z0-9_-]/gi, "-");
const rtcConfig = {
  appId: APP_ID,
  password: APP_ID,
  rtcConfig: {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  }
};

const state = {
  id: makeId(),
  name: `user${Math.floor(100000 + Math.random() * 900000)}`,
  color: "#99ff00",
  selectedRoom: null,
  lobby: null,
  sendLobby: null,
  room: null,
  sendChat: null,
  peers: new Map(),
  messages: [[], [], [], []],
  drawing: false,
  erasing: false
};

const $ = (selector) => document.querySelector(selector);
const loginView = $("#loginView");
const roomView = $("#roomView");
const chatView = $("#chatView");
const loginForm = $("#loginForm");
const nameInput = $("#nameInput");
const colorButton = $("#colorButton");
const roomCards = [...document.querySelectorAll(".room-card")];
const countLabels = [...document.querySelectorAll("[data-count]")];
const messages = $("#messages");
const roomBackButton = $("#roomBackButton");
const canvas = $("#drawCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const sendButton = $("#sendButton");
const penButton = $("#penButton");
const eraseButton = $("#eraseButton");
const clearButton = $("#clearButton");
const keyboard = $("#keyboard");
const backspaceButton = $("#backspaceButton");
const draftName = $("#draftName");
const draftInput = $("#draftInput");

nameInput.value = state.name;
colorButton.style.background = state.color;
applyAccentColor(state.color);
setupCanvas();
setupKeyboard();
registerServiceWorker();

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim().slice(0, 16);
  if (!name) return;
  state.name = name;
  draftName.textContent = name;
  loginView.classList.add("is-hidden");
  roomView.classList.remove("is-hidden");
  joinLobby();
});

colorButton.addEventListener("click", () => {
  state.color = randomColor();
  colorButton.style.background = state.color;
  applyAccentColor(state.color);
  sendLobbyStatus();
});

roomCards.forEach((card) => {
  card.addEventListener("click", () => joinChatRoom(Number(card.dataset.room)));
});

roomBackButton.addEventListener("click", () => {
  leaveChatRoom();
  chatView.classList.add("is-hidden");
  roomView.classList.remove("is-hidden");
  sendLobbyStatus();
});

penButton.addEventListener("click", () => setTool(false));
eraseButton.addEventListener("click", () => setTool(true));
clearButton.addEventListener("click", clearCanvas);
sendButton.addEventListener("click", sendCurrentMessage);
backspaceButton.addEventListener("click", () => editText("backspace"));

function joinLobby() {
  if (state.lobby) return;
  const lobby = joinRoom(rtcConfig, "lobby", (error) => {
    addSystemMessage(`接続エラー: ${error?.message || "不明"}`);
  });
  const [sendLobby, getLobby] = lobby.makeAction("presence");
  state.lobby = lobby;
  state.sendLobby = sendLobby;

  lobby.onPeerJoin((peerId) => {
    sendLobbyStatus(peerId);
  });

  lobby.onPeerLeave((peerId) => {
    state.peers.delete(peerId);
    renderCounts();
  });

  getLobby((data, peerId) => {
    if (!data?.id) return;
    state.peers.set(peerId, data);
    renderCounts();
    sendLobbyStatus(peerId);
  });

  sendLobbyStatus();
  renderCounts();
}

function sendLobbyStatus(peerId) {
  if (!state.sendLobby) return;
  const payload = {
    id: state.id,
    name: state.name,
    color: state.color,
    room: state.selectedRoom
  };
  state.sendLobby(payload, peerId).catch(() => {});
}

function renderCounts() {
  const counts = [0, 0, 0, 0];
  if (state.selectedRoom !== null) counts[state.selectedRoom] += 1;
  for (const peer of state.peers.values()) {
    if (Number.isInteger(peer.room) && peer.room >= 0 && peer.room < 4) counts[peer.room] += 1;
  }
  countLabels.forEach((label, index) => {
    label.textContent = counts[index];
  });
}

function joinChatRoom(roomIndex) {
  leaveChatRoom();
  state.selectedRoom = roomIndex;
  roomBackButton.textContent = ROOMS[roomIndex];
  roomView.classList.add("is-hidden");
  chatView.classList.remove("is-hidden");
  renderMessages();
  addSystemMessage(`Now entering ${ROOMS[roomIndex]}: ${state.name}`);
  sendLobbyStatus();
  renderCounts();

  const room = joinRoom(rtcConfig, `room-${ROOMS[roomIndex]}`, (error) => {
    addSystemMessage(`接続エラー: ${error?.message || "不明"}`);
  });
  const [sendChat, getChat] = room.makeAction("chat");
  state.room = room;
  state.sendChat = sendChat;

  getChat((data) => {
    if (!data?.id) return;
    appendMessage({ ...data, own: false });
  });
}

function leaveChatRoom() {
  if (state.room) state.room.leave();
  state.room = null;
  state.sendChat = null;
  state.selectedRoom = null;
}

function sendCurrentMessage() {
  if (!state.sendChat || state.selectedRoom === null) return;
  const text = draftInput.value.trim();
  const hasDrawing = !isCanvasBlank();
  if (!text && !hasDrawing) return;

  const message = {
    id: `${Date.now()}-${makeId()}`,
    name: state.name,
    color: state.color,
    text,
    image: hasDrawing ? canvas.toDataURL("image/png") : "",
    time: Date.now()
  };

  appendMessage({ ...message, own: true });
  state.sendChat(message).catch(() => addSystemMessage("送信できませんでした"));
  draftInput.value = "";
  clearCanvas();
}

function appendMessage(message) {
  const list = state.messages[state.selectedRoom];
  if (!list || list.some((item) => item.id === message.id)) return;
  list.push(message);
  while (list.length > 50) list.shift();
  renderMessages();
}

function addSystemMessage(text) {
  if (state.selectedRoom === null) return;
  appendMessage({
    id: `system-${Date.now()}-${Math.random()}`,
    system: true,
    text,
    time: Date.now()
  });
}

function renderMessages() {
  messages.textContent = "";
  if (state.selectedRoom === null) return;
  const fragment = document.createDocumentFragment();

  for (const message of state.messages[state.selectedRoom]) {
    if (message.system) {
      const item = document.createElement("div");
      item.className = "system-message";
      item.textContent = message.text;
      fragment.append(item);
      continue;
    }

    const item = document.createElement("article");
    item.className = "message";
    item.style.setProperty("--user-color", message.color || state.color);
    const head = document.createElement("header");
    head.className = "message-head";

    const name = document.createElement("span");
    name.className = "message-name";
    name.textContent = message.name || "user";

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(message.time);

    head.append(name, time);
    item.append(head);

    if (message.text) {
      const text = document.createElement("p");
      text.className = "message-text";
      text.textContent = message.text;
      item.append(text);
    }

    if (message.image) {
      const image = document.createElement("img");
      image.className = "message-image";
      image.alt = "手書きメッセージ";
      image.src = message.image;
      item.append(image);
    }

    fragment.append(item);
  }

  messages.append(fragment);
  messages.scrollTop = messages.scrollHeight;
}

function setupKeyboard() {
  const rows = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="],
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "←"],
    ["CAPS", "a", "s", "d", "f", "g", "h", "j", "k", "l", "ENTER"],
    ["SHIFT", "z", "x", "c", "v", "b", "n", "m", ",", ".", "/"],
    [":", "'", "SPACE", "[", "]"]
  ];

  const fragment = document.createDocumentFragment();
  rows.forEach((row) => {
    const rowElement = document.createElement("div");
    rowElement.className = "key-row";
    row.forEach((label) => {
      const key = document.createElement("button");
      key.type = "button";
      key.className = label.length > 1 ? "key key-wide" : "key";
      key.textContent = label;
      key.addEventListener("click", () => {
        if (label === "ENTER") sendCurrentMessage();
        else editText(label);
      });
      rowElement.append(key);
    });
    fragment.append(rowElement);
  });
  keyboard.append(fragment);
}

function editText(value) {
  const start = draftInput.selectionStart ?? draftInput.value.length;
  const end = draftInput.selectionEnd ?? draftInput.value.length;
  const current = draftInput.value;

  if (value === "←" || value === "backspace") {
    if (start !== end) {
      draftInput.value = current.slice(0, start) + current.slice(end);
      draftInput.setSelectionRange(start, start);
    } else if (start > 0) {
      draftInput.value = current.slice(0, start - 1) + current.slice(start);
      draftInput.setSelectionRange(start - 1, start - 1);
    }
    draftInput.focus();
    return;
  }

  const insert = value === "SPACE" ? " " : value === "CAPS" || value === "SHIFT" ? "" : value;
  if (!insert) {
    draftInput.focus();
    return;
  }

  const next = (current.slice(0, start) + insert + current.slice(end)).slice(0, draftInput.maxLength);
  const nextPosition = Math.min(start + insert.length, next.length);
  draftInput.value = next;
  draftInput.focus();
  draftInput.setSelectionRange(nextPosition, nextPosition);
}

function setTool(erasing) {
  state.erasing = erasing;
  penButton.classList.toggle("is-active", !erasing);
  eraseButton.classList.toggle("is-active", erasing);
}

function setupCanvas() {
  clearCanvas();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  canvas.addEventListener("pointerdown", (event) => {
    state.drawing = true;
    canvas.setPointerCapture(event.pointerId);
    const point = getPoint(event);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!state.drawing) return;
    const point = getPoint(event);
    ctx.globalCompositeOperation = state.erasing ? "destination-out" : "source-over";
    ctx.strokeStyle = "#111";
    ctx.lineWidth = state.erasing ? 24 : 5;
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  });

  canvas.addEventListener("pointerup", endDrawing);
  canvas.addEventListener("pointercancel", endDrawing);
}

function endDrawing(event) {
  state.drawing = false;
  if (event.pointerId) canvas.releasePointerCapture(event.pointerId);
}

function getPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height
  };
}

function clearCanvas() {
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function isCanvasBlank() {
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] < 250 || pixels[index + 1] < 250 || pixels[index + 2] < 250) return false;
  }
  return true;
}

function randomColor() {
  const colors = ["#99ff00", "#9ad9ff", "#ffadc4", "#ffd374"];
  return colors[Math.floor(Math.random() * colors.length)];
}

function applyAccentColor(color) {
  document.documentElement.style.setProperty("--accent", color);
  document.documentElement.style.setProperty("--accent-soft", mixWithWhite(color, 0.82));
}

function mixWithWhite(hex, amount) {
  const value = hex.replace("#", "");
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  const mix = (channel) => Math.round(channel * (1 - amount) + 255 * amount);
  return `rgb(${mix(red)}, ${mix(green)}, ${mix(blue)})`;
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function formatTime(value) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
