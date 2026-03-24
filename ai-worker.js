// Use the official CDN link for the Transformers library
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

// Set up the environment to cache the model locally after downloading
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;

self.onmessage = async (event) => {
    const { audioData } = event.data;

    try {
        if (!transcriber) {
            self.postMessage({ status: 'loading', message: 'Downloading AI Brain (First time only)...' });
            // Using the smallest, fastest English model
            transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
        }

        self.postMessage({ status: 'processing', message: 'AI is listening to the song...' });

        // Run the transcription
        const output = await transcriber(audioData, {
            chunk_length_s: 30,
            stride_length_s: 5,
            return_timestamps: true,
        });

        // Convert the AI output into .lrc format
        let lrcText = "";
        output.chunks.forEach(chunk => {
            const ms = chunk.timestamp[0];
            const m = Math.floor(ms / 60).toString().padStart(2, '0');
            const s = (ms % 60).toFixed(2).padStart(5, '0');
            lrcText += `[${m}:${s}] ${chunk.text.trim()}\n`;
        });

        self.postMessage({ status: 'done', lrc: lrcText });

    } catch (error) {
        self.postMessage({ status: 'error', message: error.message });
    }
};