require("dotenv").config();
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Initialize globals for speech queue
global.SPEECH_QUEUE = global.SPEECH_QUEUE || [];
global.IS_SPEAKING = global.IS_SPEAKING || false;

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

// Helper function to calculate speaking time
function calculateSpeakingTime(text) {
    const words = text.trim().split(/\s+/).length;
    const wordsPerSecond = 2.5; // Average speaking rate
    const basePause = 500; // Base pause in milliseconds
    return Math.max(1000, (words / wordsPerSecond) * 1000 + basePause);
}

// Helper function for the speech queue
async function processSpeechQueue() {
    if (global.IS_SPEAKING || global.SPEECH_QUEUE.length === 0) return;
    
    global.IS_SPEAKING = true;
    
    while (global.SPEECH_QUEUE.length > 0) {
        const { text, voice, speed, io } = global.SPEECH_QUEUE[0];
        
        console.log("Speaking:", text);
        let audioDataURI = await text_to_voice(text, voice, speed);
        if (audioDataURI && io) {
            io.emit('UPDATE_VOICE', audioDataURI);
        }
        
        // Wait for the calculated speaking time
        const speakingTime = calculateSpeakingTime(text) / speed;
        await new Promise((resolve) => setTimeout(resolve, speakingTime));
        
        // Remove the processed speech from queue
        global.SPEECH_QUEUE.shift();
    }
    
    global.IS_SPEAKING = false;
}

// Main speak function
async function speakLine(text, voice = "nova", speed = 0.8, io = null) {
    // Add to queue
    global.SPEECH_QUEUE.push({ text, voice, speed, io });
    
    // Try to process queue (will only start if not already speaking)
    processSpeechQueue();
    
    // Return a promise that resolves when this specific line has been spoken
    return new Promise((resolve) => {
        const checkQueue = setInterval(() => {
            const isThisLineSpoken = !global.SPEECH_QUEUE.some(item => item.text === text);
            if (isThisLineSpoken) {
                clearInterval(checkQueue);
                resolve();
            }
        }, 100);
    });
}

module.exports = {
    text_to_voice,
    speakLine,
    get SPEECH_QUEUE() { return global.SPEECH_QUEUE; },
    get IS_SPEAKING() { return global.IS_SPEAKING; }
}; 