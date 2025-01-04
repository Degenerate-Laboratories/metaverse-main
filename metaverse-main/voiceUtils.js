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

function sanitizeText(text) {
    return text
        .replace(/[^\w\s.,!?-]/g, '') 
        .replace(/—/g, '-')           
        .replace(/'/g, "'")           
        .replace(/"/g, '"')           
        .trim();
}

// Main speak function
async function speakLine(text, voice = "nova", speed = 0.8, io = null) {
    try {
        const sanitizedText = sanitizeText(text);
        console.log("Speaking:", sanitizedText);
        
        // Add to queue
        global.SPEECH_QUEUE.push({ text: sanitizedText, voice, speed, io });
        
        // Try to process queue
        processSpeechQueue();
        
        // Return a promise that resolves when this specific line has been spoken
        return new Promise((resolve) => {
            const checkQueue = setInterval(() => {
                const isThisLineSpoken = !global.SPEECH_QUEUE.some(item => 
                    item.text === sanitizedText);
                if (isThisLineSpoken) {
                    clearInterval(checkQueue);
                    resolve();
                }
            }, 100);
        });
    } catch (error) {
        console.error("Error in speakLine:", error);
        return Promise.resolve();
    }
}

// Helper function for the speech queue
async function processSpeechQueue() {
    if (global.IS_SPEAKING || global.SPEECH_QUEUE.length === 0) return;
    
    global.IS_SPEAKING = true;
    
    while (global.SPEECH_QUEUE.length > 0) {
        const { text, voice, speed, io } = global.SPEECH_QUEUE[0];
        
        console.log("Processing speech:", text);
        let audioDataURI = await text_to_voice(text, voice, speed);
        
        if (audioDataURI) {
            // Add debug logging
            console.log("Generated audio data URI, length:", audioDataURI.length);
            
            if (io) {
                console.log("Emitting UPDATE_VOICE event");
                io.emit('UPDATE_VOICE', audioDataURI);
            } else {
                console.warn("No io object available for emission");
            }
            
            // Wait for the calculated speaking time
            const speakingTime = calculateSpeakingTime(text) / speed;
            await new Promise((resolve) => setTimeout(resolve, speakingTime));
        } else {
            console.error("Failed to generate audio for text:", text);
        }
        
        // Remove the processed speech from queue
        global.SPEECH_QUEUE.shift();
    }
    
    global.IS_SPEAKING = false;
}

module.exports = {
    text_to_voice,
    speakLine,
    get SPEECH_QUEUE() { return global.SPEECH_QUEUE; },
    get IS_SPEAKING() { return global.IS_SPEAKING; }
}; 