require("dotenv").config();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if(!OPENAI_API_KEY) console.error('ENV NOT SET! missing: OPENAI_API_KEY');
if(!process.env.REDIS_CONNECTION) console.error('ENV NOT SET! missing: REDIS_CONNECTION');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// At the top, initialize globals
global.GARY_RAID_PARTY = [];
global.IS_PAYED_OUT = false;
global.REWARDS_TOTAL = 100000;
global.IS_GARY_ALIVE = true;
global.GARRY_DEATHS = [];
global.USER_DAMAGE_CURRENT_RAID = {};

// Import voice utilities
const { speakLine } = require('./voiceUtils');
const {publisher} = require("@pioneer-platform/default-redis");

/**
 * Main function for handling an attack event.
 * Subtracts victim's health, sets lastAttackedTime, etc.
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
    
    // If Gary is the victim
    if (victimUser.id && victimUser.model === '-1') {
        // Find attacker in ALL_USERS and add to raid party
        let userIndex = global.ALL_USERS.findIndex((u) => u.socketId === attackerUser.id);
        if (userIndex > -1) {

            // Add user to GARY_RAID_PARTY if not already in there
            if (!global.GARY_RAID_PARTY.includes(userIndex)) {
                global.GARY_RAID_PARTY.push(userIndex);
            }

            // Track damage
            global.USER_DAMAGE_CURRENT_RAID[attackerUser.id] = 
                (global.USER_DAMAGE_CURRENT_RAID[attackerUser.id] || 0) + Number(data.damage);
        }

        publisher.publish('clubmoon-raid', 'attackerUser: '+JSON.stringify(attackerUser) + '  your health' + victimUser.health + ' ');

        if(victimUser.health <= 0){
            await handleGaryDeath(attackerUser, io, socket, publisher);
        }
    }
}

/**
 * Called when Gary's health hits 0 or below.
 */
async function handleGaryDeath(attackerUser, io, socket, publisher) {
    console.log("Gary is DEAD!");
    socket.broadcast.emit('FIGHT_STARTED', "false");

    // Mark Gary as dead
    global.IS_GARY_ALIVE = false;

    // YOUR code for the fightStarted global
    if (global.gameData) global.gameData.fightStarted = "false";

    // Payout logic
    if (!global.IS_PAYED_OUT) {
        global.IS_PAYED_OUT = true;
        // Record Gary's death
        let participants = global.GARY_RAID_PARTY.map(ui => global.ALL_USERS[ui].name);
        global.GARRY_DEATHS.push({ time: Date.now(), users: participants });

        // Announce
        await speakLine("Gary Has been killed!", "nova", 0.8, io);
        await speakLine(`numParticipants ${participants.length}`, "nova", 0.8, io);

        // Distribute tokens
        if (participants.length > 0) {
            await distributeGaryRewards(io);
        }
        resetRaidState();
    } else {
        console.log('already paid out!')
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
    for (let i = 0; i < global.GARY_RAID_PARTY.length; i++) {
        let ui = global.GARY_RAID_PARTY[i];
        let userSocketId = global.ALL_USERS[ui].socketId;
        let dmg = Number(global.USER_DAMAGE_CURRENT_RAID[userSocketId] || 0);
        damageMap[userSocketId] = dmg;
        totalDamage += dmg;
        if (dmg > mvp.damage) {
            mvp = { name: global.ALL_USERS[ui].name, damage: dmg };
        }
    }

    let announcement = 'The Gary Raid has been completed! Exelent work! ... '
    // 2) Announce damage done by each participant
    for (let i = 0; i < global.GARY_RAID_PARTY.length; i++) {
        let ui = global.GARY_RAID_PARTY[i];
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
    for (let i = 0; i < global.GARY_RAID_PARTY.length; i++) {
        let ui = global.GARY_RAID_PARTY[i];
        let user = global.ALL_USERS[ui];
        let userDamage = damageMap[user.socketId] || 0;
        let userShare = 0;
        if (totalDamage > 0) {
            userShare = Math.floor((userDamage / totalDamage) * global.REWARDS_TOTAL);
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
            for (let attempts = 0; attempts < 6 && !success; attempts++) {
                try {
                    await speakLine(`Sending ${userShare} Club Moon tokens to ${user.name}`, "nova", 0.8, io);
                    let sendTokenTx 
                    if(attempts > 0){
                        sendTokenTx = await global.wallet.sendToken(
                            "5gVSqhk41VA8U6U4Pvux6MSxFWqgptm3w58X9UTGpump",
                            user.amount,
                            userShare,
                            "solana:mainnet",
                            15000000,
                            "https://rpc.magicblock.app/mainnet"
                        );
                    }else{
                            sendTokenTx = await global.wallet.sendToken(
                            "5gVSqhk41VA8U6U4Pvux6MSxFWqgptm3w58X9UTGpump",
                            user.amount,
                            userShare,
                            "solana:mainnet",
                            5000000
                        );
                    }
                    
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
        global.IS_PAYED_OUT = false;
        global.IS_GARY_ALIVE = true;
        global.GARY_RAID_PARTY = [];
        global.USER_DAMAGE_CURRENT_RAID = {};
        console.log("Reset IS_PAYED_OUT, GARY_RAID_PARTY, and USER_DAMAGE_CURRENT_RAID after 15 minutes.");
    }, 60 * 1000);
}

module.exports = {
    get GARY_RAID_PARTY() { return global.GARY_RAID_PARTY; },
    get IS_PAYED_OUT() { return global.IS_PAYED_OUT; },
    get REWARDS_TOTAL() { return global.REWARDS_TOTAL; },
    get IS_GARY_ALIVE() { return global.IS_GARY_ALIVE; },
    get GARRY_DEATHS() { return global.GARRY_DEATHS; },
    get USER_DAMAGE_CURRENT_RAID() { return global.USER_DAMAGE_CURRENT_RAID; },
    handleAttack,
    handleGaryDeath,
    distributeGaryRewards,
    resetRaidState
};
