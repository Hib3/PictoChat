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
        this.roomId = null;
        this.peers = new Map();
        this.pending = [];
        this.room = null;
        this.sendPresence = null;
        this.sendLobbyChat = null;
        this.sendChat = null;
        this.presenceInterval = null;
        this.syncStatusTimer = null;
        this.peerTtlMs = 12000;
        this.seenMessageIds = new Set();
        this.rooms = ["room_a", "room_b", "room_c", "room_d"];
        this.appId = `pictochat-pages-${location.host}${location.pathname}`.replace(/[^a-z0-9_-]/gi, "-");
        window.__pictoP2P = this;
        window.__pictoP2PEvents = window.__pictoP2PEvents || [];
        this.setSyncStatus("CONNECTING P2P");
        this.init();
    }

    async init() {
        try {
            const { joinRoom } = await import("https://esm.sh/trystero@0.21.8/torrent?bundle");
            this.joinRoom = joinRoom;
            this.config = {
                appId: this.appId,
                password: this.appId,
                trackerRedundancy: 4,
                rtcConfig: {
                    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
                }
            };
            this.lobby = joinRoom(this.config, "lobby");
            const [sendPresence, getPresence] = this.lobby.makeAction("presence");
            const [sendLobbyChat, getLobbyChat] = this.lobby.makeAction("roomChat");
            this.sendPresence = sendPresence;
            this.sendLobbyChat = sendLobbyChat;
            this.lobby.onPeerJoin((peerId) => this.publishPresence(peerId));
            this.lobby.onPeerLeave((peerId) => this.handlePeerLeave(peerId));
            getPresence((presence, peerId) => this.handlePresence(presence, peerId));
            getLobbyChat((payload) => this.handleIncomingChat(payload));
            this.startPresenceLoop();
            this.readyState = 1;
            this.setSyncStatus("SYNCING ROOMS");
            this.onopen?.({ type: "open" });
            this.pending.splice(0).forEach((data) => this.send(data));
        } catch (error) {
            this.readyState = 3;
            this.onerror?.(error);
            this.onclose?.({ type: "close" });
        }
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
        this.readyState = 3;
        this.onclose?.({ type: "close" });
    }

    verifyName(player) {
        const name = String(player.name || "user").replace(/[^\w\s]/gi, "").trim().slice(0, 10) || "user";
        const color = Number.isFinite(player.color) ? player.color : 0x99ff00;
        this.player = { name, color };
        this.emit({ type: "sv_nameVerified", player: this.player });
        this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
        this.publishPresence();
        this.syncBurst("SYNCING ROOMS");
    }

    enterRoom(roomId) {
        if (!this.rooms.includes(roomId)) return;
        if (this.roomId && this.roomId !== roomId) this.leaveCurrentRoom(false);
        this.roomId = roomId;
        this.joinChatTransport(roomId);
        this.emit({ type: "sv_roomData", id: roomId });
        this.publishPresence();
        this.syncBurst("SYNCING ROOM");
        this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
    }

    joinChatTransport(roomId) {
        if (this.room) this.room.leave();
        this.room = this.joinRoom(this.config, `chat-${roomId}`);
        const [sendChat, getChat] = this.room.makeAction("chat");
        this.sendChat = sendChat;
        getChat((payload) => this.handleIncomingChat(payload));
    }

    sendMessage(message) {
        if (!this.roomId || !message) return;
        message.player = this.player || message.player || { name: "user", color: 0x99ff00 };
        const payload = {
            id: this.createMessageId(),
            room: this.roomId,
            message,
            at: Date.now()
        };
        this.rememberMessage(payload.id);
        const deliveries = [];
        if (this.sendChat) deliveries.push(this.sendChat(payload));
        if (this.sendLobbyChat) deliveries.push(this.sendLobbyChat(payload));
        Promise.allSettled(deliveries).then((results) => {
            if (results.length && results.every((result) => result.status === "rejected")) {
                this.emit(this.serverMessage("Send failed."));
            }
        });
    }

    leaveCurrentRoom(emitSelf) {
        const oldRoom = this.roomId;
        this.roomId = null;
        if (this.room) this.room.leave();
        this.room = null;
        this.sendChat = null;
        this.publishPresence();
        if (emitSelf && oldRoom) this.emit({ type: "sv_leaveRoom" });
        this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
    }

    handlePresence(presence, peerId) {
        if (!presence?.player) return;
        const before = this.peers.get(peerId);
        this.peers.set(peerId, { ...presence, seenAt: Date.now() });
        if (before?.room === presence.room) {
            this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
            return;
        }
        if (before?.room && before.room === this.roomId) {
            this.emit({ type: "sv_playerLeft", player: before.player, id: before.room });
        }
        if (presence.room && presence.room === this.roomId) {
            this.emit({ type: "sv_playerJoined", player: presence.player, id: presence.room });
        }
        this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
        this.markSynced();
        this.publishPresence(peerId);
    }

    handlePeerLeave(peerId) {
        const peer = this.peers.get(peerId);
        this.peers.delete(peerId);
        if (peer?.room && peer.room === this.roomId) {
            this.emit({ type: "sv_playerLeft", player: peer.player, id: peer.room });
        }
        this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
    }

    handleIncomingChat(payload) {
        const message = payload?.message || payload;
        const room = payload?.room || this.roomId;
        const id = payload?.id || payload?.messageId || null;
        if (!message || room !== this.roomId) return;
        if (id && this.seenMessageIds.has(id)) return;
        if (id) this.rememberMessage(id);
        this.emit({ type: "sv_receivedMessage", message });
        this.markSynced();
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

    publishPresence(peerId) {
        if (!this.sendPresence || !this.player) return;
        this.sendPresence({ player: this.player, room: this.roomId, at: Date.now() }, peerId).catch(() => {});
    }

    syncBurst(status) {
        this.setSyncStatus(status);
        [0, 250, 750, 1500, 3000].forEach((delay) => {
            setTimeout(() => {
                this.prunePeers();
                this.publishPresence();
                this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
                if (delay >= 1500) this.markSynced();
            }, delay);
        });
    }

    startPresenceLoop() {
        if (this.presenceInterval) clearInterval(this.presenceInterval);
        this.presenceInterval = setInterval(() => {
            this.prunePeers();
            this.publishPresence();
            this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
        }, 2000);
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
        try { this.room?.leave(); } catch {}
        try { this.lobby?.leave(); } catch {}
    }

    countRooms() {
        const counts = this.rooms.map((room) => (this.roomId === room ? 1 : 0));
        for (const peer of this.peers.values()) {
            const index = this.rooms.indexOf(peer.room);
            if (index >= 0) counts[index] += 1;
        }
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

    markSynced() {
        const node = document.getElementById("picto_sync_status");
        if (!node) return;
        node.textContent = "P2P READY";
        if (this.syncStatusTimer) clearTimeout(this.syncStatusTimer);
        this.syncStatusTimer = setTimeout(() => {
            node.style.display = "none";
        }, 1200);
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
        }
        try {
            input.focus({ preventScroll: true });
        } catch {
            input.focus();
        }
    };
    document.addEventListener("pointerdown", (event) => {
        if (event.target?.id === "name_box" || event.target?.id === "join_button") return;
        const canvas = document.querySelector("#root canvas");
        if (event.target === canvas) {
            const rect = canvas.getBoundingClientRect();
            const y = (event.clientY - rect.top) * 384 / rect.height;
            if (y >= 296) return;
        }
        setTimeout(focusInput, 0);
    }, true);
    window.addEventListener("resize", focusInput);
    setInterval(focusInput, 2000);
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
