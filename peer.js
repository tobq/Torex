"use strict";

const net = require('net');
const bencode = require("bencode");
const BitField = require("bitfield")

class Peer {
    constructor(peer, torrent, getInfo = false) {
        if (!torrent) throw new Error("A Peer must be initialised with a Torrent");
        this._torrent = torrent;
        this.IP = peer.slice(0, 4).join(".");
        this.port = peer.readUInt16BE(4)
        this.connection = new net.Socket();
        this.connection.setTimeout(1000);
        this.bitField = new BitField(0, { grow: Infinity });
        this.choked = true;
        this.buffer = Buffer.allocUnsafe(0);
        this.handshake = Buffer.allocUnsafe(68);
        this.handshake[0] = 19;
        this.handshake.fill("BitTorrent protocol", 1, 20, "ascii");
        this.handshake.writeUIntBE(1048576, 20, 8, true);
        this.handshake.fill(this._torrent.infoHashHex, 28, 48, "hex");
        this.handshake.fill(this._torrent._client.ID, 48, 68, "ascii");
        //console.log('TCP - Connecting to:', this.IP + ":" + this.port);
        this.connection.on('error', this.destroy.bind(this));
        this.connection.on('data', this._dataCB.bind(this));
        this.connection.on('close', this.destroy.bind(this));
        this.getInfo = getInfo;
        this.connection.connect(this.port, this.IP, this._connectCB.bind(this));
    }
}
Peer.prototype._connectCB = function () {
    //console.log('TCP - Connected:', this.IP + ":" + this.port);
    this.connection.write(this.handshake);
};
Peer.prototype.destroy = function () {
    if (this._running) return this._toDestroy = true;
    if (this._destroyed) return;
    this._destroyed = true;
    this._torrent._peerDestroyCB(this.IP);
    this.connection.destroy();
    clearInterval(this.keepAlive);
    //console.log("TCP - Closed:", this.IP, ">>",Object.keys(this._torrent.peers).length,"left");
    this.choked = this._torrent = this.buffer = this.metadata = null;
}
Peer.prototype.send = function (code, data) {
    if (code === undefined) return this.connection.write(Buffer.from([0, 0, 0, 0]));
    if (data === undefined) return this.connection.write(Buffer.from([0, 0, 0, 1, code]));
    if (data instanceof Buffer) {
        let buf = Buffer.allocUnsafe(5 + data.length);
        buf.writeUInt32BE(1 + data.length, 0);
        buf[4] = code;
        data.copy(buf, 5);
        return this.connection.write(buf);
    }
    throw new Error("Data should be a Buffer: " + data.constructor.name);
}
Peer.prototype.sendExt = function (code, data) {
    data = bencode.encode(data);
    let req = Buffer.allocUnsafe(data.length + 1);
    req[0] = code;
    data.copy(req, 1);
    this.send(20, req);
}
Peer.prototype._dataCB = function (data) {
    if (this.shaken) {
        this.buffer = Buffer.concat([this.buffer, data]);
        if (this._running) return;
        this._running = true;
        let length;
        while (this.buffer.length > 3 && (length = this.buffer.readUInt32BE(0)) <= this.buffer.length) {
            let code = length ? this.buffer[4] : -1,
                data = this.buffer.slice(5, 4 + length);
            this.buffer = this.buffer.slice(4 + length);
            //console.log("TCP - Received:", this.IP + ":" + this.port, "::", code);
            //console.log("------------------------", code);
            if (code === 0) this.choked = true;
            else if (code === 1) this.choked = false;
            else if (code === 4) this.bitField.set(data.length || data.readUInt32BE());
            else if (code === 5) this.bitField = new BitField(data, { grow: Infinity });
            else if (code === 7) {
                let piece = data.readUInt32BE(0),
                    offset = data.readUInt32BE(4),
                    block = data.slice(8);

                let cancel = Buffer.allocUnsafe(12);
                data.copy(cancel, 0, 0, 8);
                cancel.writeInt32BE(block.length, 8);
                for (let IP in this._torrent.peers) this._torrent.peers[IP].send(8, cancel);

                for (var IP in this._torrent._pipes) {
                    let pipe = this._torrent._pipes[IP];
                    if (piece === pipe.Piece && offset === pipe.Offset && !pipe.received) {
                        if (pipe.close) {
                            pipe.res.end();
                            this._torrent._pipes[IP] = null;
                            delete this._torrent._pipes[IP];
                            return delete this.res;
                        }
                        pipe.received = true;
                        //process.stdout.write(" *");
                        //console.log(this.IP, "GAVE:", piece, offset, block.length);
                        pipe.res.write(block);
                        block.length + pipe.start > pipe.end ?
                            pipe.res.end() : this._torrent._stream(IP, pipe.start + block.length);
                    }
                }
            }
            else if (code === 20) {
                code = data[0];
                //console.log("Extended - Received:", this.IP + ":" + this.port, "::", code);
                let extended;
                try { extended = bencode.decode(data.slice(1)); }
                catch (e) { return };
                if (code === 0) { // Handshake
                    this.sendExt(0, {
                        m: this._extensions,
                        v: Buffer.from("H31l0o")
                    });
                    if (this.getInfo && extended.m.ut_metadata && extended.metadata_size > 0) {
                        this.metadata = Buffer.allocUnsafe(extended.metadata_size);
                        this.remaining = Math.ceil(extended.metadata_size / 2 ** 14);
                        for (let i = this.remaining; i--;)
                            this.sendExt(extended.m.ut_metadata, {
                                msg_type: 0,
                                piece: i
                            });
                    }
                }
                else if (code === this._extensions.ut_metadata) {
                    if (extended.msg_type === 0) return this.sendExt({ msg_type: 2, piece: extended.piece });
                    if (extended.msg_type === 1) {
                        data.slice(data.toString("ascii").indexOf("ee") + 2).copy(this.metadata, extended.piece * 16384);
                        if (!--this.remaining) this._torrent._peerInfoCB(this.metadata, this.IP);
                    }
                }
                else if (code === 2) {
                    //console.log(extended);
                }
            }
        }
        this._running = false;
        if (this._toDestroy) return this.destroy();
    }
    else if (19 === data[0]) {
        this.buffer = Buffer.concat([this.buffer, data.slice(68)]);
        this.ID = data.slice(48, 68).toString("hex");
        this.keepAlive = setInterval(this.send.bind(this), 60000);
        this.shaken = true;
        this.send(2);
    }
    else {
        console.log("MANUAL CLOSE -");
        return this.destroy();
    }
};
Peer.prototype._extensions = {
    ut_metadata: 1,

}

module.exports = Peer;
