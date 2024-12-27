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

let ALL_USERS = [];
let GARY_RAID_PARTY = [];
let IS_PAYED_OUT = false; // tracks whether payouts have occurred for the current raid
let REWARDS_TOTAL = 10000; // total reward to distribute among participants

// Store Gary deaths history
let GARRY_DEATHS = [];

// Track damage dealt by each user in the current raid (socketId -> damage)
let USER_DAMAGE_CURRENT_RAID = {};

let gameData = {};
let garyNPCClientId = null;

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

async function text_to_voice(text, voice, speed) {
	let tag = TAG + " | text_to_voice | ";
	try {
		console.log(tag,'text: ',text);
		if (!voice) voice = 'echo';
		if (!speed) speed = 1.0;

		const response = await openai.audio.speech.create({
			input: text,
			voice, // Example: 'alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'
			speed,
			model: 'tts-1',
		});

		if (!response.body || typeof response.body.pipe !== 'function') {
			throw new Error('Response body is missing or not a stream.');
		}

		const chunks = [];
		for await (const chunk of response.body) {
			chunks.push(chunk);
		}
		const audioBuffer = Buffer.concat(chunks);
		const base64Audio = audioBuffer.toString('base64');
		const audioDataURI = `data:audio/mp3;base64,${base64Audio}`;
		io.emit('UPDATE_VOICE', audioDataURI);
	} catch (e) {
		console.error(e);
	}
}

subscriber.on('message', async function (channel, payloadS) {
	let tag = TAG + ' | publishToGame | ';
	try {
		console.log(tag, "event: ", payloadS);
		if (channel === 'clubmoon-publish') {
			let payload = JSON.parse(payloadS);
			let { text, voice, speed } = payload;
			text_to_voice(text, voice, speed);
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

	socket.on('JOIN', function (_data) {
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
			health: data.model == -1 ? 500 : 100
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

		text_to_voice(currentUser.name + ' has joined the game', 'nova', .8);

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

	socket.on('JOIN_NPC', function (_data) {
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
			health: data.model == -1 ? 500 : 100
		};

		if (data.model == -1) {
			garyNPCClientId = currentUser.id;
		}

		console.log('[INFO] player ' + currentUser.name + ': logged!');
		publisher.publish('clubmoon-events', currentUser.name + ' has joined the game');
		publisher.publish('clubmoon-gary-join', JSON.stringify(currentUser));

		text_to_voice(currentUser.name + ' has joined the game', 'nova', .8);
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

		const userIndex = ALL_USERS.findIndex((u) => u.socketId === data.id);
		if(userIndex >= 0) {
			// Update user record with their wallet info
			ALL_USERS[userIndex].amount = data.message;
			console.log('Updated ALL_USERS: ',ALL_USERS);
		}
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
		console.log("FIGHT_STARTED");
		if (currentUser) {
			gameData.fightStarted = _data;
			if (_data == "False" && garyNPCClientId && clientLookup[garyNPCClientId]) {
				clientLookup[garyNPCClientId].health = 50
					;
			}
			socket.broadcast.emit('FIGHT_STARTED', _data);
		}
	});

	socket.on('SPAWN_PROJECTILE', function (_data) {
		io.emit('SPAWN_PROJECTILE', _data);
	});

	socket.on('ATTACK', async function (_data) {
		const data = JSON.parse(_data);
		let attackerUser = clientLookup[data.attackerId];
		let victimUser = clientLookup[data.victimId];
		//console.log('attackerUser: ', attackerUser);
		//console.log('victimUser: ', victimUser);
		//console.log('data.damage: ', data.damage);
		console.log("ATTACK EVENT || " + attackerUser.name + " attacked " + victimUser.name + " for " + data.damage + " damage");
		console.log("data.damage-typeof: ", typeof(victimUser.health));
		if (currentUser && attackerUser && victimUser) {

			publisher.publish('clubmoon-events', JSON.stringify({ channel: 'HEALTH', data, attackerUser, victimUser, event: 'DAMNAGE' }));
			victimUser.health -= Number(data.damage);
			console.log("victimUser.health: ", victimUser.health);
			if (victimUser.health <= 0) {
				console.log("DEAD EVENT || " + victimUser.name + " has died");
				publisher.publish('clubmoon-events', JSON.stringify({ channel: 'HEALTH', data, attackerUser, victimUser, event: 'DEAD' }));
			}
			victimUser.lastAttackedTime = new Date().getTime();
			io.emit('UPDATE_HEALTH', victimUser.id, victimUser.health);


			if (victimUser.id === garyNPCClientId) {
				//console.log('Gary is BEING ATTACKED!');
				let userIndex = ALL_USERS.findIndex((u) => u.socketId === attackerUser.id);
				//console.log('user Attacked gary!, ', userIndex);
				if (userIndex > -1) {
					if (!GARY_RAID_PARTY.includes(userIndex)) {
						GARY_RAID_PARTY.push(userIndex);
					}
					// Track damage
					USER_DAMAGE_CURRENT_RAID[attackerUser.id] = (USER_DAMAGE_CURRENT_RAID[attackerUser.id] || 0) + Number(data.damage);
				}

				if (victimUser.health < 0) {
					console.log('Gary is DEAD!');
					if (!IS_PAYED_OUT) {
						console.log('GARRY_DEATHS', GARRY_DEATHS);
						console.log('IS_PAYED_OUT', IS_PAYED_OUT);

						// Record Gary death
						let participants = GARY_RAID_PARTY.map((ui) => ALL_USERS[ui].name);
						GARRY_DEATHS.push({
							time: Date.now(),
							users: participants
						});

						IS_PAYED_OUT = true;
						await text_to_voice('Gary Has been Defeated!', 'nova', .8);
						const numParticipants = GARY_RAID_PARTY.length;
						await text_to_voice('numParticipants '+numParticipants, 'nova', .8);
						console.log('numParticipants: ',numParticipants)
						if (numParticipants > 0) {
							let totalDamage = 0;
							console.log('GARY_RAID_PARTY', GARY_RAID_PARTY);
							GARY_RAID_PARTY.forEach(ui => {
								let userSocketId = ALL_USERS[ui].socketId;
								let dmg = Number(USER_DAMAGE_CURRENT_RAID[userSocketId] || 0);
								text_to_voice('user: ' + ALL_USERS[ui].name + ' has done ' + dmg + ' damage', 'nova', .8);
								totalDamage += dmg;
								console.log('totalDamage:', totalDamage);
							});

							// Distribute rewards proportionally
							for (let i = 0; i < GARY_RAID_PARTY.length; i++) {
								console.log("GARY_RAID_PARTY:", GARY_RAID_PARTY[i]);
								let userIndex = GARY_RAID_PARTY[i];
								let user = ALL_USERS[userIndex];
								let userDamage = Number(USER_DAMAGE_CURRENT_RAID[user.socketId] || 0);
								let userShare = 0;

								if (totalDamage > 0) {
									userShare = Math.floor((userDamage / totalDamage) * REWARDS_TOTAL);
								}

								console.log("userShare:", userShare);
								if (userShare > 0 && user.amount) {
									// Send Token reward
									try {
										let sendTokenTx = await wallet.sendToken(
											"5gVSqhk41VA8U6U4Pvux6MSxFWqgptm3w58X9UTGpump",
											user.amount,
											userShare,
											"solana:mainnet",
											true
										);
										console.log("Sent Token Tx:", sendTokenTx);
										await text_to_voice('user: ' + user.name + ' has been rewarded ' + userShare + ' club moon tokens', 'nova', .8);
									} catch (error) {
										console.error("Error sending token reward:", error);
									}
								} else {
									console.log("User " + user.name + " gets no reward (no damage or no user address).");
								}
							}
						} else {
							console.log("No participants in GARY_RAID_PARTY, no rewards distributed.");
						}

						// Reset raid state after 15 minutes
						setTimeout(() => {
							IS_PAYED_OUT = false;
							GARY_RAID_PARTY = [];
							USER_DAMAGE_CURRENT_RAID = {};
							console.log("Reset IS_PAYED_OUT, GARY_RAID_PARTY, and USER_DAMAGE_CURRENT_RAID after 15 minutes.");
						}, 15 * 60 * 1000);
					}
				}
			}
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
				// Reset npc health after 10s
				// setTimeout(function () {
				// 	u.health = 50;
				// 	if (sockets[u.socketID]) {
				// 		sockets[u.socketID].emit('UPDATE_HEALTH', u.id, u.health);
				// 	}
				// }, 10000);
				console.log("Gary is dead!!!");
			}
		}
	});
}

setInterval(gameloop, 1000);

http.listen(process.env.PORT || 3000, function () {
	console.log('listening on *:3000');
});

console.log("------- server is running -------");
