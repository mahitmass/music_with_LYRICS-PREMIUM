import { pipeline, env } from '@xenova/transformers';

// Tell the AI to cache the model on the user's computer so it only downloads once
env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;

// Listen for messages from your main app
self.onmessage = async (event) => {
    const { audioData, sampleRate } = event.data;

    try {
        // 1. Load the model (Whisper Tiny is ~150MB, fast and very accurate)
        if (!transcriber) {
            self.postMessage({ status: 'loading', message: 'Loading AI Model (this happens once)...' });
            transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
        }

        self.postMessage({ status: 'processing', message: 'AI is listening to the track...' });

        // 2. Run the audio through the AI
        // return_timestamps: true is the magic that gives us the [01:23.45] timings!
        const output = await transcriber(audioData, {
            chunk_length_s: 30,
            stride_length_s: 5,
            return_timestamps: true,
        });

        // 3. Convert the AI's output into a standard .lrc file format
        let lrcText = "";
        if (output.chunks && output.chunks.length > 0) {
            output.chunks.forEach(chunk => {
                if (chunk.timestamp[0] !== null) {
                    const startSeconds = chunk.timestamp[0];
                    const m = Math.floor(startSeconds / 60).toString().padStart(2, '0');
                    const s = (startSeconds % 60).toFixed(2).padStart(5, '0');
                    const text = chunk.text.trim();
                    if (text) {
                        lrcText += `[${m}:${s}] ${text}\n`;
                    }
                }
            });
        }

        // 4. Send the finished .lrc text back to the app
        self.postMessage({ status: 'done', lrc: lrcText });

    } catch (error) {
        self.postMessage({ status: 'error', message: error.message });
    }
};