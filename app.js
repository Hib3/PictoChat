import { joinRoom } from "https://esm.sh/trystero@0.21.8/torrent?bundle";

const CHANNELS = ["Room A", "Room B", "Room C", "Room D"];
const CHANNEL_KEYS = ["A", "B", "C", "D"];
const APP_ID = `inner-picto-pwa-${location.host}${location.pathname}`.replace(/[^a-z0-9_-]/gi, "-");
const rtcConfig = {
  appId: APP_ID,
  password: APP_ID,
  rtcConfig: {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  }
};

const state = {
  name: "",
  color: randomColor(),
  channel: 0,
  room: null,
  sendChat: null,
  sendPresence: null,
  peers: new Map(),
  messages: [[], [], [], []],
  drawing: false,
  erasing: false
};

const $ = (selector) => document.querySelector(selector);
const loginView = $("#loginView");
const chatView = $("#chatView");
const loginForm = $("#loginForm");
const nameInput = $("#nameInput");
const roomStatus = $("#roomStatus");
const roomTitle = $("#roomTitle");
const messages = $("#messages");
const tabs = [...document.querySelectorAll(".channel-tab")];
const canvas = $("#drawCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const textInput = $("#textInput");
const sendButton = $("#sendButton");
const penButton = $("#penButton");
const eraseButton = $("#eraseButton");
const clearButton = $("#clearButton");
const selfName = $("#selfName");
const keyboard = $("#keyboard");
const backspaceButton = $("#backspaceButton");

setupCanvas();
setupKeyboard();
registerServiceWorker();

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim().slice(0, 16);
  if (!name) return;
  state.name = name;
  selfName.textContent = name;
  loginView.classList.add("is-hidden");
  chatView.classList.remove("is-hidden");
  joinChannel(0);
});

tabs.forEach((tab) => {
  tab.addEventListener("click", () => joinChannel(Number(tab.dataset.channel)));
});

$("#leaveButton").addEventListener("click", () => {
  leaveRoom();
  state.messages = [[], [], [], []];
  state.peers.clear();
  chatView.classList.add("is-hidden");
  loginView.classList.remove("is-hidden");
  roomStatus.textContent = "未接続";
  renderMessages();
});

penButton.addEventListener("click", () => setTool(false));
eraseButton.addEventListener("click", () => setTool(true));
clearButton.addEventListener("click", clearCanvas);
sendButton.addEventListener("click", sendCurrentMessage);
backspaceButton.addEventListener("click", () => editText("backspace"));
textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendCurrentMessage();
});

function joinChannel(channel) {
  if (state.channel === channel && state.room) return;
  leaveRoom();
  state.channel = channel;
  roomTitle.textContent = CHANNELS[channel];
  tabs.forEach((tab, index) => tab.classList.toggle("is-active", index === channel));
  renderMessages();
  addSystemMessage(`Now entering ${CHANNEL_KEYS[channel]}: ${state.name}`);

  const roomId = `room-${channel + 1}`;
  const room = joinRoom(rtcConfig, roomId, (error) => {
    addSystemMessage(`接続エラー: ${error?.message || "不明"}`);
  });
  const [sendChat, getChat] = room.makeAction("chat");
  const [sendPresence, getPresence] = room.makeAction("presence");

  state.room = room;
  state.sendChat = sendChat;
  state.sendPresence = sendPresence;
  state.peers.clear();
  updateStatus();

  room.onPeerJoin((peerId) => {
    sendPresence(profile(), peerId);
    updateStatus();
  });

  room.onPeerLeave((peerId) => {
    const peer = state.peers.get(peerId);
    state.peers.delete(peerId);
    if (peer?.name) addSystemMessage(`${peer.name} が退室しました`);
    updateStatus();
  });

  getPresence((data, peerId) => {
    if (!data?.name) return;
    const known = state.peers.has(peerId);
    state.peers.set(peerId, data);
    if (!known) addSystemMessage(`${data.name} が入室しました`);
    if (!known) sendPresence(profile(), peerId);
    updateStatus();
  });

  getChat((data, peerId) => {
    if (!data?.id) return;
    appendMessage({
      id: data.id,
      name: data.name || state.peers.get(peerId)?.name || "unknown",
      color: data.color || state.peers.get(peerId)?.color || "#3b7dde",
      text: data.text || "",
      image: data.image || "",
      time: data.time || Date.now(),
      own: false
    });
  });
}

function leaveRoom() {
  if (state.room) state.room.leave();
  state.room = null;
  state.sendChat = null;
  state.sendPresence = null;
}

function sendCurrentMessage() {
  if (!state.sendChat) return;
  const text = textInput.value.trim();
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
  textInput.value = "";
  clearCanvas();
}

function appendMessage(message) {
  const list = state.messages[state.channel];
  if (list.some((item) => item.id === message.id)) return;
  list.push(message);
  while (list.length > 60) list.shift();
  renderMessages();
}

function addSystemMessage(text) {
  appendMessage({
    id: `system-${Date.now()}-${Math.random()}`,
    system: true,
    text,
    time: Date.now()
  });
}

function renderMessages() {
  messages.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const message of state.messages[state.channel]) {
    if (message.system) {
      const item = document.createElement("div");
      item.className = "system-message";
      item.textContent = message.text;
      fragment.append(item);
      continue;
    }

    const item = document.createElement("article");
    item.className = "message";
    item.style.setProperty("--message-color", message.color);
    const head = document.createElement("header");
    head.className = "message-head";

    const name = document.createElement("span");
    name.className = "message-name";
    name.textContent = message.own ? `${message.name}（自分）` : message.name;

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

function profile() {
  return { name: state.name, color: state.color };
}

function updateStatus() {
  const count = state.peers.size + (state.room ? 1 : 0);
  roomStatus.textContent = `${CHANNEL_KEYS[state.channel]}: ${state.name} / ${count} user${count === 1 ? "" : "s"}`;
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
      key.addEventListener("click", () => editText(label));
      rowElement.append(key);
    });
    fragment.append(rowElement);
  });
  keyboard.append(fragment);
}

function editText(value) {
  const start = textInput.selectionStart ?? textInput.value.length;
  const end = textInput.selectionEnd ?? textInput.value.length;
  const current = textInput.value;

  if (value === "ENTER") {
    sendCurrentMessage();
    return;
  }

  if (value === "←" || value === "backspace") {
    if (start !== end) {
      textInput.value = current.slice(0, start) + current.slice(end);
      textInput.setSelectionRange(start, start);
    } else if (start > 0) {
      textInput.value = current.slice(0, start - 1) + current.slice(start);
      textInput.setSelectionRange(start - 1, start - 1);
    }
    textInput.focus();
    return;
  }

  const insert = value === "SPACE" ? " " : value === "CAPS" || value === "SHIFT" ? "" : value;
  if (!insert) {
    textInput.focus();
    return;
  }

  const next = (current.slice(0, start) + insert + current.slice(end)).slice(0, textInput.maxLength);
  const nextPosition = Math.min(start + insert.length, next.length);
  textInput.value = next;
  textInput.focus();
  textInput.setSelectionRange(nextPosition, nextPosition);
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
    ctx.lineWidth = state.erasing ? 28 : 5;
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
  const colors = ["#2a78d2", "#d24b8c", "#d48420", "#189e55", "#8a55cc", "#c83838"];
  return colors[Math.floor(Math.random() * colors.length)];
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
