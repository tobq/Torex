function FFM(ob, prop) {
    ob[prop] = null;
    delete ob[prop];
}

function pack(bytes) {
    var retStr = '';
    var char, i, l;
    for (var i = 0, l = bytes.length; i < l;) {
        char = ((bytes[i++] & 0xff) << 8) | (bytes[i++] & 0x7F);
        retStr += String.fromCharCode(char);
    }
    return retStr;
}

function unpack(str) {
    var bytes = new Uint8Array(str.length);
    for (var i = 0, n = str.length; i < n; i++)  bytes[i] = str.charCodeAt(i) & 0x7F;
    return bytes;
}
function uitoa(uint64, bits) {
    if (bits % 8) throw Error("Invalid integer bit-size");
    var l = bits / 8;
    var arr = new Uint8Array(l);
    for (var i = l--; i--;)  arr[i] = uint64 / (2 ** (8 * (l - i))) & 0xFF;
    return arr;
}

function atoui(a) {
    var ui = 0;
    for (var i = a.length; i--;) {
        if (a[i] < 256) ui += a[i] * (2 ** ((a.length - i - 1) * 8));
        else throw Error("Invalid array values " + a[i]);
    }
    return ui;
}