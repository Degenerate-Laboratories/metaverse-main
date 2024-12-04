/*
*  Clubmoon
*
* 		@description:  The MetaVerse for Degens
*
*   	@version: 0.0.1
*
*/
require("dotenv").config()
const express = require('express');//import express NodeJS framework module
const app = express();// create an object of the express module
const http = require('http').Server(app);// create a http web server using the http library
const io = require('socket.io')(http);// import socketio communication module
const path = require('path');
const { getDistance } = require('./utils'); // Import setCustomCacheControl from utils.js

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if(!OPENAI_API_KEY) console.error('ENV NOT SET! missing: OPENAI_API_KEY')
if(!process.env.REDIS_CONNECTION) console.error('ENV NOT SET! missing: REDIS_CONNECTION')

const cors = require("cors");
const corsOptions = {
	origin: '*',
	credentials: true,            //access-control-allow-credentials:true
	optionSuccessStatus: 200
}

app.use(cors(corsOptions)) // Use this after the variable declaration

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
	//	maxAge: '5d',
	setHeaders: setCustomCacheControl
}))


let previousChats = [];
const clients = [];// to storage clients
const clientLookup = {};// clients search engine
const sockets = {};//// to storage sockets


//open a connection with the specific client
io.on('connection', function (socket) {
	console.log('A user ready for connection!');

	//to store current client connection
	let currentUser;
	const sended = false;
	const muteAll = false;

	//create a callback fuction to listening EmitPing() method in NetworkMannager.cs unity script
	socket.on('PING', function (_pack) {
		const pack = JSON.parse(_pack);
		console.log('message from user# ' + socket.id + ": " + pack.msg);
		//emit back to NetworkManager in Unity by client.js script
		socket.emit('PONG', socket.id, pack.msg);
	});

	//create a callback fuction to listening EmitJoin() method in NetworkMannager.cs unity script
	socket.on('JOIN', function (_data) {
		const data = JSON.parse(_data);
		// fills out with the information emitted by the player in the unity
		currentUser = {
			name: data.name,
			publicAddress: data.publicAddress,
			model: data.model,
			posX: data.posX,
			posY: data.posY,
			posZ: data.posZ,
			rotation: '0',
			id: socket.id,//alternatively we could use socket.id
			socketID: socket.id,//fills out with the id of the socket that was open
			muteUsers: [],
			muteAll: false,
			isMute: true,
			health: 100
		};//new user  in clients list
		console.log('[INFO] player ' + currentUser.name + ': logged!');
		//add currentUser in clients list
		clients.push(currentUser);

		//add client in search engine
		clientLookup[currentUser.id] = currentUser;
		sockets[currentUser.id] = socket;//add curent user socket
		console.log('[INFO] Total players: ' + clients.length);
		/*********************************************************************************************/

		//send to the client.js script
		socket.emit("JOIN_SUCCESS", currentUser.id, currentUser.name, currentUser.posX, currentUser.posY, currentUser.posZ, data.model);
		//send previous chats
		previousChats.forEach(function (i) {
			socket.emit('UPDATE_MESSAGE', i.id, i.message,i.name);
		});

		//spawn all connected clients for currentUser client
		clients.forEach(function (i) {
			if (i.id != currentUser.id) {
				//send to the client.js script
				socket.emit('SPAWN_PLAYER', i.id, i.name, i.posX, i.posY, i.posZ, i.model);
			}//END_IF
		});//end_forEach

		// spawn currentUser client on clients in broadcast
		socket.broadcast.emit('SPAWN_PLAYER', currentUser.id, currentUser.name, currentUser.posX, currentUser.posY, currentUser.posZ, data.model);
	});//END_SOCKET_ON

	//create a callback fuction to listening EmitMoveAndRotate() method in NetworkMannager.cs unity script
	socket.on('MOVE_AND_ROTATE', function (_data) {
		const data = JSON.parse(_data);

		if (currentUser) {
			currentUser.posX = data.posX;
			currentUser.posY = data.posY;
			currentUser.posZ = data.posZ;
			currentUser.rotation = data.rotation;
			// send current user position and  rotation in broadcast to all clients in game
			socket.broadcast.emit('UPDATE_MOVE_AND_ROTATE', currentUser.id, currentUser.posX, currentUser.posY, currentUser.posZ, currentUser.rotation);
		}
	});//END_SOCKET_ON


	//create a callback fuction to listening EmitAnimation() method in NetworkMannager.cs unity script
	socket.on('ANIMATION', function (_data) {
		const data = JSON.parse(_data);

		if (currentUser) {
			currentUser.timeOut = 0;
			//send to the client.js script
			//updates the animation of the player for the other game clients
			socket.broadcast.emit('UPDATE_PLAYER_ANIMATOR', currentUser.id, data.key, data.value, data.type);
		}//END_IF
	});//END_SOCKET_ON

	//create a callback fuction to listening EmitGetBestKillers() method in NetworkMannager.cs unity script
	socket.on('GET_USERS_LIST', function (pack) {

		if (currentUser) {
			//spawn all connected clients for currentUser client
			clients.forEach(function (i) {
				if (i.id != currentUser.id) {
					//send to the client.js script
					socket.emit('UPDATE_USER_LIST', i.id, i.name, i.publicAddress);
				}//END_IF
			});//end_forEach
		}
	});//END_SOCKET.ON

	//create a callback fuction to listening EmitMoveAndRotate() method in NetworkMannager.cs unity script
	socket.on('MESSAGE', function (_data) {
		const data = JSON.parse(_data);
		if (currentUser) {
			// send current user position and  rotation in broadcast to all clients in game
			socket.emit('UPDATE_MESSAGE', currentUser.id, data.message);
			// send current user position and  rotation in broadcast to all clients in game
			socket.broadcast.emit('UPDATE_MESSAGE', currentUser.id, data.message);

			//push to chat history
			previousChats.push({ id: currentUser.id, name: currentUser.name, message: data.message });
			//remove if more than 10
			if (previousChats.length > 10) {
				previousChats.shift();
			}
		}
	});//END_SOCKET_ON

	//create a callback fuction to listening EmitMoveAndRotate() method in NetworkMannager.cs unity script
	socket.on('PRIVATE_MESSAGE', function (_data) {
		const data = JSON.parse(_data);
		if (currentUser) {
			// send current user position and  rotation in broadcast to all clients in game
			socket.emit('UPDATE_PRIVATE_MESSAGE', data.chat_box_id, currentUser.id, data.message);
			sockets[data.guest_id].emit('UPDATE_PRIVATE_MESSAGE', data.chat_box_id, currentUser.id, data.message);
		}
	});//END_SOCKET_ON

	//create a callback fuction to listening EmitMoveAndRotate() method in NetworkMannager.cs unity script
	socket.on('SEND_OPEN_CHAT_BOX', function (_data) {
		const data = JSON.parse(_data);
		if (currentUser) {
			// send current user position and  rotation in broadcast to all clients in game
			socket.emit('RECEIVE_OPEN_CHAT_BOX', currentUser.id, data.player_id);

			//spawn all connected clients for currentUser client
			clients.forEach(function (i) {
				if (i.id == data.player_id) {
					console.log("send to : " + i.name);
					//send to the client.js script
					sockets[i.id].emit('RECEIVE_OPEN_CHAT_BOX', currentUser.id, i.id);
				}//END_IF
			});//end_forEach
		}
	});//END_SOCKET_ON

	socket.on('MUTE_ALL_USERS', function () {

		if (currentUser) {
			currentUser.muteAll = true;
			clients.forEach(function (u) {
				currentUser.muteUsers.push(clientLookup[u.id]);
			});
		}
	});//END_SOCKET_ON


	socket.on('REMOVE_MUTE_ALL_USERS', function () {
		if (currentUser) {
			currentUser.muteAll = false;
			while (currentUser.muteUsers.length > 0) {
				currentUser.muteUsers.pop();
			}
		}
	});//END_SOCKET_ON

	socket.on('ADD_MUTE_USER', function (_data) {
		const data = JSON.parse(_data);
		if (currentUser) {
			//console.log("data.id: "+data.id);
			console.log("add mute user: " + clientLookup[data.id].name);
			currentUser.muteUsers.push(clientLookup[data.id]);
		}
	});//END_SOCKET_ON

	socket.on('REMOVE_MUTE_USER', function (_data) {
		const data = JSON.parse(_data);
		if (currentUser) {
			for (const i = 0; i < currentUser.muteUsers.length; i++) {
				if (currentUser.muteUsers[i].id == data.id) {
					console.log("User " + currentUser.muteUsers[i].name + " has removed from the mute users list");
					currentUser.muteUsers.splice(i, 1);
				};
			};
		}
	});//END_SOCKET_ON

	//attack
	socket.on('ATTACK', function (_data) {
		//if player distance is less than 2 meters
		const minDistanceToPlayer = 2;
		const data = JSON.parse(_data);
		let attackerUser = clientLookup[data.attackerId];
		let victimUser = clientLookup[data.victimId];
		if (currentUser) {
			const distance = getDistance(parseFloat(attackerUser.posX), parseFloat(attackerUser.posY), parseFloat(victimUser.posX), parseFloat(victimUser.posY))

			if (distance < minDistanceToPlayer) {
				if (victimUser.health <= 0) {
					//reset to 100 health after 2s
					setTimeout(function () {
						victimUser.health = 100;
					}, 2000);
					return;
				} else {
					//REDUCE VICTIM HEALTH
					victimUser.health -= data.damage;
					//send to the client.js script
					//socket.emit('UPDATE_HEALTH', victimUser.id, victimUser.health);
					//send to all
					io.emit('UPDATE_HEALTH', victimUser.id, victimUser.health);
				}
			}
		}
	});//END_SOCKET_ON

	socket.on("VOICE", function (data) {
		const minDistanceToPlayer = 3;
		if (currentUser) {
			let newData = data.split(";");
			newData[0] = "data:audio/ogg;";
			newData = newData[0] + newData[1];
			clients.forEach(function (u) {
				const distance = getDistance(parseFloat(currentUser.posX), parseFloat(currentUser.posY), parseFloat(u.posX), parseFloat(u.posY))
				let muteUser = false;
				for (const i = 0; i < currentUser.muteUsers.length; i++) {
					if (currentUser.muteUsers[i].id == u.id) {
						muteUser = true;
					};
				};

				if (sockets[u.id] && u.id != currentUser.id && !currentUser.isMute && distance < minDistanceToPlayer && !muteUser && !sockets[u.id].muteAll) {
					//sockets[u.id].emit('UPDATE_VOICE',currentUser.id,newData);
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


	// called when the user desconnect
	socket.on('disconnect', function () {

		if (currentUser) {
			currentUser.isDead = true;
			//send to the client.js script
			//updates the currentUser disconnection for all players in game
			socket.broadcast.emit('USER_DISCONNECTED', currentUser.id);

			for (const i = 0; i < clients.length; i++) {
				if (clients[i].name == currentUser.name && clients[i].id == currentUser.id) {

					console.log("User " + clients[i].name + " has disconnected");
					clients.splice(i, 1);

				};
			};
		}
	});//END_SOCKET_ON
});//END_IO.ON


http.listen(process.env.PORT || 3000, function () {
	console.log('listening on *:3000');
});
console.log("------- server is running -------");
