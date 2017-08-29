"use strict";

const Peer = require('./peer');
const bencode = require("bencode");
const crypto = require("crypto");
const FILETYPES = [".3gp", ".mov", ".mp4", ".m4v", ".m4a", ".mp3", ".mkv", ".ogv", ".ogm", ".ogg", ".oga", ".webm", ".wav"];


class Torrent extends require("events").EventEmitter {
    constructor(h, client, opts) {
        if (!h) throw new Error("Provide an info hash");
        if (h.length !== 40) throw new Error("Invalid info hash");
        if (client === undefined || client === null) throw new Error("A Torrent must be initialised with a Client");
        super();
        this._client = client;
        if (!opts) opts = {};
        this.infoHashHex = h;
        this.infoHash = Buffer.from(h, "hex");
        this.peers = {};
        this._pipes = {}
    }
}
Torrent.prototype.refreshPeers = function (cb, numWant = 100, overwrite = false) {
    let announce = Buffer.allocUnsafe(98);
    announce.writeIntBE(1, 8, 4, true); // action
    announce.fill(this.infoHashHex, 16, 36, "hex"); // info hash
    announce.fill(this._client.ID, 36, 56, "ascii"); // peer id
    announce.writeIntBE(0, 56, 8, true); // downloaded
    announce.writeIntBE(0, 64, 8, true); // left
    announce.writeIntBE(0, 72, 8, true); // uploaded
    announce.writeIntBE(0, 80, 4, true); // event
    announce.writeIntBE(0, 84, 4, true); // IP
    announce.writeIntBE(0, 88, 4, true); // key
    announce.writeIntBE(numWant, 92, 4, true); // num_want
    announce.writeUIntBE(0, 96, 2, true); // port

    console.log("UDP - Fetching Peers ::", this.infoHashHex);
    this._client.send(announce, function (msg) {
        let peers = msg.slice(20);
        console.log("\n", peers.length / 6, "/", numWant, "Peers Found\n");
        if (peers.length === 0) {
            if (cb) cb(new Error("NO PEERS FOUND"), this.infoHashHex);
            return;
        }
        for (let i = 0; i < peers.length; i += 6) {
            let address = peers.slice(i, i + 6),
                IP = address.slice(0, 4).join(".");
            if (IP in this.peers) {
                if (overwrite) this.peers[IP].destroy();
                else return false;
            }
            this.peers[IP] = new Peer(address, this, !this.info);
        }
        if (cb) cb(null, this.infoHashHex);
    }.bind(this));
}
Torrent.prototype._peerInfoCB = function (info, IP) {
    if (!this.ready) {
        let sha = crypto.createHash('sha1').update(info).digest();
        for (let i = this.infoHash.length; i--;)
            if (sha[i] !== this.infoHash[i]) return this.peers[IP].destroy();
        this.info = bencode.decode(info);
        //console.log(info);
        if (this.info.length) {
            for (let ft = FILETYPES.length; ft--;)
                if (this.info.name.toString().toLowerCase().endsWith(FILETYPES[ft]))
                    this.video = {
                        name: this.info.name.toString(),
                        length: this.info.length,
                        offset: 0
                    }
        }
        else if (this.info.files) {
            LOOP:
            for (let i = this.info.files.length; i--;) {
                for (let ft = FILETYPES.length; ft--;)
                    if (this.info.files[i].path.toString().toLowerCase().endsWith(FILETYPES[ft])) {
                        let offset = 0, j = i;
                        while (j--) offset += this.info.files[j].length;
                        this.video = {
                            name: this.info.files[i].path.toString(),
                            length: this.info.files[i].length,
                            offset: offset,
                        }
                        break LOOP;
                    }

            }

        }

        if (this.video === undefined) {
            this.emit("ready", new Error("Invalid video"), this);
            return this.destroy();
        }
        this.ready = true;
        this.video.pieceLength = this.info["piece length"];
        this.video.pieces = this.info.pieces;
        this.video.pieceCount = this.info.pieces.length / 20;
        this.emit("ready", null, this);
    }
};

Torrent.prototype._peerDestroyCB = function (IP) {
    if (this._destroyed) return;
    //console.log('TCP - Closed:', IP + ":" + this.peers[IP].port, ">>", Object.keys(this.peers).length, "left");
    this.peers[IP] = null;
    delete this.peers[IP];
}

Torrent.prototype.pipe = function (req, res, start, end) {
    if (!res) throw new Error("Torrent require response object in order to be piped");
    req.on("close", function () {
        if (req.IP in this._pipes) {
            this._pipes[req.IP].close = true;
            console.log("PIPE CLOSED :::::::::::::::::::::::::");
        }
    }.bind(this));

    this.res = res;
    this._pipes[req.IP] = {
        end: (end || this.video.length - 1) + this.video.offset,
        close: false,
        res: res
    }
    this._stream(req.IP, (start || 0) + this.video.offset);
}
Torrent.prototype._stream = function (IP, start) {
    let pipe = this._pipes[IP],
        pieceNotFound = true,
        piece, offset;
    pipe.start = start || pipe.start || 0;
    pipe.Piece = piece = ~~(pipe.start / this.video.pieceLength);
    pipe.Offset = offset = pipe.start % this.video.pieceLength;
    pipe.received = false;
    let req = Buffer.allocUnsafe(12);
    req.writeInt32BE(piece, 0);
    req.writeInt32BE(offset, 4);
    req.writeInt32BE(Math.min(pipe.end - pipe.start + 1, this.video.pieceLength - pipe.start % this.video.pieceLength, 2 ** 14), 8);

    for (let IP in this.peers) {
        let peer = this.peers[IP];
        if (peer.choked === false && peer.bitField.get(pipe.Piece) && pipe.Piece === piece && pipe.Offset === offset && !pipe.received) {
            pieceNotFound = false;
            peer.send(6, req);
            //console.log(IP, "HAS", req.readInt32BE(0), req.readInt32BE(4), req.readInt32BE(8));
            //break;
        }
    }
    if (pieceNotFound) {
        console.log("PIECE:", pipe.Piece, "NOT FOUND <");
        if (!this._client) throw new Error("Torrent requires a client in order for peers to be added");
        return setTimeout(this.refreshPeers.bind(this, this._stream.bind(this, IP)), 1000);
    }
    //else console.log("REQUESTED:", req.readInt32BE(0), req.readInt32BE(4), req.readInt32BE(8));
}
//Torrent.prototype._pieceCB = function (piece, offset, data) {
//    if (this.res._closePipe) {
//        this.res.end();
//        this.res = null;
//        return delete this.res;
//    }
//    if (piece === this._req.Piece && offset === this._req.Offset && !this._req.received) {
//        this._req.received = true;
//        this.res.write(data.slice(0, 1 + this._streamEnd - this._req.start));
//        return data.length + this._req.start > this._streamEnd ?
//            this.res.end() : this._stream(this._req.start + data.length);
//    }
//};
Torrent.prototype.destroy = function () {
    if (this._destroyed) return;
    this._destroyed = true;
    this._client._torrentDestroyCB(this.infoHashHex);
    this._cutPipe = true;
    for (let IP in this.peers) this.peers[IP].destroy();
    this.peers = null;
    delete this.peers;
    this._client = null;
    delete this._client;
}
module.exports = Torrent;