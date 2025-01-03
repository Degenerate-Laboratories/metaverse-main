require("dotenv").config();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if(!OPENAI_API_KEY) console.error('ENV NOT SET! missing: OPENAI_API_KEY');
if(!process.env.REDIS_CONNECTION) console.error('ENV NOT SET! missing: REDIS_CONNECTION');
const OpenAI = require('openai');
const { stringify } = require("uuid");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Gary-related global variables
let GARY_RAID_PARTY = [];
let IS_PAYED_OUT = false;
let REWARDS_TOTAL = 30000;
let IS_GARY_ALIVE = true;
let GARRY_DEATHS = [];
let USER_DAMAGE_CURRENT_RAID = {};

// Utility for text-to-speech
async function text_to_voice(text, voice, speed) {
    try {
        if (!voice) voice = 'echo';
        if (!speed) speed = 1.0;
        const response = await openai.audio.speech.create({
            input: text,
            voice,
            speed,
            model: 'tts-1',
        });
        const chunks = [];
        for await (const chunk of response.body) {
            chunks.push(chunk);
        }
        const audioBuffer = Buffer.concat(chunks);
        const base64Audio = audioBuffer.toString('base64');
        const audioDataURI = `data:audio/mp3;base64,${base64Audio}`;
        return audioDataURI;
    } catch (e) {
        console.error("text_to_voice error:", e);
        return null;
    }
}

async function speakLine(text, voice = "nova", speed = 0.8, io = null) {
    console.log("speakLine:", text);
    let audioDataURI = await text_to_voice(text, voice, speed);
    if (audioDataURI && io) {
        io.emit('UPDATE_VOICE', audioDataURI);
    }
    // small pause in between lines
    await new Promise((resolve) => setTimeout(resolve, 1000));
}

/**
 * Main function for handling an attack event.
 * Subtracts victim’s health, sets lastAttackedTime, etc.
 */
async function handleAttack(data, attackerUser, victimUser, io, socket, publisher) {
    publisher.publish("clubmoon-events", JSON.stringify({
        channel: "HEALTH",
        data,
        attackerUser,
        victimUser,
        event: "DAMNAGE"
    }));

    victimUser.health -= Number(data.damage);

    if (victimUser.health <= 0) {
        console.log("DEAD EVENT || " + victimUser.name + " has died");
        publisher.publish("clubmoon-events", JSON.stringify({
            channel: "HEALTH",
            data,
            attackerUser,
            victimUser,
            event: "DEAD"
        }));
    }

    victimUser.lastAttackedTime = Date.now();
    io.emit("UPDATE_HEALTH", victimUser.id, victimUser.health);

    //If Gary is the victim
    console.log("victimUser.id: ",victimUser)
    console.log("global.garyNPCClient: ",global.garyNPCClientI)
    console.log("victimUser.health: ",victimUser.health)
    if (victimUser.id && victimUser.model === "-1" && victimUser.health <= 0) {
        console.log("Gary is the victim")
        await handleGaryDeath(attackerUser, io, socket, publisher);
    }else{
        console.log("Gary is not the victim")
    }   
}

/**
 * Called when Gary’s health hits 0 or below.
 */
async function handleGaryDeath(attackerUser, io, socket, publisher) {
    console.log("Gary is DEAD!");
    socket.broadcast.emit('FIGHT_STARTED', "false");

    // Mark Gary as dead
    IS_GARY_ALIVE = false;

    // YOUR code for the fightStarted global
    if (global.gameData) global.gameData.fightStarted = "false";

    // Payout logic
    if (!IS_PAYED_OUT) {
        IS_PAYED_OUT = true;
        // Record Gary’s death
        let participants = GARY_RAID_PARTY.map(ui => global.ALL_USERS[ui].name);
        GARRY_DEATHS.push({ time: Date.now(), users: participants });

        // Announce
        await speakLine("Gary Has been killed!", "nova", 0.8, io);
        await speakLine(`numParticipants ${participants.length}`, "nova", 0.8, io);

        // Distribute tokens
        if (participants.length > 0) {
            await distributeGaryRewards(io);
        }
        resetRaidState();
    }
}

/**
 * Distributes tokens to players based on their damage share
 */
async function distributeGaryRewards(io) {
    let totalDamage = 0;
    let damageMap = {};
    let mvp = { name: "", damage: 0 };

    // 1) Calculate total damage and MVP
    for (let i = 0; i < GARY_RAID_PARTY.length; i++) {
        let ui = GARY_RAID_PARTY[i];
        let userSocketId = global.ALL_USERS[ui].socketId;
        let dmg = Number(USER_DAMAGE_CURRENT_RAID[userSocketId] || 0);
        damageMap[userSocketId] = dmg;
        totalDamage += dmg;
        if (dmg > mvp.damage) {
            mvp = { name: global.ALL_USERS[ui].name, damage: dmg };
        }
    }

    let announcement = 'The Gary Raid has been completed! Exelent work! ... '
    // 2) Announce damage done by each participant
    for (let i = 0; i < GARY_RAID_PARTY.length; i++) {
        let ui = GARY_RAID_PARTY[i];
        let user = global.ALL_USERS[ui];
        let userDamage = damageMap[user.socketId] || 0;
        announcement += `User ${user.name} did ${userDamage} damage to Gary. `
    }

    // 3) Announce MVP
    if (mvp.name && mvp.damage > 0) {
        announcement += `The MVP is ${mvp.name} with ${mvp.damage} damage!`
    }
    await speakLine(announcement, "nova", 0.8, io);

    // === [New: 4) Create and store distribution data without sending yet] ===
    let distribution = [];
    for (let i = 0; i < GARY_RAID_PARTY.length; i++) {
        let ui = GARY_RAID_PARTY[i];
        let user = global.ALL_USERS[ui];
        let userDamage = damageMap[user.socketId] || 0;
        let userShare = 0;
        if (totalDamage > 0) {
            userShare = Math.floor((userDamage / totalDamage) * REWARDS_TOTAL);
        }
        distribution.push({ user, userDamage, userShare });
    }

    // === [New: 5) Speak all the reward shares before sending] ===
    let distributionAnnouncement = "We have determined the following distribution of tokens: ";
    for (let i = 0; i < distribution.length; i++) {
        const { user, userShare } = distribution[i];
        distributionAnnouncement += `User ${user.name} will receive ${userShare} tokens. `;
    }
    await speakLine(distributionAnnouncement, "nova", 0.8, io);

    // === [New: 6) Now perform the actual token sends] ===
    let results = [];
    for (let i = 0; i < distribution.length; i++) {
        let { user, userDamage, userShare } = distribution[i];
        // Only send if non-zero share and user has a recorded address
        if (userShare > 0 && user.amount && global.wallet) {
            let success = false;
            for (let attempts = 0; attempts < 2 && !success; attempts++) {
                try {
                    await speakLine(`Sending ${userShare} Club Moon tokens to ${user.name}`, "nova", 0.8, io);
                    let sendTokenTx = await global.wallet.sendToken(
                        "5gVSqhk41VA8U6U4Pvux6MSxFWqgptm3w58X9UTGpump",
                        user.amount,
                        userShare,
                        "solana:mainnet",
                        5000000,
                        "https://rpc.magicblock.app/mainnet"
                    );
                    await speakLine(`Send Confirmed!`, "nova", 0.8, io);
                    global.broadcastEventMessage(`Payment sent to ${user.name} for ${userShare} tokens. TXID: ${sendTokenTx}`);
                    results.push({
                        success: true,
                        userName: user.name,
                        userDamage,
                        userShare,
                        sendTokenTx
                    });
                    success = true;
                } catch (error) {
                    console.error("Error sending tokens:", error);
                    if (attempts >= 1) {
                        results.push({ success: false, userName: user.name, userDamage, userShare, error });
                    } else {
                        // wait before retry
                        await new Promise((resolve) => setTimeout(resolve, 2000));
                    }
                }
            }
        }

        // Wait a bit between participants
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Optionally speak about final outcomes
    // ...
}

/**
 * Resets the raid variables after a delay
 */
function resetRaidState() {
    setTimeout(() => {
        IS_PAYED_OUT = false;
        IS_GARY_ALIVE = true;   // if you want Gary to be alive again after the cooldown
        GARY_RAID_PARTY = [];
        USER_DAMAGE_CURRENT_RAID = {};
        console.log("Reset IS_PAYED_OUT, GARY_RAID_PARTY, and USER_DAMAGE_CURRENT_RAID after 15 minutes.");
    }, 60 * 1000);
}

module.exports = {
    GARY_RAID_PARTY,
    IS_PAYED_OUT,
    REWARDS_TOTAL,
    IS_GARY_ALIVE,
    GARRY_DEATHS,
    USER_DAMAGE_CURRENT_RAID,
    text_to_voice,
    speakLine,
    handleAttack,
    handleGaryDeath,
    distributeGaryRewards,
    resetRaidState
};