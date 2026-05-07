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
        this.sendChat = null;
        this.rooms = ["room_a", "room_b", "room_c", "room_d"];
        this.appId = `pictochat-pages-${location.host}${location.pathname}`.replace(/[^a-z0-9_-]/gi, "-");
        this.init();
    }

    async init() {
        try {
            const { joinRoom } = await import("https://esm.sh/trystero@0.21.8/torrent?bundle");
            this.joinRoom = joinRoom;
            this.config = {
                appId: this.appId,
                password: this.appId,
                rtcConfig: {
                    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
                }
            };
            this.lobby = joinRoom(this.config, "lobby");
            const [sendPresence, getPresence] = this.lobby.makeAction("presence");
            this.sendPresence = sendPresence;
            this.lobby.onPeerJoin((peerId) => this.publishPresence(peerId));
            this.lobby.onPeerLeave((peerId) => this.handlePeerLeave(peerId));
            getPresence((presence, peerId) => this.handlePresence(presence, peerId));
            this.readyState = 1;
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
    }

    enterRoom(roomId) {
        if (!this.rooms.includes(roomId)) return;
        if (this.roomId && this.roomId !== roomId) this.leaveCurrentRoom(false);
        this.roomId = roomId;
        this.joinChatTransport(roomId);
        this.emit({ type: "sv_roomData", id: roomId });
        this.publishPresence();
        this.emit({ type: "sv_roomIds", count: this.countRooms(), ids: this.rooms });
    }

    joinChatTransport(roomId) {
        if (this.room) this.room.leave();
        this.room = this.joinRoom(this.config, `chat-${roomId}`);
        const [sendChat, getChat] = this.room.makeAction("chat");
        this.sendChat = sendChat;
        getChat((payload) => {
            if (!payload?.message) return;
            this.emit({ type: "sv_receivedMessage", message: payload.message });
        });
    }

    sendMessage(message) {
        if (!this.roomId || !this.sendChat || !message) return;
        message.player = this.player || message.player || { name: "user", color: 0x99ff00 };
        this.sendChat({ message }).catch(() => {
            this.emit(this.serverMessage("Send failed."));
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
        this.peers.set(peerId, presence);
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

    publishPresence(peerId) {
        if (!this.sendPresence || !this.player) return;
        this.sendPresence({ player: this.player, room: this.roomId }, peerId).catch(() => {});
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

    emit(packet) {
        setTimeout(() => {
            this.onmessage?.({ data: JSON.stringify(packet) });
        }, 0);
    }
}

window.PictoP2PWebSocket = PictoP2PWebSocket;

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
