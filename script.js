// Initialize global state
const state = {
    chatHistory: [],
    isTyping: false
};

// Global variables provided by the Canvas environment (replace these with actual values if not using Canvas)
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

let db, auth, userId;

// *** NEW: Conversation History Array ***
// This array will store messages in the format required by the Gemini API:
// [{ role: "user", parts: [{ text: "..." }] }, { role: "model", parts: [{ text: "..." }] }]
let chatHistory = [];

async function initializeFirebase() {
    try {
        if (Object.keys(firebaseConfig).length > 0) {
            const app = initializeApp(firebaseConfig);
            db = getFirestore(app);
            auth = getAuth(app);

            if (initialAuthToken) {
                await signInWithCustomToken(auth, initialAuthToken);
            } else {
                await signInAnonymously(auth);
            }

            userId = auth.currentUser?.uid || crypto.randomUUID();
            console.log("Firebase initialized. User ID:", userId);
        } else {
            console.error("Firebase config is missing. Running without persistence.");
        }
    } catch (error) {
        console.error("Error during Firebase initialization or sign-in:", error);
        userId = crypto.randomUUID();
    }
}

// Ensure elements are available before running the chat logic
window.addEventListener('DOMContentLoaded', () => {
    initializeFirebase();
    
    // --- Chat Logic and Gemini API ---
    const chatLog = document.getElementById('chat-log');
    const chatForm = document.getElementById('chat-form');
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const languageSelect = document.getElementById('language-select');
    const initialMessage = document.getElementById('initial-message');

    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent`;
    const API_KEY = process.env.GEMINI_API_KEY;

    let isTyping = false; // Flag to prevent multiple concurrent requests

    // --- Utility Functions ---

    function scrollToBottom() {
        chatLog.scrollTop = chatLog.scrollHeight;
    }

    function addMessage(text, sender, targetElement = null) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `flex ${sender === 'user' ? 'justify-end' : 'justify-start'} mb-4`;

        const bubble = document.createElement('div');
        bubble.className = `${sender === 'user' ? 'user-message' : 'bot-message'} p-3 shadow-md text-sm whitespace-pre-wrap`;

        if (targetElement) {
            messageDiv.appendChild(bubble);
            targetElement.appendChild(messageDiv);
            return bubble;
        } else {
            bubble.innerText = text;
            messageDiv.appendChild(bubble);
            chatLog.appendChild(messageDiv);
            scrollToBottom();
        }
    }

    function typeMessage(element, text, sources, userPrompt) {
        let i = 0;
        element.innerText = '';
        isTyping = true;
        sendButton.disabled = true;
        userInput.disabled = true;

        const typingInterval = setInterval(() => {
            if (i < text.length) {
                element.innerText += text.charAt(i);
                i++;
                if (i % 5 === 0) scrollToBottom();
            } else {
                clearInterval(typingInterval);
                isTyping = false;
                sendButton.disabled = false;
                userInput.disabled = false;

                if (sources && sources.length > 0) {
                    appendSources(element.parentElement.parentElement, sources);
                }

                // *** MEMORY STEP 3: Add both user and model message to history ***
                chatHistory.push({ role: "user", parts: [{ text: userPrompt }] });
                chatHistory.push({ role: "model", parts: [{ text: text }] });

                scrollToBottom();
            }
        }, 25);
    }

    function appendSources(messageDiv, sources) {
        const sourcesDiv = document.createElement('div');
        sourcesDiv.className = 'mt-2 pt-2 border-t border-gray-300 text-xs text-gray-500';
        let sourceHtml = '<strong>Sources:</strong><ul>';
        const uniqueSources = {};
        
        sources.forEach(source => {
            if (source.uri && !uniqueSources[source.uri]) {
                uniqueSources[source.uri] = source.title;
                sourceHtml += `<li><a href="${source.uri}" target="_blank" class="text-blue-600 hover:text-blue-800">${source.title || 'Source Link'}</a></li>`;
            }
        });

        sourceHtml += '</ul>';
        sourcesDiv.innerHTML = sourceHtml;
        messageDiv.querySelector('.bot-message').appendChild(sourcesDiv);
        scrollToBottom();
    }

    // --- Core Gemini API Call ---

    async function generateResponse(prompt, language) {
        // *** MEMORY STEP 1: Combine History and Current Prompt ***
        const contents = [...chatHistory, { role: "user", parts: [{ text: prompt }] }];

        // System Prompt with conciseness constraint
        const systemPrompt = `You are AnuragBot, the official and highly professional AI assistant for Anurag University in Telangana, India. **PRIORITIZE CONCISENESS:** Ensure all responses are brief, direct, and limited to only the essential facts. Respond in a very polite, friendly, and human-like conversational tone, avoiding technical jargon where possible. Your primary goal is to provide accurate, up-to-date, and concise information to parents, students, and visitors regarding the university. Use Google Search grounding to verify all facts, especially for admissions, academic programs, and current events related to "Anurag University". IMPORTANT: If the user asks a question that is NOT related to Anurag University (e.g., general knowledge, other universities, politics), you MUST politely decline the request by saying something like: "I apologize, but I am trained specifically to assist with queries related to Anurag University. Can I help you with information about our admissions, courses, or campus life?". You must use the existing conversation history to maintain context and answer follow-up questions. ALWAYS respond entirely in the requested language, which is: ${language}.`;


        const payload = {
            // *** MEMORY STEP 2: Send the complete contents array (history + new message) ***
            contents: contents, 
            tools: [{ "google_search": {} }],
            systemInstruction: {
                parts: [{ text: systemPrompt }]
            },
        };

        const maxRetries = 5;
        let delay = 1000;

        for (let i = 0; i < maxRetries; i++) {
            try {
                const response = await fetch(`${API_URL}?key=${API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    if (response.status === 429 && i < maxRetries - 1) {
                        await new Promise(resolve => setTimeout(resolve, delay));
                        delay *= 2;
                        continue;
                    }
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const result = await response.json();
                const candidate = result.candidates?.[0];

                if (candidate && candidate.content?.parts?.[0]?.text) {
                    const text = candidate.content.parts[0].text;
                    let sources = [];
                    const groundingMetadata = candidate.groundingMetadata;

                    if (groundingMetadata && groundingMetadata.groundingAttributions) {
                        sources = groundingMetadata.groundingAttributions
                            .map(attribution => ({
                                uri: attribution.web?.uri,
                                title: attribution.web?.title,
                            }))
                            .filter(source => source.uri && source.title);
                    }

                    return { text, sources };

                } else {
                     return { text: "I couldn't generate a text response based on that query. Please try rephrasing.", sources: [] };
                }

            } catch (error) {
                console.error("Gemini API call failed:", error);
                return { text: "Sorry, I'm having trouble connecting right now. Please try again in a moment.", sources: [] };
            }
        }
        return { text: "Max retries reached. The API service is currently unavailable.", sources: [] };
    }

    // --- Event Listener ---

    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (isTyping) return;

        const userText = userInput.value.trim();
        if (userText === '') return;

        const selectedLanguage = languageSelect.value;

        addMessage(userText, 'user');
        userInput.value = '';

        const tempBotBubble = addMessage('', 'bot', chatLog);
        tempBotBubble.innerText = 'AnuragBot is typing...';
        scrollToBottom();

        sendButton.disabled = true;
        userInput.disabled = true;
        
        // Pass the userText to typeMessage so it can be stored in history later
        const { text, sources } = await generateResponse(userText, selectedLanguage);

        typeMessage(tempBotBubble, text, sources, userText);
    });

    languageSelect.addEventListener('change', (e) => {
        const lang = e.target.value;
        if (lang === 'Telugu') {
            initialMessage.innerText = "నమస్కారం! నేను అనురాగ్ బాట్, అనురాగ్ విశ్వవిద్యాలయానికి మీ AI గైడ్. దయచేసి పైన మీ భాషను ఎంచుకుని, ప్రవేశాలు, కార్యక్రమాలు లేదా క్యాంపస్ జీవితం గురించి ఏదైనా అడగండి!";
        } else if (lang === 'Hindi') {
            initialMessage.innerText = "नमस्ते! मैं अनुरागबॉट हूँ, अनुराग विश्वविद्यालय के लिए आपका AI सहायक। कृपया ऊपर अपनी पसंदीदा भाषा चुनें, और मुझसे प्रवेश, कार्यक्रमों, या कैंपस जीवन के बारे में कुछ भी पूछें!";
        } else {
            initialMessage.innerText = "Hello! I am AnuragBot, your AI guide for Anurag University. Please select your preferred language above, and ask me anything about admissions, programs, or campus life!";
        }
        // Clear history when language changes to prevent language confusion in the model
        chatHistory = []; 
        scrollToBottom();
    });
    
    // Clear history on initial load for a fresh start
    chatHistory = [];
    scrollToBottom();
});
