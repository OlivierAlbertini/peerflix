#!/usr/bin/env node

var swarm = require('torrent-swarm');
var wire = require('torrent-wire-protocol');
var hat = require('hat');
var path = require('path');
var os = require('os');
var address = require('network-address');
var numeral = require('numeral');
var clivas = require('clivas');
var bitfield = require('bitfield');
var readTorrent = require('read-torrent');
var createServer = require('./server');

if (!process.argv[2]) {
	console.error('usage: torrenttv file_or_url.torrent');
	process.exit(1);
}

var biggest = function(torrent) {
	return torrent.files.reduce(function(biggest, file) {
		return biggest.length > file.length ? biggest : file;
	});
};

var MAX_PEERS = 60;
var MAX_QUEUED = 3;

var CHOKE_TIMEOUT = 15000;
var PIECE_TIMEOUT = 10000;
var HANDSHAKE_TIMEOUT = 5000;
var SPEED_TARGET = 8000;
var PEER_ID = '-TV0002-'+hat(48);

readTorrent(process.argv[2], function(err, torrent) {
	if (err) throw err;

	var selected = biggest(torrent);
	var server = createServer(torrent, selected, path.join(os.tmpDir(), torrent.infoHash+'.'+selected.offset));
	var peers = [];

	var speed = [0];
	var uploaded = 0;
	var downloaded = 0;

	var have = bitfield(torrent.pieces.length);

	server.on('readable', function(i) {
		have.set(i);
		peers.forEach(function(peer) {
			peer.have(i);
		});
	});

	var update = function() {
		peers.forEach(function(peer) {
			if (peer.peerChoking) return;

			(peer.downloaded ? server.missing : [].concat(server.missing).reverse()).some(function(piece) {
				if (peer.queued && !peer.downloaded) return true;
				if (peer.queued >= MAX_QUEUED)       return true;

				if (!peer.peerHave(piece)) return;
				if (peer.requesting(piece) && piece !== server.missing[0]) return;

				var offset = server.select(piece);

				if (offset === -1) return;

				peer.active();
				peer.request(piece, offset, server.sizeof(piece, offset));
			});
		});
	};

	var onconnection = function(connection, id, address) {
		if (!server.missing.length) return;

		var protocol = wire();

		connection.pipe(protocol).pipe(connection);

		var ontimeout = connection.destroy.bind(connection);
		var timeout = setTimeout(ontimeout, HANDSHAKE_TIMEOUT);

		protocol.once('handshake', function() {
			clearTimeout(timeout);

			peers.push(protocol);
			protocol.once('end', function() {
				clearTimeout(timeout);
				peers.splice(peers.indexOf(protocol), 1);
				if (protocol.downloaded) sw.reconnect(address);
			});

			protocol.on('unchoke', update);
			protocol.on('have', update);

			var onchoketimeout = function() {
				if (sw.queued && MAX_PEERS - peers.length < 10) return ontimeout();
				timeout = setTimeout(onchoketimeout, CHOKE_TIMEOUT);
			};

			protocol.on('choke', function() {
				clearTimeout(timeout);
				timeout = setTimeout(onchoketimeout, CHOKE_TIMEOUT);
			});

			protocol.on('unchoke', function() {
				clearTimeout(timeout);
			});

			protocol.once('interested', function() {
				protocol.unchoke();
			});

			timeout = setTimeout(onchoketimeout, CHOKE_TIMEOUT);
		});


		protocol.id = id;
		protocol.handshake(new Buffer(torrent.infoHash, 'hex'), PEER_ID); // handshake SHOULD accept a hex string as well...
		protocol.bitfield(have);
		protocol.interested();

		var hanging;
		var onidle = function() {
			if (protocol.queued) protocol.destroy();
		};

		protocol.active = function() { // TODO: move piece timeout to protocol impl
			clearTimeout(hanging);
			hanging = setTimeout(onidle, PIECE_TIMEOUT);
		};

		protocol.on('piece', function(index, offset, buffer) {
			speed[0] += buffer.length;
			downloaded += buffer.length;
			protocol.active();
			server.write(index, offset, buffer);
			update();
		});

		protocol.on('discard', function(index, offset, length) {
			server.deselect(index, offset);
		});

		protocol.on('request', function(index, offset, length) {
			server.read(index, offset, length, function(err, buffer) {
				if (err) return;
				uploaded += length;
				protocol.piece(index, offset, buffer);
			});
		});
	};

	var sw = swarm(torrent.infoHash, {maxSize:MAX_PEERS}, onconnection).listen();

	server.listen(8888);
	server.on('error', function() {
		server.listen(0);
	});

	server.on('listening', function() {
		var bytesPerSecond = function() {
			setInterval(function() {
				speed.unshift(speed[0]);
				speed = speed.slice(0, 15);
			}, 1000);

			return function() {
				return numeral((speed[1] - speed[speed.length-1]) / speed.length).format('0.00b')+'/s';
			};
		}();

		setInterval(function() {
			var unchoked = peers.filter(function(peer) {
				return !peer.peerChoking;
			});

			clivas.clear();
			clivas.line('{green:open} {bold:vlc} {green:and enter} {bold:http://'+address()+':'+server.address().port+'/} {green:as the network addres}');
			clivas.line('');
			clivas.line('{yellow:info} {green:streaming} {bold:'+server.filename.split('/').pop().replace(/\{|\}/g, '')+'} {green:-} {bold:'+bytesPerSecond()+'} {green:from} {bold:'+unchoked.length +'/'+peers.length+'} {green:peers}    ');
			clivas.line('{yellow:info} {green:downloaded} {bold:'+numeral(downloaded).format('0.00b')+'} {green:and uploaded }{bold:'+numeral(uploaded).format('0.00b')+'}        ');
			clivas.line('{yellow:info} {green:found }{bold:'+sw.peersFound+'} {green:peers and} {bold:'+sw.nodesFound+'} {green:nodes through the dht}');
			clivas.line('{yellow:info} {green:peer queue size is} {bold:'+sw.queued+'}     ');
			clivas.line('{yellow:info} {green:target pieces are} {80+bold:'+(server.missing.length ? server.missing.slice(0, 15).join(' ') : '(none)')+'}     ');
			clivas.line('{80:}');

			peers.slice(0, 30).forEach(function(peer) {
				var tags = [];
				if (peer.peerChoking) tags.push('choked');
				if (peer.peerHave(server.missing[0])) tags.push('target');

				clivas.line('{25+magenta:'+peer.id+'} {10:↓'+numeral(peer.downloaded).format('0.00b')+'}  {10:↑'+numeral(peer.uploaded).format('0.00b')+'} {20+grey:'+tags.join(', ')+'}');
			});

			if (peers.length > 30) {
				clivas.line('{80:}');
				clivas.line('... and '+(peers.length-30)+' more');
			}

			clivas.line('{80:}');
			clivas.flush();
		}, 500);
	});

});
