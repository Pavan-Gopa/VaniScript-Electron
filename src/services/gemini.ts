import { GoogleGenAI } from "@google/genai";
import { TranscriptionConfig } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_INSTRUCTION = `
You are an Interactive Audio Processing & Transcription Engine. Your primary function is to ingest audio files, transcribe them with extreme verbatim accuracy, translate them if requested, and output the result in specific professional formats (SRT, VTT, TXT, or Markdown).

OPTIMIZATION: You are optimized for spiritual/philosophical lectures (specifically the Gaudiya Vaishnava tradition).

CORE TRANSCRIPTION RULES:

1. ABSOLUTE VERBATIM & FIRST-PERSON DIRECT SPEECH (CRITICAL)
- DICTAPHONE MODE: You are a pure dictaphone. Transcribe and translate the EXACT words spoken by the speaker in the FIRST PERSON as direct speech.
- ZERO SUMMARIZATION: It is strictly PROHIBITED to summarize, condense, or interpret.
- NO REPORTED SPEECH: Never use third-person descriptive phrasing. NEVER write "He states", "He recalls", etc.
- EVERY WORD MATTERS: Output ONLY the exact sentences spoken.

2. UNRECOGNIZED FRAGMENTS
- NEVER skip difficult words. Use curly brackets ONLY as a last resort: {unrecognized word}, {unrecognized phrase}.

3. SPEAKER IDENTIFICATION
- Track and label all speakers accurately using brackets: [Speaker Name].

4. TERMINOLOGY & SANSKRIT HANDLING
- Retain all technical or Sanskrit terms in original transliteration (e.g., Krishna, Bhakti, Shastra).
- If translating, keep philosophical depth intact and use native alphabet equivalents if applicable.
- Context: Gaudiya Vaishnava philosophy, scriptures like Bhagavad-gita, names of acharyas.

5. TIMESTAMPS (For TXT format)
- Format: [MM:SS] [Speaker Name] Text...
- Place every time the speaker changes or start of new logical paragraph (approx 1-2 mins).

6. QUALITY ASSURANCE
- Ensure 100% direct speech.
- Ensure all speakers identified.
- Ensure the transcription reaches the absolute final spoken word.

7. TAIL-CHECK PROTOCOL (ANTI-TRUNCATION)
- ISOALTE AND VERIFY THE LAST 3 MINUTES. Ensure the transcription reaches the absolute final spoken word before concluding.
`;

export async function transcribeAudio(
  audioData: string, // base64
  mimeType: string,
  config: TranscriptionConfig,
  onProgress?: (message: string) => void
) {
  const modelName = "gemini-3-flash-preview";
  
  const isTranslation = config.targetLanguage && config.targetLanguage !== 'same';
  const requestedFormats = config.formats.join(', ');

  const prompt = `
    TASK: 
    1. Transcribe the audio in its original language.
    ${isTranslation ? `2. Translate the transcript to ${config.targetLanguage}.` : ''}
    
    SPEAKER IDENTIFICATION HINT: Based on the filename, the primary speaker might be: "${config.speakerHint || 'Unknown'}". Use this name for the primary speaker if applicable.
    
    ${config.metadata ? `
    DOCUMENT METADATA TO INCLUDE AT THE TOP OF TXT AND MARKDOWN FORMATS:
    Date: ${config.metadata.date || 'Неизвестно'}
    Location: ${config.metadata.location || 'Неизвестно'}
    Lecturer: ${config.metadata.lecturer || 'Неизвестно'}
    Interviewer / Participants: ${config.metadata.translator || 'Нет'}
    (Please output these clearly at the start of your TXT and Markdown blocks)
    ` : ''}

    REQUESTED FORMATS: ${requestedFormats}
    
    CRITICAL: YOU MUST WRAP EACH SECTION IN CLEAR TAGS.
    Example:
    [ORIGINAL_TXT]
    (content here)
    [/ORIGINAL_TXT]

    [TRANSLATED_TXT]
    (content here)
    [/TRANSLATED_TXT]

    Do this for ALL formats requested: ${requestedFormats}.
    Use tags like [ORIGINAL_SRT], [ORIGINAL_MARKDOWN], [TRANSLATED_SRT], etc.

    REMAINING REQUIREMENTS:
    - SPEAKER TAGS: If there is ONLY ONE speaker in the entire audio, DO NOT output their name before every paragraph/sentence. Only use speaker tags if there are MULTIPLE speakers (e.g. an interview or audience questions).
    - For SRT/VTT: Industry-standard timestamp formatting (HH:MM:SS,ms).
    - For TXT: [MM:SS] timestamps at speaker changes.
    - For Markdown: Readable article structure with headings.
    - SANSKRIT/TECHNICAL TERMS: DO NOT add bracketed English transliterations (e.g., "Кришна (Krsna)") for standard vocabulary within the output text. Use natural terms directly.
    - DIACRITICS: Strict diacritical transliteration (IAST) must be disabled for normal conversational terms, and RESERVED EXCLUSIVELY for full scriptural quotes/verses (shlokas).
    - At the absolute end, provide: "UNRECOGNIZED FRAGMENTS LIST" with a list of all {unrecognized} fragments.
    - Apply TAIL-CHECK PROTOCOL: Do not stop early. Ensure the transcription reaches the absolute final spoken word.
  `;

  try {
    onProgress?.("Uploading audio and initializing Gemini AI...");
    const responseStream = await ai.models.generateContentStream({
      model: modelName,
      contents: {
        parts: [
          {
            inlineData: {
              data: audioData,
              mimeType: mimeType,
            },
          },
          { text: prompt },
        ],
      },
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.1,
      },
    });

    let fullText = "";
    let startedReceiving = false;
    let didTranslation = false;
    
    for await (const chunk of responseStream) {
      if (!startedReceiving) {
        startedReceiving = true;
        onProgress?.("Transcribing source material verbatim...");
      }
      
      const text = chunk.text;
      if (text) {
        fullText += text;
        
        if (isTranslation && !didTranslation && fullText.includes("[TRANSLATED_")) {
          didTranslation = true;
          onProgress?.("Translating content to target language... (preserving meaning)");
        }
        
        if (fullText.includes("UNRECOGNIZED FRAGMENTS LIST")) {
          onProgress?.("Checking accuracy and applying tail-check protocol...");
        }
      }
    }
    
    onProgress?.("Finalizing transcript & formatting output...");
    return fullText;
  } catch (error) {
    console.error("Transcription error:", error);
    throw error;
  }
}

export async function reprocessFragment(
  audioData: string,
  mimeType: string,
  oldText: string,
  mode: 'original' | 'translated',
  config: TranscriptionConfig
) {
  const modelName = "gemini-3-flash-preview";
  
  const prompt = `
    TASK: I have a specific highlighted segment of text from this audio that needs to be corrected by re-evaluating the audio.
    Mode: ${mode === 'original' ? 'Transcription (Original Language)' : 'Translation to ' + config.targetLanguage}
    Speaker Hint from filename: "${config.speakerHint || 'Unknown'}"
    
    HIGHLIGHTED SEGMENT WITH POTENTIAL ERROR:
    "${oldText}"
    
    Analyze the audio closely to find where this was spoken.
    Provide the CORRECTED, highly-accurate version of just this segment.
    If the text is a translation, ensure it perfectly reflects the exact spoken words adapted to ${config.targetLanguage}.
    For Sanskrit and technical terms, you MUST use standard academic IAST diacritical marks.
    
    Output ONLY consequence-free corrected text. Do NOT include any markdown, quote marks, explanations, or notes. Output exactly the replacement string.
  `;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: modelName,
      contents: {
        parts: [
          { inlineData: { data: audioData, mimeType: mimeType } },
          { text: prompt },
        ],
      },
      config: {
        temperature: 0.1,
      },
    });

    return response.text.trim();
  } catch (error) {
    console.error("Reprocess error:", error);
    throw error;
  }
}
