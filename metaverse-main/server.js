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

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if(!ADMIN_PASSWORD) console.error('Admin Password not set!')

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
const TAG_ADMIN = " | ADMIN | ";

let wallet = SolanaLib.init({ mnemonic: seed });

//FEATURE FLAGS
let FEATURE_FLAGS = {
	ROLL:false
};

// Add global transaction fee with default value
global.TRANSACTION_FEE = 5000000; // Default fee in lamports (5 SOL)

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

let ADMIN_SOCKET_ID = null;

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

subscriber.on('message', async function (channel, payloadS) {
	let tag = TAG + ' | publishToGame | ';
	try {
		console.log(tag, "event: ", payloadS);
		console.log(tag, "channel: ", channel);
		if (channel === 'clubmoon-publish') {
			let payload = JSON.parse(payloadS);
			let { text, voice, speed } = payload;
			console.log(tag, "text: ", text);
			console.log(tag,"voice:", voice);
			console.log(tag,"speed:", speed);
			await speakLine(text, voice, speed, io);
		}
	} catch (e) {
		console.error(e);
	}
});

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
		if(data.name == process.env['ADMIN_PASSWORD'] && process.env['ADMIN_PASSWORD'].length > 2){
			data.name = 'admin';
			ADMIN_SOCKET_ID = socket.id;
			speakLine('welcome Admin');
		} else if(data.name.indexOf('admin') > -1){
			data.name = 'notAdmin'
		}
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
			health: data.model == -1 ? 1000 : 100
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
			health: data.model == -1 ? 50 : 100
		};

		if (data.model == -1) {
			garyNPCClientId = currentUser.id;
		}

		socket.broadcast.emit('FIGHT_STARTED', "false");
		gameData.fightStarted = "false";
		console.log('[INFO] player ' + currentUser.name + ': logged!');
		publisher.publish('clubmoon-events', currentUser.name + ' has joined the game');
		publisher.publish('clubmoon-gary-join', JSON.stringify(currentUser));

		await speakLine(currentUser.name + ' has joined the game', 'nova', 0.8, io);
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
			// Check for admin commands
			if (currentUser.id === ADMIN_SOCKET_ID) {
				if (data.message.startsWith('/admin')) {
					const args = data.message.split(' ');
					const command = args[1];
					
					switch(command) {
						case 'setGaryHealth':
							const health = parseInt(args[2]);
							console.log(TAG_ADMIN, `Attempting to set Gary's health to ${health}`);
							if (garyNPCClientId && clientLookup[garyNPCClientId]) {
								clientLookup[garyNPCClientId].health = health;
								sockets[garyNPCClientId].emit('UPDATE_HEALTH', garyNPCClientId, health);
								const msg = `Gary's health set to ${health}`;
								console.log(TAG_ADMIN, msg);
								socket.emit('UPDATE_MESSAGE', 'SYSTEM', msg);
							} else {
								const msg = 'Gary is not currently in the game';
								console.log(TAG_ADMIN, 'Error:', msg);
								socket.emit('UPDATE_MESSAGE', 'SYSTEM', msg);
							}
							return;
							
						case 'getGaryHealth':
							console.log(TAG_ADMIN, 'Getting Gary\'s health status');
							const gary = garyNPCClientId ? clientLookup[garyNPCClientId] : null;
							const healthMsg = gary ? `Gary's current health: ${gary.health}` : 'Gary is not in the game';
							console.log(TAG_ADMIN, healthMsg);
							socket.emit('UPDATE_MESSAGE', 'SYSTEM', healthMsg);
							return;

						case 'getFee':{
							console.log(TAG_ADMIN, 'Getting current transaction fee');
							const currentFee = global.TRANSACTION_FEE;
							let feeInSol = currentFee / 1000000000; // Convert lamports to SOL
							const feeMsg = `Current transaction fee: ${currentFee} lamports (${feeInSol} SOL)`;
							console.log(TAG_ADMIN, feeMsg);
							socket.emit('UPDATE_MESSAGE', 'SYSTEM', feeMsg);
							return;
						}

						case 'setFee':{
							let feeInSol = parseFloat(args[2]);
							console.log(TAG_ADMIN, `Attempting to set transaction fee to ${feeInSol} SOL`);
							if (!isNaN(feeInSol) && feeInSol >= 0) {
								const feeInLamports = Math.floor(feeInSol * 1000000000);
								global.TRANSACTION_FEE = feeInLamports;
								const msg = `Transaction fee set to ${feeInLamports} lamports (${feeInSol} SOL)`;
								console.log(TAG_ADMIN, msg);
								socket.emit('UPDATE_MESSAGE', 'SYSTEM', msg);
							} else {
								const msg = 'Invalid fee amount. Please provide a valid number in SOL';
								console.log(TAG_ADMIN, 'Error:', msg);
								socket.emit('UPDATE_MESSAGE', 'SYSTEM', msg);
							}
							return;
						}

						case 'setUnits':
							const units = parseInt(args[2]);
							console.log(TAG_ADMIN, `Attempting to set reward units to ${units}`);
							if (!isNaN(units) && units > 0) {
								global.REWARD_UNITS = units;
								const msg = `Reward units set to ${units}`;
								console.log(TAG_ADMIN, msg);
								socket.emit('UPDATE_MESSAGE', 'SYSTEM', msg);
							} else {
								const msg = 'Invalid units amount';
								console.log(TAG_ADMIN, 'Error:', msg);
								socket.emit('UPDATE_MESSAGE', 'SYSTEM', msg);
							}
							return;

						case 'clearRaid':
							console.log(TAG_ADMIN, 'Clearing raid state...');
							const previousPartySize = global.GARY_RAID_PARTY.length;
							global.GARY_RAID_PARTY = [];
							global.USER_DAMAGE_CURRENT_RAID = {};
							global.IS_PAYED_OUT = false;
							global.IS_GARY_ALIVE = true;
							const clearMsg = `Raid state cleared. Previous party size: ${previousPartySize}, damage records cleared, payout reset.`;
							console.log(TAG_ADMIN, clearMsg);
							socket.emit('UPDATE_MESSAGE', 'SYSTEM', clearMsg);
							return;

						case 'setRewards':
							const amount = parseInt(args[2]);
							console.log(TAG_ADMIN, `Attempting to set rewards amount to ${amount}`);
							if (!isNaN(amount) && amount >= 0) {
								global.REWARDS_TOTAL = amount;
								const msg = `Rewards amount set to ${amount}`;
								console.log(TAG_ADMIN, msg);
								socket.emit('UPDATE_MESSAGE', 'SYSTEM', msg);
							} else {
								const msg = 'Invalid rewards amount';
								console.log(TAG_ADMIN, 'Error:', msg);
								socket.emit('UPDATE_MESSAGE', 'SYSTEM', msg);
							}
							return;

						case 'status':
							console.log(TAG_ADMIN, 'Getting system status...');
							const currentGary = garyNPCClientId ? clientLookup[garyNPCClientId] : null;
							const statusMsg = `=== Current Settings ===\n` +
								`-- Gary Status --\n` +
								`Health: ${currentGary ? currentGary.health : 'N/A'}\n` +
								`Is Alive: ${global.IS_GARY_ALIVE}\n` +
								`Raid Party Size: ${global.GARY_RAID_PARTY.length}\n` +
								`Is Paid Out: ${global.IS_PAYED_OUT}\n\n` +
								`-- Economy Settings --\n` +
								`Rewards Total: ${global.REWARDS_TOTAL}\n` +
								`Transaction Fee: ${global.TRANSACTION_FEE} lamports (${global.TRANSACTION_FEE/1000000000} SOL)\n` +
								`Reward Units: ${global.REWARD_UNITS || 0}\n\n` +
								`-- Game Stats --\n` +
									`Total Players: ${clients.length}\n` +
									`Total Deaths: ${GARRY_DEATHS.length}`;
							console.log(TAG_ADMIN, 'Status:', statusMsg);
							socket.emit('UPDATE_MESSAGE', 'SYSTEM', statusMsg);
							return;

						case 'help':
							console.log(TAG_ADMIN, 'Displaying admin help menu');
							const helpMsg = '=== Admin Commands ===\n' +
								'-- Gary Management --\n' +
								'/admin getGaryHealth - Get Gary\'s current health\n' +
								'/admin setGaryHealth <amount> - Set Gary\'s health\n' +
								'/admin clearRaid - Reset raid state\n\n' +
								'-- Economy Settings --\n' +
								'/admin getFee - Show current transaction fee\n' +
								'/admin setFee <amount> - Set transaction fee (in SOL)\n' +
								'/admin setRewards <amount> - Set reward amount\n' +
								'/admin setUnits <amount> - Set reward units\n\n' +
								'-- System Commands --\n' +
								'/admin status - Show all current settings\n' +
								'/help - Show all available commands including regular ones';
							socket.emit('UPDATE_MESSAGE', 'SYSTEM', helpMsg);
							return;

						default:
							const errMsg = 'Unknown admin command. Type /admin help for commands';
							console.log(TAG_ADMIN, 'Error:', errMsg);
							socket.emit('UPDATE_MESSAGE', 'SYSTEM', errMsg);
							return;
					}
				}
			}
			
			// Handle regular commands
			if (data.message.startsWith('/help')) {
				let helpMessage = '=== Available Commands ===\n' +
					'/help - Show this help message\n' +
					'/gary - Show Gary raid history\n' +
					'/address - Show wallet address\n' +
					'/balance - Show SOL and token balances\n';

				if (FEATURE_FLAGS.ROLL) {
					helpMessage += '\n=== Game Commands ===\n' +
						'/roll <amount> - Start a roll game\n' +
						'/accept - Accept a roll challenge\n' +
						'/checkTx - Check transaction status\n';
				}

				// Add admin commands section if user is admin
				if (currentUser.id === ADMIN_SOCKET_ID) {
					helpMessage += '\n=== Admin Commands ===\n' +
						'/admin setGaryHealth <amount> - Set Gary\'s health\n' +
						'/admin setRewards <amount> - Set reward amount\n' +
						'/admin clearRaid - Reset raid state\n' +
						'/admin status - Show current settings\n';
				}

				socket.emit('UPDATE_MESSAGE', 'SYSTEM', helpMessage);
				return;
			}
			
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
				
				sockets[garyNPCClientId].emit('UPDATE_HEALTH', garyNPCClientId, 50);

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
		gary.health = 50; // Set Gary's health to full
		sockets[garyNPCClientId].emit('UPDATE_HEALTH', garyNPCClientId, gary.health);
		console.log(`Gary's health has been reset to ${gary.health}`);
		// Clear raid party and related state
        global.GARY_RAID_PARTY = [];
        global.USER_DAMAGE_CURRENT_RAID = {};
        global.IS_PAYED_OUT = false;
        global.IS_GARY_ALIVE = true;
	} else {
		console.log('Gary is not currently in the game.');
	}
}

setInterval(gameloop, 1000);

http.listen(process.env.PORT || 3000, function () {
	console.log('listening on *:3000');
});

console.log("------- server is running -------");
