const PICTO_ASSET_BASE = window.PICTO_ASSET_BASE || "https://cdn.jsdelivr.net/gh/ayunami2000/ayunpictojava@0cd27bd3f433bb86c2f5f6d5febe114a238ef7cc/src/main/resources/www/";

function pictoAssetUrl(value) {
    if (typeof value !== "string") return value;
    if (!/^(images|sounds)\//.test(value)) return value;
    return new URL(value, PICTO_ASSET_BASE).href;
}

function rewritePictoResource(resource) {
    if (typeof resource === "string") return pictoAssetUrl(resource);
    if (Array.isArray(resource)) return resource.map(rewritePictoResource);
    if (resource && typeof resource === "object") {
        const copy = { ...resource };
        if (copy.url) copy.url = pictoAssetUrl(copy.url);
        if (copy.src) copy.src = rewritePictoResource(copy.src);
        return copy;
    }
    return resource;
}

function patchPictoAssetUrls() {
    if (window.Howl && !window.Howl.__pictoPatched) {
        const NativeHowl = window.Howl;
        window.Howl = function PictoHowl(options, ...rest) {
            return new NativeHowl(rewritePictoResource(options), ...rest);
        };
        window.Howl.prototype = NativeHowl.prototype;
        window.Howl.__pictoPatched = true;
    }

    const imageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    if (imageSrc && !HTMLImageElement.prototype.__pictoPatched) {
        Object.defineProperty(HTMLImageElement.prototype, "src", {
            get: imageSrc.get,
            set(value) {
                imageSrc.set.call(this, pictoAssetUrl(value));
            }
        });
        HTMLImageElement.prototype.__pictoPatched = true;
    }

    if (!window.PIXI) return;

    const patchStaticFrom = (target) => {
        if (!target?.from || target.from.__pictoPatched) return;
        const nativeFrom = target.from;
        target.from = function PictoFrom(resource, ...rest) {
            return nativeFrom.call(this, rewritePictoResource(resource), ...rest);
        };
        target.from.__pictoPatched = true;
    };

    patchStaticFrom(window.PIXI.Texture);
    patchStaticFrom(window.PIXI.BaseTexture);
    patchStaticFrom(window.PIXI.Sprite);

    const loaderProto = window.PIXI.Loader?.prototype;
    if (loaderProto?.add && !loaderProto.add.__pictoPatched) {
        const nativeAdd = loaderProto.add;
        loaderProto.add = function PictoLoaderAdd(...args) {
            if (typeof args[0] === "string" && typeof args[1] === "string") {
                args[1] = pictoAssetUrl(args[1]);
            } else {
                args[0] = rewritePictoResource(args[0]);
            }
            return nativeAdd.apply(this, args);
        };
        loaderProto.add.__pictoPatched = true;
    }
}

patchPictoAssetUrls();

class PictoP2PWebSocket {
    constructor() {
        this.readyState = 0;
        this.onopen = null;
        this.onmessage = null;
        this.onclose = null;
        this.onerror = null;
        this.player = null;
        this.userId = this.getUserId();
        this.roomId = null;
        this.peers = new Map();
        this.pending = [];
        this.transports = [];
        this.presenceInterval = null;
        this.syncStatusTimer = null;
        this.peerTtlMs = 12000;
        this.seenMessageIds = new Set();
        this.rooms = ["room_a", "room_b", "room_c", "room_d"];
        const pathRoot = location.pathname.split("/").filter(Boolean)[0] || "root";
        this.appId = (window.PICTO_APP_ID || `pictochat-pages-${location.host}-${pathRoot}`).replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
        window.__pictoP2P = this;
        window.__pictoP2PEvents = window.__pictoP2PEvents || [];
        this.log("app start", { appId: this.appId, userId: this.userId, url: location.href });
        this.setSyncStatus("CONNECTING P2P");
        this.init();
    }

    async init() {
        const strategies = [
            { name: "nostr", url: "https://esm.sh/trystero@0.21.8?bundle" },
            { name: "torrent", url: "https://esm.sh/trystero@0.21.8/torrent?bundle" }
        ];
        const results = await Promise.allSettled(strategies.map((strategy) => this.setupTransport(strategy)));
        this.transports = results
            .filter((result) => result.status === "fulfilled" && result.value)
            .map((result) => result.value);
        if (this.transports.length) {
            this.startPresenceLoop();
            this.readyState = 1;
            this.setSyncStatus("SYNCING ROOMS");
            this.log("connect ready", { transports: this.transports.map((transport) => transport.name) });
            this.onopen?.({ type: "open" });
            this.pending.splice(0).forEach((data) => this.send(data));
            return;
        }
        const error = new Error("No P2P signaling transport available.");
        this.log("error", { message: error.message, results: results.map((result) => result.reason?.message || result.status) });
        this.setSyncStatus("OFFLINE");
        this.readyState = 3;
        this.onerror?.(error);
        this.onclose?.({ type: "close" });
    }

    async setupTransport(strategy) {
        this.log("subscribe start", { channel: "lobby", strategy: strategy.name });
        const { joinRoom } = await import(strategy.url);
        const config = {
            appId: this.appId,
            password: this.appId,
            trackerRedundancy: 4,
            rtcConfig: {
                iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
            }
        };
        const lobby = joinRoom(config, "lobby");
        const [sendPresence, getPresence] = lobby.makeAction("presence");
        const [sendLobbyChat, getLobbyChat] = lobby.makeAction("roomChat");
        const transport = {
            name: strategy.name,
            joinRoom,
            config,
            lobby,
            room: null,
            sendPresence,
            sendLobbyChat,
            sendChat: null
        };
        lobby.onPeerJoin((peerId) => {
            this.log("join success", { channel: "lobby", strategy: transport.name, peerId });
            this.publishPresence(peerId, transport);
        });
        lobby.onPeerLeave((peerId) => this.handlePeerLeave(peerId, transport));
        getPresence((presence, peerId) => this.handlePresence(presence, peerId, transport));
        getLobbyChat((payload, peerId) => this.handleIncomingChat(payload, peerId, transport));
        this.log("subscribe success", { channel: "lobby", strategy: transport.name });
        return transport;
    }

    send(data) {
        if (this.readyState !== 1) {
            this.pending.push(data);
            return;
        }
        if (data === "pong" || data === "handshake") {
            this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
            return;
        }
        let packet;
        try {
            packet = JSON.parse(data);
        } catch {
            return;
        }
        switch (packet.type) {
            case "cl_verifyName":
                this.verifyName(packet.player || {});
                break;
            case "cl_joinRoom":
                this.enterRoom(packet.id);
                break;
            case "cl_sendMessage":
                this.sendMessage(packet.message);
                break;
            case "cl_leaveRoom":
                this.leaveCurrentRoom(true);
                break;
        }
    }

    close() {
        this.leaveCurrentRoom(false);
        if (this.presenceInterval) clearInterval(this.presenceInterval);
        for (const transport of this.transports) {
            try { transport.lobby?.leave(); } catch {}
        }
        this.readyState = 3;
        this.log("disconnect", { reason: "close" });
        this.onclose?.({ type: "close" });
    }

    verifyName(player) {
        const name = String(player.name || "user").replace(/[^\w\s]/gi, "").trim().slice(0, 10) || "user";
        const color = Number.isFinite(player.color) ? player.color : 0x99ff00;
        this.player = { name, color, userId: this.userId };
        this.log("username set", { userId: this.userId, username: name });
        this.emit({ type: "sv_nameVerified", player: this.player });
        this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
        this.publishPresence();
        this.syncBurst("SYNCING ROOMS");
    }

    enterRoom(roomId) {
        if (!this.rooms.includes(roomId)) return;
        if (this.roomId && this.roomId !== roomId) this.leaveCurrentRoom(false);
        this.roomId = roomId;
        this.log("joinRoom", { roomId, userId: this.userId, username: this.player?.name });
        this.setSyncStatus("CONNECTING ROOM");
        this.joinChatTransport(roomId);
        this.emit({ type: "sv_roomData", id: roomId });
        this.publishPresence();
        this.syncBurst("SYNCING ROOM");
        this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
    }

    joinChatTransport(roomId) {
        for (const transport of this.transports) {
            try { transport.room?.leave(); } catch {}
            const channel = `chat-${roomId}`;
            this.log("subscribe start", { channel, roomId, strategy: transport.name });
            transport.room = transport.joinRoom(transport.config, channel);
            const [sendChat, getChat] = transport.room.makeAction("chat");
            transport.sendChat = sendChat;
            transport.room.onPeerJoin((peerId) => {
                this.log("subscribe success", { channel, roomId, strategy: transport.name, peerId });
                this.publishPresence(peerId, transport);
            });
            transport.room.onPeerLeave((peerId) => this.log("disconnect", { channel, strategy: transport.name, peerId }));
            getChat((payload, peerId) => this.handleIncomingChat(payload, peerId, transport));
            this.log("subscribe success", { channel, roomId, strategy: transport.name });
        }
    }

    sendMessage(message) {
        if (!this.roomId || !message) return;
        message.player = this.player || message.player || { name: "user", color: 0x99ff00 };
        const payload = {
            id: this.createMessageId(),
            room: this.roomId,
            message,
            senderId: this.userId,
            hops: 0,
            at: Date.now()
        };
        this.rememberMessage(payload.id);
        this.log("message sent", { messageId: payload.id, roomId: payload.room });
        this.deliverChat(payload);
        [120, 450, 900].forEach((delay) => {
            setTimeout(() => {
                if (this.roomId === payload.room) this.deliverChat(payload);
            }, delay);
        });
    }

    deliverChat(payload) {
        const deliveries = [];
        for (const transport of this.transports) {
            if (transport.sendChat) deliveries.push(transport.sendChat(payload));
            if (transport.sendLobbyChat) deliveries.push(transport.sendLobbyChat(payload));
        }
        Promise.allSettled(deliveries).then((results) => {
            if (results.length && results.every((result) => result.status === "rejected")) {
                this.log("error", { message: "send failed", messageId: payload.id });
                this.setSyncStatus("RECONNECTING");
                this.emit(this.serverMessage("Send failed."));
            }
        });
    }

    leaveCurrentRoom(emitSelf) {
        const oldRoom = this.roomId;
        this.roomId = null;
        for (const transport of this.transports) {
            try { transport.room?.leave(); } catch {}
            transport.room = null;
            transport.sendChat = null;
        }
        this.log("leaveRoom", { roomId: oldRoom, userId: this.userId });
        this.publishPresence();
        if (emitSelf && oldRoom) this.emit({ type: "sv_leaveRoom" });
        this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
    }

    handlePresence(presence, peerId, transport) {
        if (!presence?.player) return;
        const key = this.peerKey(transport, peerId);
        const userId = presence.userId || presence.player.userId || key;
        const before = this.peers.get(key);
        const wasUserInRoom = presence.room ? this.hasUserInRoom(userId, presence.room, key) : false;
        this.peers.set(key, { ...presence, userId, strategy: transport?.name, seenAt: Date.now() });
        this.log("presence received", { users: this.currentUsers(), from: userId, roomId: presence.room, strategy: transport?.name });
        if (before?.room === presence.room) {
            this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
            return;
        }
        if (before?.room && before.room === this.roomId && !this.hasUserInRoom(userId, before.room, key)) {
            this.emit({ type: "sv_playerLeft", player: before.player, id: before.room });
        }
        if (presence.room && presence.room === this.roomId && !wasUserInRoom) {
            this.emit({ type: "sv_playerJoined", player: presence.player, id: presence.room });
        }
        this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
        this.markSynced();
        this.publishPresence(peerId, transport);
    }

    handlePeerLeave(peerId, transport) {
        const key = this.peerKey(transport, peerId);
        const peer = this.peers.get(key);
        this.peers.delete(key);
        this.log("disconnect", { peerId, strategy: transport?.name, userId: peer?.userId });
        if (peer?.room && peer.room === this.roomId && !this.hasUserInRoom(peer.userId, peer.room)) {
            this.emit({ type: "sv_playerLeft", player: peer.player, id: peer.room });
        }
        this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
    }

    handleIncomingChat(payload, peerId, transport) {
        const message = payload?.message || payload;
        const room = payload?.room || this.roomId;
        const id = payload?.id || payload?.messageId || null;
        if (!message || room !== this.roomId) return;
        if (id && this.seenMessageIds.has(id)) {
            this.log("message duplicate skip", { messageId: id, from: payload?.senderId, strategy: transport?.name });
            return;
        }
        if (id) this.rememberMessage(id);
        this.log("message received", { messageId: id, from: payload?.senderId || peerId, roomId: room, strategy: transport?.name });
        this.relayChat(payload);
        this.emit({ type: "sv_receivedMessage", message });
        this.markSynced();
    }

    relayChat(payload) {
        const hops = Number(payload?.hops || 0);
        if (!payload?.id || hops >= 2) return;
        const relayed = { ...payload, hops: hops + 1, relayedAt: Date.now() };
        for (const transport of this.transports) {
            transport.sendChat?.(relayed).catch(() => {});
            transport.sendLobbyChat?.(relayed).catch(() => {});
        }
    }

    createMessageId() {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
        return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    rememberMessage(id) {
        this.seenMessageIds.add(id);
        if (this.seenMessageIds.size <= 300) return;
        const first = this.seenMessageIds.values().next().value;
        this.seenMessageIds.delete(first);
    }

    publishPresence(peerId, onlyTransport) {
        if (!this.player) return;
        const payload = { userId: this.userId, player: this.player, room: this.roomId, at: Date.now() };
        const targets = onlyTransport ? [onlyTransport] : this.transports;
        for (const transport of targets) {
            if (!transport?.sendPresence) continue;
            transport.sendPresence(payload, peerId).then(() => {
                this.log("presence sent", { userId: this.userId, roomId: this.roomId, strategy: transport.name, peerId });
            }).catch((error) => {
                this.log("error", { message: "presence send failed", strategy: transport.name, error: error?.message });
            });
        }
    }

    syncBurst(status) {
        this.setSyncStatus(status);
        [0, 100, 300, 700, 1200].forEach((delay) => {
            setTimeout(() => {
                this.prunePeers();
                this.publishPresence();
                this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
                if (delay >= 700) this.updateReadyStatus();
            }, delay);
        });
    }

    startPresenceLoop() {
        if (this.presenceInterval) clearInterval(this.presenceInterval);
        this.presenceInterval = setInterval(() => {
            this.prunePeers();
            this.publishPresence();
            this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
            this.updateReadyStatus();
        }, 1000);
        window.addEventListener("focus", () => this.syncBurst("SYNCING ROOMS"));
        window.addEventListener("pagehide", () => this.shutdownTransport());
        window.addEventListener("beforeunload", () => this.shutdownTransport());
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) this.syncBurst("SYNCING ROOMS");
        });
    }

    prunePeers() {
        const now = Date.now();
        let changed = false;
        for (const [peerId, peer] of this.peers.entries()) {
            if (peer.seenAt && now - peer.seenAt > this.peerTtlMs) {
                this.peers.delete(peerId);
                changed = true;
            }
        }
        if (changed) this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
    }

    shutdownTransport() {
        const oldRoom = this.roomId;
        this.roomId = null;
        if (oldRoom) this.publishPresence();
        for (const transport of this.transports) {
            try { transport.room?.leave(); } catch {}
            try { transport.lobby?.leave(); } catch {}
        }
        this.log("disconnect", { reason: "pagehide", roomId: oldRoom });
    }

    countRooms() {
        const counts = this.rooms.map(() => 0);
        const usersByRoom = new Map(this.rooms.map((room) => [room, new Set()]));
        if (this.roomId) usersByRoom.get(this.roomId)?.add(this.userId);
        for (const peer of this.peers.values()) {
            if (usersByRoom.has(peer.room)) usersByRoom.get(peer.room).add(peer.userId || peer.player?.userId || peer.player?.name);
        }
        this.rooms.forEach((room, index) => counts[index] = usersByRoom.get(room).size);
        return counts;
    }

    serverMessage(text) {
        return {
            type: "sv_receivedMessage",
            message: {
                drawing: [{ x: 0, y: 0, type: 3 }],
                textboxes: [{ x: 113, y: 211, text }],
                lines: 1,
                player: { name: "[SERVER]", color: 0xc89c00 }
            }
        };
    }

    setSyncStatus(text) {
        let node = document.getElementById("picto_sync_status");
        if (!node) {
            node = document.createElement("div");
            node.id = "picto_sync_status";
            node.style.cssText = [
                "position:absolute",
                "left:8px",
                "bottom:8px",
                "z-index:1000001",
                "background:#000",
                "border:1px solid #9cff00",
                "color:#9cff00",
                "font-family:nds,monospace",
                "font-size:10px",
                "line-height:14px",
                "padding:2px 5px",
                "pointer-events:none",
                "image-rendering:pixelated"
            ].join(";");
            document.getElementById("root")?.appendChild(node);
        }
        node.textContent = text;
        node.style.display = "block";
        if (this.syncStatusTimer) clearTimeout(this.syncStatusTimer);
    }

    markSynced(text = "P2P READY") {
        const node = document.getElementById("picto_sync_status");
        if (!node) return;
        node.textContent = text;
        if (this.syncStatusTimer) clearTimeout(this.syncStatusTimer);
        this.syncStatusTimer = setTimeout(() => {
            node.style.display = "none";
        }, 1200);
    }

    updateReadyStatus() {
        if (!this.roomId) {
            this.markSynced();
            return;
        }
        if (this.countRooms()[this.rooms.indexOf(this.roomId)] > 1) {
            this.markSynced();
        } else {
            this.setSyncStatus("WAITING PEERS");
        }
    }

    getUserId() {
        try {
            let userId = sessionStorage.getItem("picto_user_id");
            if (!userId) {
                userId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
                sessionStorage.setItem("picto_user_id", userId);
            }
            return userId;
        } catch {
            return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        }
    }

    peerKey(transport, peerId) {
        return `${transport?.name || "unknown"}:${peerId}`;
    }

    hasUserInRoom(userId, roomId, exceptKey) {
        for (const [key, peer] of this.peers.entries()) {
            if (key !== exceptKey && peer.userId === userId && peer.room === roomId) return true;
        }
        return false;
    }

    currentUsers() {
        const users = new Map();
        if (this.player) users.set(this.userId, { userId: this.userId, name: this.player.name, room: this.roomId });
        for (const peer of this.peers.values()) {
            users.set(peer.userId || peer.player?.name, { userId: peer.userId, name: peer.player?.name, room: peer.room });
        }
        return Array.from(users.values());
    }

    log(event, details = {}) {
        console.log(`[PictoChat] ${event}`, details);
    }

    emit(packet) {
        window.__pictoP2PEvents?.push(packet);
        if (window.__pictoP2PEvents?.length > 200) window.__pictoP2PEvents.shift();
        setTimeout(() => {
            this.onmessage?.({ data: JSON.stringify(packet) });
        }, 0);
    }
}

window.PictoP2PWebSocket = PictoP2PWebSocket;

function installPictoInputFocusPatch() {
    let keyboardButton = null;

    const focusInput = () => {
        const input = document.getElementById("topy");
        if (!input || !window.__pictoP2P?.roomId) return;
        const canvas = document.querySelector("#root canvas");
        if (canvas) {
            input.style.display = "block";
            input.style.left = "0px";
            input.style.top = "0px";
            input.style.width = `${canvas.width}px`;
            input.style.height = `${Math.floor(canvas.height / 2)}px`;
            input.style.pointerEvents = "none";
        }
        try {
            input.focus({ preventScroll: true });
        } catch {
            input.focus();
        }
    };

    const ensureKeyboardButton = () => {
        if (keyboardButton) return keyboardButton;
        keyboardButton = document.createElement("button");
        keyboardButton.id = "picto_keyboard_button";
        keyboardButton.type = "button";
        keyboardButton.textContent = "KEY";
        keyboardButton.setAttribute("aria-label", "Keyboard input");
        keyboardButton.style.cssText = [
            "position:absolute",
            "right:44px",
            "bottom:8px",
            "z-index:1000002",
            "display:none",
            "width:34px",
            "height:22px",
            "padding:0",
            "border:1px solid #777",
            "border-radius:0",
            "background:#f7f7f7",
            "box-shadow:inset -2px -2px #bdbdbd,inset 2px 2px #fff",
            "color:#333",
            "font-family:nds,monospace",
            "font-size:10px",
            "line-height:20px",
            "text-align:center"
        ].join(";");
        keyboardButton.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        keyboardButton.addEventListener("click", (event) => {
            event.preventDefault();
            focusInput();
        });
        document.getElementById("root")?.appendChild(keyboardButton);
        return keyboardButton;
    };

    const updateKeyboardButton = () => {
        const button = ensureKeyboardButton();
        const mobileLike = matchMedia("(pointer: coarse)").matches || innerWidth <= 600;
        const desktopLike = !mobileLike;
        if (window.__pictoP2P?.roomId && mobileLike) {
            button.style.display = "block";
        } else {
            button.style.display = "none";
        }
        if (window.__pictoP2P?.roomId && desktopLike && document.activeElement !== document.getElementById("topy")) {
            focusInput();
        }
    };

    window.addEventListener("resize", updateKeyboardButton);
    document.addEventListener("visibilitychange", updateKeyboardButton);
    setInterval(updateKeyboardButton, 500);
    updateKeyboardButton();
}

installPictoInputFocusPatch();

const PictoNativeWebSocket = window.WebSocket;
function PictoWebSocketShim(url, protocols) {
    try {
        const target = new URL(url, location.href);
        if (target.host === location.host) return new PictoP2PWebSocket();
    } catch {}
    return new PictoNativeWebSocket(url, protocols);
}
PictoWebSocketShim.CONNECTING = PictoNativeWebSocket.CONNECTING ?? 0;
PictoWebSocketShim.OPEN = PictoNativeWebSocket.OPEN ?? 1;
PictoWebSocketShim.CLOSING = PictoNativeWebSocket.CLOSING ?? 2;
PictoWebSocketShim.CLOSED = PictoNativeWebSocket.CLOSED ?? 3;
PictoWebSocketShim.prototype = PictoNativeWebSocket.prototype;
window.WebSocket = PictoWebSocketShim;
