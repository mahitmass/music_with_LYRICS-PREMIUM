import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;

self.onmessage = async (event) => {
    const { audioData, songPath } = event.data;

    try {
        if (!transcriber) {
            transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
        }

        const output = await transcriber(audioData, {
            chunk_length_s: 30,
            stride_length_s: 5,
            return_timestamps: true,
        });

        let lrcText = "";
        output.chunks.forEach(chunk => {
            const ms = chunk.timestamp[0];
            const m = Math.floor(ms / 60).toString().padStart(2, '0');
            const s = (ms % 60).toFixed(2).padStart(5, '0');
            lrcText += `[${m}:${s}] ${chunk.text.trim()}\n`;
        });

        self.postMessage({ status: 'done', lrc: lrcText, songPath: songPath });

    } catch (error) {
        self.postMessage({ status: 'error', message: error.message, songPath: songPath });
    }
};