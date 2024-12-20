/*
*  Clubmoon
*
* 		@description:  The MetaVerse for Degens
*
*   	@version: 0.0.1
*
*/
require("dotenv").config()
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if(!OPENAI_API_KEY) console.error('ENV NOT SET! missing: OPENAI_API_KEY')
if(!process.env.REDIS_CONNECTION) console.error('ENV NOT SET! missing: REDIS_CONNECTION')
const SolanaLib = require('solana-wallet-1').default

let seed = process.env['WALLET_SEED']
// if(!seed) throw Error('Missing WALLET_SEED in .env file')

const express = require('express');//import express NodeJS framework module
const app = express();// create an object of the express module
const http = require('http').Server(app);// create a http web server using the http library
const io = require('socket.io')(http);// import socketio communication module
const path = require('path');
const { subscriber, publisher, redis } = require('@pioneer-platform/default-redis')
const OpenAI = require('openai');
const openai = new OpenAI({
	apiKey: process.env['OPENAI_API_KEY'], // This is the default and can be omitted
});
const cors = require("cors");
const TAG = " | CLUBMOON | "

let wallet = SolanaLib.init({ mnemonic: seed })

//FEATURE FLAGS
let FEATURE_FLAGS = {
	ROLL:false
}

let ALL_USERS = []
let GARY_RAID_PARTY = []
let IS_PAYED_OUT = false; // tracks whether payouts have occurred for current raid
let REWARDS_TOTAL = 10000; // total reward to distribute among participants

// Store Gary deaths history
let GARRY_DEATHS = [];

// Track damage dealt by each user in the current raid
// key: user socketId, value: total damage done
let USER_DAMAGE_CURRENT_RAID = {};

let test_onStart = async function(){
	try{
		let address = await wallet.getAddress()
		console.log("Address:", address)
	}catch(e){
		console.error(e)
	}
}
test_onStart()

const corsOptions = {
	origin: '*',
	credentials: true,            //access-control-allow-credentials:true
	optionSuccessStatus: 200
}

let garyNPCClientId = null;
let gameData = {}

app.use(cors(corsOptions)) // Use this after the variable declaration

function getDistance(x1, y1, x2, y2) {
	let y = x2 - x1;
	let x = y2 - y1;
	return Math.sqrt(x * x + y * y);
}

function setCustomCacheControl(res, path) {
	const lastItem = path.split('.').pop();
	const isJsFile = path.endsWith(".js.br") || path.endsWith(".js.gz");

	if (lastItem === "br" || lastItem === "gz") {
		res.setHeader('Content-Type', isJsFile ? 'application/javascript' : 'application/wasm');
		res.setHeader('Content-Encoding', lastItem);
	}

	if (["json", "hash"].includes(lastItem) ||
		["text/html", "application/xml"].includes(express.static.mime.lookup(path))) {
		res.setHeader('Cache-Control', 'public, max-age=0');
	}
}

app.use("/public/TemplateData", express.static(__dirname + "/public/TemplateData"));
app.use("/public/Build", express.static(__dirname + "/public/Build"));
app.use(express.static(path.join(__dirname, 'public'), {
	setHeaders: setCustomCacheControl
}))

let previousChats = [];
const clients = [];// to storage clients
const clientLookup = {};// clients search engine
const sockets = {};//// to storage sockets

subscriber.subscribe('clubmoon-publish');

let ROLL = {
	partyA: null,
	partyB: null,
	amount: 0,
	fundingPartA: null,
	fundingPartB: null,
}

let text_to_voice = async function (text, voice, speed) {
	let tag = TAG + " | text_to_voice | "
	try {
		console.log(tag,'text: ',text)
		if (!voice) voice = 'echo'
		if (!speed) speed = 1.0
		// Call OpenAI API to generate audio
		const response = await openai.audio.speech.create({
			input: text,
			voice, // 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'
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
		console.error(e)
	}
}

subscriber.on('message', async function (channel, payloadS) {
	let tag = TAG + ' | publishToGame | ';
	try {
		console.log(tag, "event: ", payloadS)
		if (channel === 'clubmoon-publish') {
			let payload = JSON.parse(payloadS)
			let { text, voice, speed } = payload
			text_to_voice(text, voice, speed)
		}
	} catch (e) {
		console.error()
	}
});

io.on('connection', function (socket) {
	console.log('A user ready for connection!');

	let currentUser;
	const sended = false;
	const muteAll = false;

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
			health: 100
		};

		if (data.model == -1) {
			currentUser.health = 500
			garyNPCClientId = currentUser.id;
		}

		console.log('[INFO] player ' + currentUser.name + ': logged!');
		publisher.publish('clubmoon-events', currentUser.name + ' has joined the game');
		publisher.publish('clubmoon-join', JSON.stringify(currentUser));

		let user = {
			socketId: currentUser.id,
			name: currentUser.name,
		}
		ALL_USERS.push(user)

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
			health: 100
		};

		if (data.model == -1) {
			currentUser.health = 500
			garyNPCClientId = currentUser.id;
		}

		console.log('[INFO] player ' + currentUser.name + ': logged!');
		publisher.publish('clubmoon-events', currentUser.name + ' has joined the game');
		publisher.publish('clubmoon-gary-join', JSON.stringify(currentUser));
		GARY_SOCKET_ID = currentUser.id;

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

	socket.on('GET_USERS_LIST', function (pack) {
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
			if(data.message.indexOf('/roll') > -1 && FEATURE_FLAGS.ROLL){
				const foundUser = ALL_USERS.find(user => user.id === data.id);
				if(foundUser){
					if(ROLL.partyA == null){
						ROLL.partyA = currentUser.id;
						let amount = data.message.split(' ')[1];
						if(!amount || isNaN(amount) || parseFloat(amount <= 0)){
							console.error('Unable to create roll, invalid amount')
							sockets[data.id].emit('UPDATE_MESSAGE', 'Unable to create roll, invalid amount');
							ROLL = { partyA: null, partyB: null, amount: 0 }
						}
						ROLL.amount = parseFloat(amount);
						let address = await wallet.getAddress()
						sockets[data.id].emit('UPDATE_MESSAGE', 'address: '+address+" only send "+amount+" to this address to join the roll");
					} else {
						console.error('ROLL ALREADY START CAN NOT CLAIM!')
					}
				} else {
					console.error('USER HAS NO WALLET PAIRED!')
					sockets[data.id].emit('UPDATE_MESSAGE', 'Unable to create roll, You must first pair wallet!!');
				}
			} else if(data.message.indexOf('/checkTx') > -1 && FEATURE_FLAGS.ROLL) {
				let incomingTransfers = await wallet.getIncomingTransfers("solana:mainnet", 10)
				incomingTransfers.forEach(t => {
					const matchedUser = ALL_USERS.find(user => user.id === t.from);
					if (matchedUser) {
						console.log("Found a matching user for t.from:", matchedUser);
					}
					if(ROLL.partyA == matchedUser.id){
						console.log("FUNDED PARTY A")
						ROLL.partyAFunded = true;
					}
					if(ROLL.partyB == matchedUser.id){
						console.log("FUNDED PARTY B")
						ROLL.partyBFunded = true;
					}
				});
			} else if(data.message.indexOf('/accept') > -1 && FEATURE_FLAGS.ROLL){
				const foundUser = ALL_USERS.find(user => user.id === data.id);
				if(foundUser){
					if(ROLL.partyB == null){
						ROLL.partyB = currentUser.id;
						let address = await wallet.getAddress()
						sockets[data.id].emit('UPDATE_MESSAGE', 'address: '+address+" only send "+ROLL.amount+" to this address to join the roll");

						const randomNumber = Math.floor(Math.random() * 100) + 1;
						await text_to_voice('Roll has begun! The winner will be determined by a random number between 1 and 100. Good luck! .... '+randomNumber, 'nova',0.8)

						let winner;
						if (randomNumber <= 50) {
							winner = ROLL.partyA;
							await text_to_voice('Winner! ' + ROLL.partyA + 'has won! ', 'nova',0.8)
						} else {
							winner = ROLL.partyB;
							await text_to_voice('Winner! ' + ROLL.partyB + 'has won! ', 'nova',0.8)
						}

						const payout = ROLL.amount * 1.8;
						console.log('payout: ',payout)
						try {
							//TODO send payout
							console.log("Payout transaction hash:", 'fakeTXIDBRO');
							sockets[data.id].emit('UPDATE_MESSAGE', `The winner is ${winner}! ${payout} has been sent to the winner's address.`);
						} catch (error) {
							console.error("Error sending payout:", error);
							sockets[data.id].emit('UPDATE_MESSAGE', `Failed to send payout to ${winner}. Please try again.`);
						}
					} else {
						console.error("ROLL ALREADY COMPLETE! CAN NOT ACCEPT")
					}
				} else {
					console.error('USER HAS NO WALLET PAIRED!')
					sockets[data.id].emit('UPDATE_MESSAGE', 'Unable to accept roll, You must first pair wallet!!');
				}
			} else if(data.message.indexOf('/address') > -1){
				let address = await wallet.getAddress()
				socket.emit('UPDATE_MESSAGE', currentUser.id, address);
			} else if(data.message.indexOf('/balance') > -1){
				let balance = await wallet.getBalance("solana:mainnet")
				let tokenBalance = await wallet.getTokenBalance("5gVSqhk41VA8U6U4Pvux6MSxFWqgptm3w58X9UTGpump", "solana:mainnet")
				let message = "SOL Balance "+balance.toString()+" CLUBMOON Token Balance "+tokenBalance.toString()
				socket.emit('UPDATE_MESSAGE', currentUser.id, message);
			} else if(data.message.indexOf('/gary') > -1){
				let message = "Gary Death History:\n";
				if(GARRY_DEATHS.length === 0) {
					message += "No Gary deaths recorded yet.";
				} else {
					GARRY_DEATHS.forEach((death, index) => {
						let date = new Date(death.time).toLocaleString();
						message += `Death #${(index+1)} at ${date} | Participants: ${death.users.length} | Users: ${death.users.join(', ')}\n`;
					});
				}
				socket.emit('UPDATE_MESSAGE', currentUser.id, message);
			} else {
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
		if(userIndex >= 0){
			ALL_USERS[userIndex] = data.message
			console.log('Updated All users: ',ALL_USERS)
		}
	});

	socket.on('PRIVATE_MESSAGE', function (_data) {
		const data = JSON.parse(_data);
		publisher.publish('clubmoon-messages', JSON.stringify({ channel: 'PRIVATE_MESSAGE', data }));
		if (currentUser) {
			socket.emit('UPDATE_PRIVATE_MESSAGE', data.chat_box_id, currentUser.id, data.message);
			sockets[data.guest_id].emit('UPDATE_PRIVATE_MESSAGE', data.chat_box_id, currentUser.id, data.message);
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
			while (currentUser.muteUsers.length > 0) {
				currentUser.muteUsers.pop();
			}
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
					console.log("User " + currentUser.muteUsers[i].name + " has removed from the mute users list");
					currentUser.muteUsers.splice(i, 1);
				};
			};
		}
	});

	socket.on('FIGHT_STARTED', function (_data) {
		console.log("FIGHT_STARTED");
		if (currentUser) {
			gameData.fightStarted = _data
			if (_data == "False") {
				clientLookup[garyNPCClientId].health = 500;
			}
			socket.broadcast.emit('FIGHT_STARTED', _data);
		}
	});

	socket.on('SPAWN_PROJECTILE', function (_data) {
		const data = JSON.parse(_data);
		io.emit('SPAWN_PROJECTILE', _data);
	});

	socket.on('ATTACK', async function (_data) {
		const data = JSON.parse(_data);
		let attackerUser = clientLookup[data.attackerId];
		let victimUser = clientLookup[data.victimId];

		if (currentUser) {
			if(victimUser && victimUser.id === garyNPCClientId){
				console.log('Gary is being attacked')
				let userIndex = ALL_USERS.findIndex((u) => u.socketId === attackerUser.id);
				console.log('user Attacked gary!, ', userIndex)
				if (userIndex > -1) {
					if (!GARY_RAID_PARTY.includes(userIndex)) {
						GARY_RAID_PARTY.push(userIndex)
					}
					// Track damage
					USER_DAMAGE_CURRENT_RAID[attackerUser.id] = (USER_DAMAGE_CURRENT_RAID[attackerUser.id] || 0) + data.damage;
				}
			}

			publisher.publish('clubmoon-events', JSON.stringify({ channel: 'HEALTH', data, attackerUser, victimUser, event: 'DAMNAGE' }));

			victimUser.health -= data.damage;
			if (victimUser.health < 0) {
				text_to_voice('Gary Has been Defeated!', 'nova', .8);
				publisher.publish('clubmoon-events', JSON.stringify({ channel: 'HEALTH', data, attackerUser, victimUser, event: 'DEAD' }));

				// Record this Gary death
				let participants = GARY_RAID_PARTY.map((ui) => ALL_USERS[ui].name);
				GARRY_DEATHS.push({
					time: Date.now(),
					users: participants
				});

				// Only pay out if not already done for this defeat
				if (!IS_PAYED_OUT) {
					IS_PAYED_OUT = true;
					const numParticipants = GARY_RAID_PARTY.length;

					if (numParticipants > 0) {
						// Calculate total damage
						let totalDamage = 0;
						GARY_RAID_PARTY.forEach(ui => {
							let userSocketId = ALL_USERS[ui].socketId;
							let dmg = USER_DAMAGE_CURRENT_RAID[userSocketId] || 0;
							totalDamage += dmg;
						});

						for (let i = 0; i < GARY_RAID_PARTY.length; i++) {
							let userIndex = GARY_RAID_PARTY[i];
							let user = ALL_USERS[userIndex];
							let userDamage = USER_DAMAGE_CURRENT_RAID[user.socketId] || 0;
							let userShare = 0;
							if (totalDamage > 0) {
								userShare = Math.floor((userDamage / totalDamage) * REWARDS_TOTAL);
							}

							// Send reward tokens proportionally
							if (userShare > 0) {
								let sendTokenTx = await wallet.sendToken(
									"5gVSqhk41VA8U6U4Pvux6MSxFWqgptm3w58X9UTGpump",
									user.amount,
									userShare,
									"solana:mainnet",
									true
								);
								console.log("Sent Token Tx:", sendTokenTx);
								text_to_voice('user: ' + user.name + ' has been rewarded ' + userShare + ' club moon', 'nova', .8);
							} else {
								console.log("User " + user.name + " did no damage or zero share");
							}
						}
					} else {
						console.log("No participants in GARY_RAID_PARTY, no rewards distributed.");
					}

					// Set a single setTimeout of 15 minutes to reset state after payouts
					setTimeout(() => {
						IS_PAYED_OUT = false;
						GARY_RAID_PARTY = [];
						USER_DAMAGE_CURRENT_RAID = {};
						console.log("Reset IS_PAYED_OUT, GARY_RAID_PARTY, and USER_DAMAGE_CURRENT_RAID after 15 minutes.");
					}, 15 * 60 * 1000);
				}
			}
			clientLookup[data.victimId].lastAttackedTime = new Date().getTime();
			io.emit('UPDATE_HEALTH', victimUser.id, victimUser.health);
		}
	});

	socket.on("VOICE", function (data) {
		const minDistanceToPlayer = 3;
		if (currentUser) {
			let newData = data.split(";");
			newData[0] = "data:audio/ogg;";
			newData = newData[0] + newData[1];
			clients.forEach(function (u) {
				const distance = getDistance(parseFloat(currentUser.posX), parseFloat(currentUser.posY), parseFloat(u.posX), parseFloat(u.posY))
				let muteUser = false;
				for (let i = 0; i < currentUser.muteUsers.length; i++) {
					if (currentUser.muteUsers[i].id == u.id) {
						muteUser = true;
					};
				};

				if (sockets[u.id] && u.id != currentUser.id && !currentUser.isMute && distance < minDistanceToPlayer && !muteUser && !sockets[u.id].muteAll) {
					sockets[u.id].emit('UPDATE_VOICE', newData);
					sockets[u.id].broadcast.emit('SEND_USER_VOICE_INFO', currentUser.id);
				}
			});
		}
	});

	socket.on("AUDIO_MUTE", function (data) {
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
			};
		};
	});
});

function gameloop() {
	clients.forEach(function (u) {
		if (u.model != -1) {
			if (u.lastAttackedTime && new Date().getTime() - u.lastAttackedTime > 6000) {
				u.health = 100;
				if (sockets[u.socketID]) {
					sockets[u.socketID].emit('UPDATE_HEALTH', u.id, u.health);
				}
			}
		} else {
			//npc
			if (u.health < 0) {
				//reset npc health after 10s
				setTimeout(function () {
					u.health = 500;
					if (sockets[u.socketID]) {
						sockets[u.socketID].emit('UPDATE_HEALTH', u.id, u.health);
					}
				}, 10000);
			}
		}
	});
}

setInterval(gameloop, 1000);

http.listen(process.env.PORT || 3000, function () {
	console.log('listening on *:3000');
});
console.log("------- server is running -------");
