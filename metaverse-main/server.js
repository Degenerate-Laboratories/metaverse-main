/*
*  Clubmoon
*
* @description:  The MetaVerse for Degens
* @version: 0.0.1
*/
require("dotenv").config();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if(!OPENAI_API_KEY) console.error('ENV NOT SET! missing: OPENAI_API_KEY');
if(!process.env.REDIS_CONNECTION) console.error('ENV NOT SET! missing: REDIS_CONNECTION');

const SolanaLib = require('solana-wallet-1').default;
let seed = process.env['WALLET_SEED'];
// if(!seed) throw Error('Missing WALLET_SEED in .env file')

const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const path = require('path');
const { subscriber, publisher, redis } = require('@pioneer-platform/default-redis');
const OpenAI = require('openai');
const { speakLine } = require('./voiceUtils');

const openai = new OpenAI({
	apiKey: OPENAI_API_KEY,
});

const cors = require("cors");
const TAG = " | CLUBMOON | ";

let wallet = SolanaLib.init({ mnemonic: seed });

//FEATURE FLAGS
let FEATURE_FLAGS = {
	ROLL:false
};

let gameData = {};
let garyNPCClientId = null;

// Import Gary logic from gary.js
const {
	IS_PAYED_OUT,
	REWARDS_TOTAL,
	IS_GARY_ALIVE,
	GARRY_DEATHS,
	USER_DAMAGE_CURRENT_RAID,
	handleAttack,
	handleGaryDeath,
	distributeGaryRewards,
	resetRaidState
} = require('./gary.js');

let test_onStart = async function(){
	try {
		let address = await wallet.getAddress();
		console.log("Address:", address);
		//let sendTokenTx = await wallet.sendToken("5gVSqhk41VA8U6U4Pvux6MSxFWqgptm3w58X9UTGpump", "CD9R61PMZFafFQ9QsPZATm74hFyEvYaNtEtwGvvHmRYH", 1, "solana:mainnet", true)
		//console.log("sendTokenTx:", sendTokenTx);
	} catch(e) {
		console.error(e);
	}
};
test_onStart();

const corsOptions = {
	origin: '*',
	credentials: true,
	optionSuccessStatus: 200
};

app.use(cors(corsOptions));

// Utility functions
function getDistance(x1, y1, x2, y2) {
	let dx = x2 - x1;
	let dy = y2 - y1;
	return Math.sqrt(dx * dx + dy * dy);
}

function setCustomCacheControl(res, filePath) {
	const lastItem = filePath.split('.').pop();
	const isJsFile = filePath.endsWith(".js.br") || filePath.endsWith(".js.gz");

	if (lastItem === "br" || lastItem === "gz") {
		res.setHeader('Content-Type', isJsFile ? 'application/javascript' : 'application/wasm');
		res.setHeader('Content-Encoding', lastItem);
	}

	if (["json", "hash"].includes(lastItem)) {
		res.setHeader('Cache-Control', 'public, max-age=0');
	}
}

app.use("/public/TemplateData", express.static(__dirname + "/public/TemplateData"));
app.use("/public/Build", express.static(__dirname + "/public/Build"));
app.use(express.static(path.join(__dirname, 'public'), {
	setHeaders: setCustomCacheControl
}));

let previousChats = [];
const clients = [];
const clientLookup = {};
const sockets = {};

subscriber.subscribe('clubmoon-publish');

// ROLL setup
let ROLL = {
	partyA: null,
	partyB: null,
	amount: 0,
	partyAFunded: false,
	partyBFunded: false
};

// keep references to wallet, openai, etc. here
global.wallet = SolanaLib.init({ mnemonic: seed });
global.ALL_USERS = [];
global.gameData = gameData;
global.garyNPCClientId = garyNPCClientId;

function broadcastEventMessage(msg) {
	// Send a new message from the "SYSTEM" user to everyone
	io.emit('UPDATE_MESSAGE', 'SYSTEM', msg);
	previousChats.push({ id: 'SYSTEM', name: 'System', message: msg });
	if (previousChats.length > 10) {
		previousChats.shift();
	}
}

global.broadcastEventMessage = broadcastEventMessage;

io.on('connection', function (socket) {
	console.log('A user ready for connection!');
	let currentUser;

	socket.on('PING', function (_pack) {
		const pack = JSON.parse(_pack);
		console.log('message from user# ' + socket.id + ": " + pack.msg);
		socket.emit('PONG', socket.id, pack.msg);
	});

	socket.on('JOIN', async function (_data) {
		const data = JSON.parse(_data);
		currentUser = {
			name: data.name,
			publicAddress: data.publicAddress,
			model: data.model,
			posX: data.posX,
			posY: data.posY,
			posZ: data.posZ,
			rotation: '0',
			id: socket.id,
			socketID: socket.id,
			muteUsers: [],
			muteAll: false,
			isMute: true,
			health: data.model == -1 ? 100 : 100
		};

		if (data.model == -1) {
			garyNPCClientId = currentUser.id;
		}

		console.log('[INFO] player ' + currentUser.name + ': logged!');
		publisher.publish('clubmoon-events', currentUser.name + ' has joined the game');
		publisher.publish('clubmoon-join', JSON.stringify(currentUser));

		let user = {
			socketId: currentUser.id,
			name: currentUser.name,
		};
		ALL_USERS.push(user);
		console.log(currentUser.name + ' has joined the game')
		broadcastEventMessage(currentUser.name + ' has joined the game');
		speakLine(currentUser.name + ' has joined the game', 'nova', 0.8, io);

		clients.push(currentUser);
		clientLookup[currentUser.id] = currentUser;
		sockets[currentUser.id] = socket;
		console.log('[INFO] Total players: ' + clients.length);

		socket.emit("JOIN_SUCCESS", currentUser.id, currentUser.name, currentUser.posX, currentUser.posY, currentUser.posZ, data.model, gameData.fightStarted);

		// Send previous chats
		previousChats.forEach(function (i) {
			socket.emit('UPDATE_MESSAGE', i.id, i.message, i.name);
		});

		// Spawn existing players
		clients.forEach(function (i) {
			if (i.id != currentUser.id) {
				socket.emit('SPAWN_PLAYER', i.id, i.name, i.posX, i.posY, i.posZ, i.model);
			}
		});

		socket.broadcast.emit('SPAWN_PLAYER', currentUser.id, currentUser.name, currentUser.posX, currentUser.posY, currentUser.posZ, data.model);
	});

	socket.on('JOIN_NPC', async function (_data) {
		const data = JSON.parse(_data);
		currentUser = {
			name: data.name,
			publicAddress: data.publicAddress,
			model: data.model,
			posX: data.posX,
			posY: data.posY,
			posZ: data.posZ,
			rotation: '0',
			id: socket.id,
			socketID: socket.id,
			muteUsers: [],
			muteAll: false,
			isMute: true,
			health: data.model == -1 ? 1200 : 100
		};

		if (data.model == -1) {
			garyNPCClientId = currentUser.id;
		}

		socket.broadcast.emit('FIGHT_STARTED', "false");
		gameData.fightStarted = "false";
		console.log('[INFO] player ' + currentUser.name + ': logged!');
		publisher.publish('clubmoon-events', currentUser.name + ' has joined the game');
		publisher.publish('clubmoon-gary-join', JSON.stringify(currentUser));

		speakLine(currentUser.name + ' has joined the game', 'nova', 0.8, io);
		clients.push(currentUser);
		clientLookup[currentUser.id] = currentUser;
		sockets[currentUser.id] = socket;
		console.log('[INFO] Total players: ' + clients.length);

		socket.emit("JOIN_SUCCESS", currentUser.id, currentUser.name, currentUser.posX, currentUser.posY, currentUser.posZ, data.model, gameData.fightStarted);

		previousChats.forEach(function (i) {
			socket.emit('UPDATE_MESSAGE', i.id, i.message, i.name);
		});

		clients.forEach(function (i) {
			if (i.id != currentUser.id) {
				socket.emit('SPAWN_PLAYER', i.id, i.name, i.posX, i.posY, i.posZ, i.model);
			}
		});

		socket.broadcast.emit('SPAWN_PLAYER', currentUser.id, currentUser.name, currentUser.posX, currentUser.posY, currentUser.posZ, data.model);
	});

	socket.on('MOVE_AND_ROTATE', function (_data) {
		const data = JSON.parse(_data);
		if (currentUser) {
			currentUser.posX = data.posX;
			currentUser.posY = data.posY;
			currentUser.posZ = data.posZ;
			currentUser.rotation = data.rotation;
			socket.broadcast.emit('UPDATE_MOVE_AND_ROTATE', currentUser.id, currentUser.posX, currentUser.posY, currentUser.posZ, currentUser.rotation);
		}
	});

	socket.on('ANIMATION', function (_data) {
		const data = JSON.parse(_data);
		if (currentUser) {
			currentUser.timeOut = 0;
			socket.broadcast.emit('UPDATE_PLAYER_ANIMATOR', currentUser.id, data.key, data.value, data.type);
		}
	});

	socket.on('GET_USERS_LIST', function () {
		if (currentUser) {
			clients.forEach(function (i) {
				if (i.id != currentUser.id) {
					socket.emit('UPDATE_USER_LIST', i.id, i.name, i.publicAddress);
				}
			});
		}
	});

	socket.on('MESSAGE', async function (_data) {
		const data = JSON.parse(_data);
		publisher.publish('clubmoon-messages', JSON.stringify({ channel: 'MESSAGE', data }));
		if (currentUser) {
			// Handle commands
			if(data.message.indexOf('/roll') > -1 && FEATURE_FLAGS.ROLL) {
				// TODO: Implement roll logic if needed
			} else if(data.message.indexOf('/checkTx') > -1 && FEATURE_FLAGS.ROLL) {
				// TODO: Implement checkTx logic
			} else if(data.message.indexOf('/accept') > -1 && FEATURE_FLAGS.ROLL) {
				// TODO: Implement accept logic
			} else if(data.message.indexOf('/address') > -1) {
				let address = await wallet.getAddress();
				socket.emit('UPDATE_MESSAGE', currentUser.id, address);
			} else if(data.message.indexOf('/balance') > -1) {
				let balance = await wallet.getBalance("solana:mainnet");
				let tokenBalance = await wallet.getTokenBalance("5gVSqhk41VA8U6U4Pvux6MSxFWqgptm3w58X9UTGpump", "solana:mainnet");
				let message = "SOL Balance "+balance.toString()+" CLUBMOON Token Balance "+tokenBalance.toString();
				socket.emit('UPDATE_MESSAGE', currentUser.id, message);
			} else if(data.message.indexOf('/gary') > -1) {
				let message = "Gary Death History:\n";
				if(GARRY_DEATHS.length === 0) {
					message += "No Gary deaths recorded yet.";
				} else {
					GARRY_DEATHS.forEach((death, index) => {
						let date = new Date(death.time).toLocaleString();
						message += `Death #${(index+1)} at ${date}  Participants: ${death.users.length}  Users: ${death.users.join(', ')}\n`;
					});
				}
				socket.emit('UPDATE_MESSAGE', currentUser.id, message);
			} else {
				// Normal chat
				socket.emit('UPDATE_MESSAGE', currentUser.id, data.message);
				socket.broadcast.emit('UPDATE_MESSAGE', currentUser.id, data.message);
				previousChats.push({ id: currentUser.id, name: currentUser.name, message: data.message });
				if (previousChats.length > 10) {
					previousChats.shift();
				}
			}
		}
	});

	socket.on('WALLETMESSAGE', function (_data) {
		const data = JSON.parse(_data);
		publisher.publish('clubmoon-wallet-connect', JSON.stringify({ channel: 'WALLET_MESSAGE', data }));
		console.log("User Address: " + data.message);

		const userIndex = global.ALL_USERS.findIndex((u) => u.socketId === data.id);
		if(userIndex >= 0) {
			// Update user record with their wallet info
			ALL_USERS[userIndex].amount = data.message; // 'amount' is wallet address
			console.log('Updated global.ALL_USERS: ', global.ALL_USERS);
		}
	});

	socket.on('RESET_GARY_HEALTH', function (_data) {
		resetGaryHealth();
	});

	socket.on('PRIVATE_MESSAGE', function (_data) {
		const data = JSON.parse(_data);
		publisher.publish('clubmoon-messages', JSON.stringify({ channel: 'PRIVATE_MESSAGE', data }));
		if (currentUser) {
			socket.emit('UPDATE_PRIVATE_MESSAGE', data.chat_box_id, currentUser.id, data.message);
			if (sockets[data.guest_id]) {
				sockets[data.guest_id].emit('UPDATE_PRIVATE_MESSAGE', data.chat_box_id, currentUser.id, data.message);
			}
		}
	});

	socket.on('SEND_OPEN_CHAT_BOX', function (_data) {
		const data = JSON.parse(_data);
		if (currentUser) {
			socket.emit('RECEIVE_OPEN_CHAT_BOX', currentUser.id, data.player_id);
			clients.forEach(function (i) {
				if (i.id == data.player_id) {
					sockets[i.id].emit('RECEIVE_OPEN_CHAT_BOX', currentUser.id, i.id);
				}
			});
		}
	});

	socket.on('MUTE_ALL_USERS', function () {
		if (currentUser) {
			currentUser.muteAll = true;
			clients.forEach(function (u) {
				currentUser.muteUsers.push(clientLookup[u.id]);
			});
		}
	});

	socket.on('REMOVE_MUTE_ALL_USERS', function () {
		if (currentUser) {
			currentUser.muteAll = false;
			currentUser.muteUsers = [];
		}
	});

	socket.on('ADD_MUTE_USER', function (_data) {
		const data = JSON.parse(_data);
		if (currentUser) {
			console.log("add mute user: " + clientLookup[data.id].name);
			currentUser.muteUsers.push(clientLookup[data.id]);
		}
	});

	socket.on('REMOVE_MUTE_USER', function (_data) {
		const data = JSON.parse(_data);
		if (currentUser) {
			for (let i = 0; i < currentUser.muteUsers.length; i++) {
				if (currentUser.muteUsers[i].id == data.id) {
					console.log("User " + currentUser.muteUsers[i].name + " removed from mute list");
					currentUser.muteUsers.splice(i, 1);
					break;
				}
			}
		}
	});

	socket.on('FIGHT_STARTED', function (_data) {
		console.log("FIGHT_STARTED: " + _data);
		if (currentUser) {
			gameData.fightStarted = _data;
			if (_data != "True" && garyNPCClientId && clientLookup[garyNPCClientId]) {
				
				sockets[garyNPCClientId].emit('UPDATE_HEALTH', garyNPCClientId, 1000);

			}



			socket.broadcast.emit('FIGHT_STARTED', _data);

			//sockets[u.socketID].emit('UPDATE_HEALTH', u.id, u.health);
		}
	});

	socket.on('SPAWN_PROJECTILE', function (_data) {
		io.emit('SPAWN_PROJECTILE', _data);
	});

	socket.on('ATTACK', async function (_data) {
		const data = JSON.parse(_data);
		let attackerUser = clientLookup[data.attackerId];
		let victimUser = clientLookup[data.victimId];
		if (currentUser && attackerUser && victimUser) {
			await handleAttack(data, attackerUser, victimUser, io, socket, publisher);
		}
	});

	socket.on("VOICE", function (data) {
		const minDistanceToPlayer = 3;
		if (currentUser) {
			let newData = data.split(";");
			newData[0] = "data:audio/ogg;";
			newData = newData[0] + newData[1];

			clients.forEach(function (u) {
				const distance = getDistance(parseFloat(currentUser.posX), parseFloat(currentUser.posY), parseFloat(u.posX), parseFloat(u.posY));
				let muteUser = currentUser.muteUsers.some(mU => mU.id == u.id);

				if (sockets[u.id] && u.id != currentUser.id && !currentUser.isMute && distance < minDistanceToPlayer && !muteUser && !u.muteAll) {
					sockets[u.id].emit('UPDATE_VOICE', newData);
					sockets[u.id].broadcast.emit('SEND_USER_VOICE_INFO', currentUser.id);
				}
			});
		}
	});

	socket.on("AUDIO_MUTE", function () {
		if (currentUser) {
			currentUser.isMute = !currentUser.isMute;
		}
	});

	socket.on('disconnect', function () {
		publisher.publish('clubmoon-events', JSON.stringify({ channel: 'DISCONNECT', data: currentUser, event: 'LEAVE' }));
		for (let i = 0; i < clients.length; i++) {
			if (clients[i].id == socket.id) {
				console.log("User " + clients[i].name + " has disconnected");
				clients[i].isDead = true;
				socket.broadcast.emit('USER_DISCONNECTED', socket.id);
				clients.splice(i, 1);
				break;
			}
		}
	});
});

function gameloop() {
	clients.forEach(function (u) {
		if (u.model != -1) {
			// Regular player
			if (u.lastAttackedTime && new Date().getTime() - u.lastAttackedTime > 6000) {
				u.health = 100;
				if (sockets[u.socketID]) {
					sockets[u.socketID].emit('UPDATE_HEALTH', u.id, u.health);
				}
			}
		} else {
			// NPC (Gary)
			if (u.health < 0) {
				// //Reset npc health after 15s
				// setTimeout(function () {
				// 	u.health = 500;
				// 	if (sockets[u.socketID]) {
				// 		sockets[u.socketID].emit('UPDATE_HEALTH', u.id, u.health);
				// 	}
				// }, 15000);
				// //console.log("Gary is dead!!!");
			}
		}
	});
}

function resetGaryHealth() {
	if (garyNPCClientId && clientLookup[garyNPCClientId]) {
		let gary = clientLookup[garyNPCClientId];
		gary.health = 1000; // Set Gary's health to full
		sockets[garyNPCClientId].emit('UPDATE_HEALTH', garyNPCClientId, gary.health);
		console.log(`Gary's health has been reset to ${gary.health}`);
	} else {
		console.log('Gary is not currently in the game.');
	}
}

setInterval(gameloop, 1000);

http.listen(process.env.PORT || 3000, function () {
	console.log('listening on *:3000');
});

console.log("------- server is running -------");
